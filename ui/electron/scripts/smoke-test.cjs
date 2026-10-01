#!/usr/bin/env node
/**
 * UI smoke tests against the built renderer in a real, isolated Electron window.
 * No application main process, Bluetooth connection, Python process, or real
 * settings file is used. Fixture APIs exist only in the generated test preload.
 *
 * npm run build
 * npm run test:ui
 * Optional: AXLE_AUDIT_DIR=/path/to/screenshots ELECTRON_EXECUTABLE=/path/to/electron
 */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { _electron: electron } = require("playwright-core");
const project = path.resolve(__dirname, "..");
const renderer = path.join(project, "dist/renderer/index.html");
const output = process.env.AXLE_AUDIT_DIR || (process.platform === "darwin" ? "/private/tmp/axle-ui-audit" : path.join(os.tmpdir(), "axle-ui-audit"));
const executablePath = process.env.ELECTRON_EXECUTABLE || require(require.resolve("electron", { paths: [project] }));
const runtimeErrors = [];
const screenshots = [];
const checks = [];
let activeApp;
let activePage;
let temporary;

// Stringifying this function keeps fixture JavaScript standalone and editable.
function fixturePreload() {
  const { contextBridge } = require("electron");
  const scenario = process.argv.find((arg) => arg.startsWith("--axle-fixture="))?.split("=")[1] || "normal";
  const callbacks = { status: new Set(), event: new Set(), log: new Set() };
  const options = { bootstrapFailure: scenario.startsWith("bootstrap-failure"), profileFailure: scenario === "profile-failure", settingsFailure: false, startFailure: false, stopFailure: false };
  const calls = [];
  let status = scenario === "reload-live-slow-profiles" || scenario === "bootstrap-failure-live"
    ? { status: "running", operation: "live", sessionId: "existing-fixture-session" }
    : { status: "idle" };
  let settings = { launchFullscreen: false };
  let session = 0;
  let telemetryTimer;
  let wheelPosition = 0;
  let wheelSampledAt = performance.now();
  let wheelRate = 0;
  const profiles = {
    models: [{ id: "42124", name: "42124 Off-road Buggy" }, { id: "42160", name: "42160 Rally Car" }, { id: "tumbler", name: "42239 Batmobile Tumbler" }],
    gamepads: [{ id: "auto", name: "Automatic" }, { id: "dualsense", name: "DualSense" }, { id: "xbox", name: "Xbox controller" }],
    defaults: { model: "42124", gamepad: "auto", hubName: "Technic Move" }
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const publishStatus = (patch) => {
    status = { ...status, ...patch };
    for (const callback of callbacks.status) callback(status);
  };
  const publishEvent = (patch) => {
    const event = { protocol: "lego-technic-bridge", version: 1, timestamp: new Date().toISOString(), ...patch };
    for (const callback of callbacks.event) callback(event);
  };
  const publishTelemetry = (patch = {}) => {
    const now = performance.now();
    wheelPosition += wheelRate * (now - wheelSampledAt) / 1_000;
    wheelSampledAt = now;
    const { measured_wheel_rate, ...values } = patch;
    if (typeof measured_wheel_rate === "number") wheelRate = measured_wheel_rate;
    const wheel_motion = values.model_name === "42239 Batmobile Tumbler" ? {
      source: "encoder", session: "fixture-drive", position_radians: wheelPosition,
      sample_time: now / 1_000, sample_age_ms: 0
    } : null;
    publishEvent({ type: "telemetry", telemetry: {
      kind: "vehicle", model_name: "Off-road Buggy", speed: 0, steering: 0, battery: 87, wheel_motion, ...values
    } });
  };
  const subscribe = (kind, callback) => {
    callbacks[kind].add(callback);
    return () => callbacks[kind].delete(callback);
  };
  const begin = async (operation, payload) => {
    calls.push({ method: operation === "live" ? "startBridge" : operation === "discover" ? "discoverHardware" : "runBridgeCommand", payload });
    if (options.startFailure) throw new Error("Bluetooth permission denied");
    status = { status: "starting", operation, sessionId: `fixture-${++session}`, startedAt: new Date().toISOString() };
    publishStatus({});
    await delay(35);
    publishStatus({ status: "running" });
    return { ok: true, sessionId: status.sessionId };
  };
  contextBridge.exposeInMainWorld("legoBridgeUi", {
    discoverHardware: () => begin("discover"),
    quitApp: async () => { calls.push({ method: "quitApp" }); return { ok: false, message: "Fixture retains window for exit testing" }; },
    getBootstrapState: async () => {
      if (options.bootstrapFailure) throw new Error("Fixture bootstrap failed");
      return { appName: "Axle", appVersion: "0.1.0", platform: process.platform, arch: process.arch, electronVersion: process.versions.electron, chromiumVersion: process.versions.chrome, nodeVersion: process.versions.node, buildTargets: [], runtimeItems: [] };
    },
    getSettings: async () => settings,
    updateSettings: async (patch) => {
      calls.push({ method: "updateSettings", payload: patch });
      if (options.settingsFailure) throw new Error("Fixture settings write failed");
      settings = { ...settings, ...patch };
      return settings;
    },
    getBridgeProfiles: async () => {
      if (scenario === "reload-live-slow-profiles") await delay(2500);
      if (options.profileFailure) throw new Error("Fixture profile loading failed");
      return profiles;
    },
    getBridgeStatus: async () => status,
    startBridge: (payload) => begin("live", payload),
    runBridgeCommand: (payload) => begin(payload.kind, payload),
    stopBridge: async () => {
      calls.push({ method: "stopBridge" });
      if (options.stopFailure) throw new Error("Fixture stop failed");
      publishStatus({ status: "stopping" });
      await delay(35);
      publishStatus({ status: "exited", exitCode: 0, endedAt: new Date().toISOString() });
      return { ok: true };
    },
    onBridgeLog: (callback) => subscribe("log", callback),
    onBridgeStatus: (callback) => subscribe("status", callback),
    onBridgeEvent: (callback) => subscribe("event", callback)
  });
  contextBridge.exposeInMainWorld("__AXLE_TEST__", {
    configure: (patch) => Object.assign(options, patch),
    calls: () => calls,
    snapshot: () => status,
    status: publishStatus,
    event: publishEvent,
    log: (message) => {
      const event = { id: Date.now(), timestamp: new Date().toISOString(), source: "system", message, operation: status.operation, sessionId: status.sessionId };
      for (const callback of callbacks.log) callback(event);
    },
    setup: ({ controller = true, vehicle = true, ready = true, bluetooth = true } = {}) => publishEvent({
      type: "setup/progress", stage: ready ? "ready" : controller ? "waiting_for_hub" : "waiting_for_gamepad_and_hub", title: "Fixture connection", message: "Fixture connection progress",
      steps: [
        { label: "Bluetooth enabled", done: bluetooth },
        { label: "Gamepad controller detected", done: controller },
        { label: "Technic Move hub connected", done: vehicle },
        { label: "Live drive session ready", done: ready }
      ]
    }),
    telemetry: publishTelemetry,
    telemetryStream: (patch) => {
      clearInterval(telemetryTimer);
      publishTelemetry(patch);
      telemetryTimer = setInterval(() => publishTelemetry(patch), 100);
    },
    stopTelemetry: () => clearInterval(telemetryTimer),
    complete: (command, payload) => {
      publishEvent({ type: "command/result", command, ok: true, payload });
      publishStatus({ status: "exited", exitCode: 0 });
    }
  });
}

function fixtureMain() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.env.AXLE_SMOKE_USER_DATA);
  app.whenReady().then(() => {
    const window = new BrowserWindow({
      width: 1280, height: 800, useContentSize: true, show: true,
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      backgroundColor: "#F5F3ED",
      webPreferences: { preload: process.env.AXLE_SMOKE_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: [`--axle-fixture=${process.env.AXLE_SMOKE_SCENARIO || "normal"}`] }
    });
    window.loadFile(process.env.AXLE_SMOKE_RENDERER);
  });
  app.on("window-all-closed", () => app.quit());
}

async function launch(scenario = "normal") {
  if (activeApp) await activeApp.close();
  activeApp = await electron.launch({
    executablePath,
    // The isolated fixture can use software WebGL on CI without changing the
    // shipping application's GPU policy or requiring a display GPU.
    args: ["--enable-unsafe-swiftshader", path.join(temporary, "main.cjs")],
    env: { ...process.env, AXLE_SMOKE_USER_DATA: path.join(temporary, `user-data-${scenario}`), AXLE_SMOKE_PRELOAD: path.join(temporary, "preload.cjs"), AXLE_SMOKE_RENDERER: renderer, AXLE_SMOKE_SCENARIO: scenario }
  });
  const page = await activeApp.firstWindow();
  activePage = page;
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => runtimeErrors.push({ scenario, type: "pageerror", message: error.message }));
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push({ scenario, type: "console", message: message.text() }); });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.__AXLE_TEST__));
  return page;
}

async function screenshot(name) {
  const file = path.join(output, `${name}.png`);
  await activePage.screenshot({ path: file, fullPage: true });
  screenshots.push(file);
}

async function checkpoint(name, callback) {
  await callback();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

async function visible(locator) { await locator.waitFor({ state: "visible" }); }
async function fixture(method, payload) { return activePage.evaluate(({ method, payload }) => window.__AXLE_TEST__[method](payload), { method, payload }); }
async function resize(width, height) {
  await activeApp.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await activePage.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, { width, height });
}
async function noHorizontalOverflow() {
  const dimensions = await activePage.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1, `Horizontal overflow: ${JSON.stringify(dimensions)}`);
}
async function settingsDialog() {
  await activePage.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = activePage.getByRole("dialog");
  await visible(dialog);
  return dialog;
}
async function assertFocusInsideDialog() {
  assert.equal(await activePage.evaluate(() => document.querySelector("dialog[open]")?.contains(document.activeElement)), true, "Keyboard focus must remain inside the modal");
}
function tumblerFeedback(patch = {}) {
  return {
    model_name: "42239 Batmobile Tumbler", max_drive: 100, max_steering: 100,
    throttle: 0, steering: 0, front_lights_on: false, rocket_lights_on: false,
    flicker: false, boost: false, brake: false, crash: false,
    measured_wheel_rate: 0,
    ...patch
  };
}
async function tumblerTelemetry(patch = {}) { await fixture("telemetry", tumblerFeedback(patch)); }
async function streamTumblerTelemetry(patch = {}) { await fixture("telemetryStream", tumblerFeedback(patch)); }
async function canvasValue(attribute) {
  return Number(await activePage.getByLabel("Interactive Tumbler model", { exact: true }).getAttribute(attribute));
}
async function cameraPosition() {
  const position = await activePage.getByLabel("Interactive Tumbler model", { exact: true }).getAttribute("data-camera-position");
  const coordinates = position?.split(",").map(Number);
  assert.ok(coordinates?.length === 3 && coordinates.every(Number.isFinite), `Expected real camera coordinates, received ${position}`);
  return coordinates;
}
function positionDistance(first, second) {
  return Math.hypot(...first.map((value, index) => value - second[index]));
}
async function cameraSettled() {
  await activePage.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-camera-moving") === "false");
}

async function run() {
  await fs.access(renderer).catch(() => { throw new Error("Built renderer is missing. Run npm run build in ui/electron first."); });
  await fs.mkdir(output, { recursive: true });
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axle-smoke-"));
  await fs.writeFile(path.join(temporary, "main.cjs"), `(${fixtureMain.toString()})();\n`);
  await fs.writeFile(path.join(temporary, "preload.cjs"), `(${fixturePreload.toString()})();\n`);
  let page = await launch();

  await checkpoint("Startup owns connection without flow buttons", async () => {
    await page.waitForFunction(() => window.__AXLE_TEST__.snapshot().status === "running");
    const calls = await fixture("calls");
    assert.deepEqual(calls.filter((call) => call.method === "startBridge").map((call) => call.payload),
      [{ modelId: "tumbler", gamepadId: "auto", hubName: "Technic Move", hubAddress: "" }]);
    assert.equal(calls.filter((call) => call.method === "discoverHardware").length, 0);
    assert.equal(await page.getByRole("button", { name: /connect vehicle|start driving|start engine|stop searching|stop driving/i }).count(), 0);
    assert.equal(await page.getByLabel("Vehicle model", { exact: true }).isEnabled(), true);
    assert.equal(await page.getByLabel("Vehicle model", { exact: true }).locator("option").count(), 1);
    await noHorizontalOverflow();
    await screenshot("01-automatic-startup");
  });
  await checkpoint("Live readiness and lost devices require fresh feedback", async () => {
    await fixture("setup");
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-live"), "false");
    await streamTumblerTelemetry({ throttle: 30, measured_wheel_rate: 4 });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "true");
    assert.equal(await page.getByLabel("Vehicle model", { exact: true }).isEnabled(), true);
    await fixture("stopTelemetry");
    await fixture("setup", { controller: false, vehicle: true, ready: false });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "false");
    await fixture("setup");
    await streamTumblerTelemetry();
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "true");
    assert.equal((await fixture("calls")).filter((call) => call.method === "startBridge").length, 1);
  });
  await checkpoint("Changing controller safely hands over the active session", async () => {
    const dialog = await settingsDialog();
    await assertFocusInsideDialog();
    await dialog.getByLabel("Controller profile").selectOption("dualsense");
    await page.waitForFunction(() => window.__AXLE_TEST__.calls().filter((call) => call.method === "startBridge").length === 2);
    const calls = await fixture("calls");
    assert.deepEqual(calls.filter((call) => ["startBridge", "stopBridge"].includes(call.method)).map((call) => call.method), ["startBridge", "stopBridge", "startBridge"]);
    assert.equal(calls.filter((call) => call.method === "startBridge").at(-1).payload.gamepadId, "dualsense");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).evaluate((element) => getComputedStyle(element).outlineColor), "rgb(82, 106, 88)");
  });
  await checkpoint("Exited workers restart automatically", async () => {
    await page.waitForFunction(() => window.__AXLE_TEST__.snapshot().status === "running");
    await fixture("stopTelemetry");
    await fixture("status", { status: "exited", exitCode: 1 });
    await page.waitForFunction(() => window.__AXLE_TEST__.calls().filter((call) => call.method === "startBridge").length === 3);
    await page.waitForFunction(() => window.__AXLE_TEST__.snapshot().status === "running");
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-live"), "false");
  });
  await checkpoint("Renderer reload adopts an existing live session", async () => {
    page = await launch("reload-live-slow-profiles");
    await visible(page.getByLabel("Vehicle model", { exact: true }));
    await page.waitForTimeout(700);
    assert.equal((await fixture("calls")).filter((call) => call.method === "startBridge").length, 0);
  });
  await checkpoint("Bootstrap and profile errors recover into automatic startup", async () => {
    for (const scenario of ["bootstrap-failure", "profile-failure"]) {
      page = await launch(scenario);
      await visible(page.getByRole("button", { name: "Try again", exact: true }));
      await fixture("configure", { bootstrapFailure: false, profileFailure: false });
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.waitForFunction(() => window.__AXLE_TEST__.snapshot().status === "running");
    }
  });

  await checkpoint("Developer checks pause automatic retries and returning to Drive resumes control", async () => {
    const dialog = await settingsDialog();
    await dialog.getByRole("switch", { name: /Developer mode/ }).check();
    await dialog.getByRole("button", { name: /Open diagnostics/ }).click();
    await page.getByRole("button", { name: "Stop session", exact: true }).click();
    await page.getByRole("button", { name: /Test controller input/ }).click();
    await page.waitForFunction(() => window.__AXLE_TEST__.snapshot().operation === "probeGamepad" && window.__AXLE_TEST__.snapshot().status === "running");
    await page.getByRole("button", { name: "Drive", exact: true }).click();
    await page.waitForFunction(() => window.__AXLE_TEST__.snapshot().operation === "live" && window.__AXLE_TEST__.snapshot().status === "running");
    assert.equal((await fixture("calls")).filter((call) => call.method === "runBridgeCommand").length, 1);
  });

  await checkpoint("Tumbler renders real 3D and keeps camera controls reachable", async () => {
    page = await launch("tumbler");
    await visible(page.getByLabel("Vehicle model", { exact: true }));
    await page.getByLabel("Vehicle model", { exact: true }).selectOption("tumbler");
    const canvas = page.getByLabel("Interactive Tumbler model", { exact: true });
    await visible(canvas);
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-rendered-frames")) > 0);
    await page.getByRole("button", { name: "Overview", exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector(".tumbler-viewer button")?.disabled);
    const canvasBounds = await canvas.boundingBox();
    assert.ok(canvasBounds && canvasBounds.width > 250 && canvasBounds.height > 150, `The model needs a usable rendering area: ${JSON.stringify(canvasBounds)}`);
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-live"), "false");
    assert.equal(await page.getByLabel("Follow active part", { exact: true }).isChecked(), true, "Smooth automatic camera must be enabled by default");
    await cameraSettled();
    const overviewPosition = await cameraPosition();
    for (const [name, view] of [["Steering", "steering"], ["Rear drive", "drive"], ["Reverse", "reverse"], ["Lights", "lights"], ["Attack", "attack"], ["Boost", "boost"], ["Overview", "overview"]]) {
      const before = await cameraPosition();
      await page.getByRole("button", { name, exact: true }).click();
      await page.waitForFunction((view) => document.querySelector(".tumbler-viewer")?.getAttribute("data-camera-view") === view, view);
      await cameraSettled();
      assert.ok(positionDistance(before, await cameraPosition()) > 0.1, `${name} must move the rendered camera, not only its selected label`);
    }
    const beforeOrbit = await cameraPosition();
    await canvas.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction((before) => {
      const after = document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-camera-position")?.split(",").map(Number);
      return after?.length === 3 && Math.hypot(...after.map((value, index) => value - before[index])) > 0.1;
    }, beforeOrbit);
    assert.equal(await page.getByLabel("Follow active part", { exact: true }).isChecked(), false, "Manual keyboard orbit must pause automatic camera control");
    await page.keyboard.press("Home");
    await cameraSettled();
    assert.ok(positionDistance(overviewPosition, await cameraPosition()) < 0.05, "Home must restore the overview camera");
    await canvas.evaluate((element) => element.blur());
    await page.waitForTimeout(250);
    const idleFrames = await canvasValue("data-rendered-frames");
    await page.waitForTimeout(250);
    assert.ok(await canvasValue("data-rendered-frames") <= idleFrames + 2, "An idle detailed model must not redraw continuously");
    await noHorizontalOverflow();
    await screenshot("20-tumbler-overview-1280x800");
    await resize(760, 600);
    await canvas.scrollIntoViewIfNeeded();
    await cameraSettled();
    await noHorizontalOverflow();
    const exit = page.getByRole("button", { name: "Quit Axle", exact: true });
    await exit.scrollIntoViewIfNeeded();
    assert.equal(await exit.isEnabled(), true);
    await screenshot("21-tumbler-760x600");
    await resize(1280, 800);
    await canvas.scrollIntoViewIfNeeded();
    await cameraSettled();
  });

  await checkpoint("Live Tumbler steering updates pose and reveals a hidden active part", async () => {
    await page.waitForFunction(() => window.__AXLE_TEST__.snapshot().status === "running");
    await fixture("setup");
    await streamTumblerTelemetry({ steering: 25, front_lights_on: true });
    await visible(page.getByText("Live wheel feedback", { exact: true }));
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "true");
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-steering")) < -0.01);
    const rightSteering = await canvasValue("data-steering");
    const follow = page.getByLabel("Follow active part", { exact: true });
    await follow.uncheck();
    await page.getByRole("button", { name: "Rear drive", exact: true }).click();
    await cameraSettled();
    const rearPosition = await cameraPosition();
    await streamTumblerTelemetry({ steering: -50 });
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-steering")) > 0.01);
    assert.ok(rightSteering < 0 && (await canvasValue("data-steering")) > 0, "Right/left controller input must turn the actual wheel pivots toward the driver's right/left");
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-camera-view"), "drive", "Manual view must be retained while follow is off");
    await follow.check();
    await streamTumblerTelemetry({ steering: -50 });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-camera-view") === "steering");
    await cameraSettled();
    assert.ok(positionDistance(rearPosition, await cameraPosition()) > 1, "Following a hidden front wheel must move the actual rear camera to the front");
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-active-part"), "steering");
    await screenshot("22-tumbler-live-steering");
  });

  await checkpoint("Tumbler reverse green lights are independent of headlights and orange boost", async () => {
    await streamTumblerTelemetry({ front_lights_on: true, rocket_lights_on: true, flicker: true });
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".tumbler-viewer canvas");
      return Number(canvas?.getAttribute("data-front-light-intensity")) > 1
        && Number(canvas?.getAttribute("data-attack-light-intensity")) > 1
        && Number(canvas?.getAttribute("data-boost-intensity")) < 0.1
        && canvas?.getAttribute("data-reverse-light-intensities")?.split(",").every((value) => Number(value) > 1);
    });
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-active-part"), "attack");
    await streamTumblerTelemetry({ throttle: 60, brake: true });
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".tumbler-viewer canvas");
      return canvas?.getAttribute("data-braking") === "true"
        && Number(canvas?.getAttribute("data-front-light-intensity")) < 0.1
        && Number(canvas?.getAttribute("data-attack-light-intensity")) < 0.1;
    });
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-active-part"), "drive");
    const brakedRotation = await canvasValue("data-wheel-rotation");
    await page.waitForTimeout(200);
    assert.equal(await canvasValue("data-wheel-rotation"), brakedRotation, "Brake feedback must suppress wheel rotation even when throttle remains pressed");
  });

  await checkpoint("Attack alone flickers all three green assemblies and returns to resolved reverse lighting", async () => {
    async function sampleGreenLights() {
      return page.locator(".tumbler-viewer canvas").evaluate(async (canvas) => {
        const samples = [];
        const started = performance.now();
        while (performance.now() - started < 500) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          samples.push(canvas.dataset.reverseLightIntensities.split(",").map(Number));
        }
        return samples;
      });
    }
    function assertFlicker(samples) {
      assert.ok(samples.every((values) => values.length >= 6 && values.every((value) => value === values[0])),
        "The green cones and clear bars in all three optical assemblies must flicker together");
      assert.ok(samples.some((values) => values.every((value) => value > 1)), "Attack must illuminate green lamps without reverse");
      assert.ok(samples.some((values) => values.every((value) => value < 0.1)), "Attack must also produce dark frames");
    }
    await streamTumblerTelemetry({ flicker: true, rocket_lights_on: false, front_lights_on: false });
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-attack-light-intensity")) > 1);
    assertFlicker(await sampleGreenLights());
    assert.ok(await canvasValue("data-boost-intensity") < 0.1, "Attack alone must leave the orange boost lens dark");

    // Simultaneous reverse lighting must not mask the Attack dark phases.
    await streamTumblerTelemetry({ throttle: -40, flicker: true, rocket_lights_on: true });
    assertFlicker(await sampleGreenLights());
    await streamTumblerTelemetry({ throttle: -40, flicker: false, rocket_lights_on: true });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-reverse-light-intensities")?.split(",").every((value) => Number(value) > 1));
    assert.ok((await sampleGreenLights()).every((values) => values.every((value) => value > 1)),
      "After Attack, the current reverse on-phase must remain steadily lit");
    await streamTumblerTelemetry({ throttle: -40, flicker: false, rocket_lights_on: false });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-reverse-light-intensities")?.split(",").every((value) => Number(value) < 0.1));

    await page.emulateMedia({ reducedMotion: "reduce" });
    await streamTumblerTelemetry({ flicker: true });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-reverse-light-intensities")?.split(",").every((value) => Number(value) > 1));
    assert.ok((await sampleGreenLights()).every((values) => values.every((value) => value > 1)),
      "Reduced motion must show Attack illumination without strobing");
    await screenshot("23-tumbler-attack-green-flicker");
    await streamTumblerTelemetry({ flicker: false });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-reverse-light-intensities")?.split(",").every((value) => Number(value) < 0.1));
    await page.emulateMedia({ reducedMotion: "no-preference" });

    await streamTumblerTelemetry({ flicker: true, rocket_lights_on: true, crash: true });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-reverse-light-intensities")?.split(",").every((value) => Number(value) < 0.1));
    assert.ok((await sampleGreenLights()).every((values) => values.every((value) => value < 0.1)),
      "Impact lockout must suppress Attack and reverse illumination together");
  });

  await checkpoint("Wheel rotation follows measured rates, stalls and coasting instead of guessed drive power", async () => {
    async function sampledRate(patch, expected) {
      await streamTumblerTelemetry({ ...patch, measured_wheel_rate: expected });
      await page.waitForFunction((rate) => Math.abs(Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-wheel-angular-velocity")) - rate) < 0.001, expected);
      const sample = () => page.locator(".tumbler-viewer canvas").evaluate((canvas) => ({
        angle: Number(canvas.getAttribute("data-wheel-rotation")), time: Number(canvas.getAttribute("data-wheel-sampled-at"))
      }));
      const start = await sample();
      await page.waitForFunction((time) => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-wheel-sampled-at")) - time >= 400, start.time);
      const end = await sample();
      const rate = (end.angle - start.angle) / ((end.time - start.time) / 1_000);
      assert.ok(Math.abs(rate - expected) < 0.1, `Rendered wheel rate ${rate} must track measured rate ${expected}`);
      return rate;
    }
    await sampledRate({ throttle: 80, trigger_pressure: 0.8, speed_mode: 3 }, 8);
    await sampledRate({ throttle: 80, trigger_pressure: 0.8, speed_mode: 3, boost: true }, 12);
    await sampledRate({ throttle: 0 }, 2.5);
    await sampledRate({ throttle: -40, reverse_pressure: 0.4, speed_mode: 3 }, -6);
    await streamTumblerTelemetry({ throttle: 100, forward_pressure: 1, trigger_pressure: 1, speed_mode: 3, measured_wheel_rate: 0 });
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-wheel-angular-velocity")) === 0);
    const stopped = await canvasValue("data-wheel-rotation");
    await page.waitForTimeout(200);
    assert.equal(await canvasValue("data-wheel-rotation"), stopped, "A stalled encoder must stop animation despite full drive power");
    await streamTumblerTelemetry({ throttle: 100, measured_wheel_rate: 12, wheel_motion: null });
    await page.waitForTimeout(250);
    assert.equal(await canvasValue("data-wheel-rotation"), stopped, "Missing encoders must never substitute guessed drive speed");
  });

  await checkpoint("Reverse camera remains steady through green-lamp blink phases", async () => {
    await page.getByLabel("Follow active part", { exact: true }).check();
    await streamTumblerTelemetry({ throttle: -60, steering: 30, rocket_lights_on: true, measured_wheel_rate: -6 });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-camera-view") === "reverse");
    await cameraSettled();
    const reversePosition = await cameraPosition();
    const initialRotation = await canvasValue("data-wheel-rotation");
    assert.ok(await canvasValue("data-front-light-intensity") < 0.1, "Reverse alone must not fabricate white headlights");
    assert.ok(await canvasValue("data-boost-intensity") < 0.1, "Reverse alone must not illuminate the orange lens");
    const intensities = (await page.locator(".tumbler-viewer canvas").getAttribute("data-reverse-light-intensities")).split(",").map(Number);
    assert.ok(intensities.length >= 3 && intensities.every((value) => value > 1), "All three green assemblies must illuminate");
    await screenshot("25-tumbler-reverse-green-lights");
    const reversePreview = path.join(output, "25-tumbler-reverse-model.png");
    await page.locator(".tumbler-viewer__stage").screenshot({ path: reversePreview });
    screenshots.push(reversePreview);
    for (const phase of [false, true, false]) {
      await streamTumblerTelemetry({ throttle: -60, steering: 30, rocket_lights_on: phase, measured_wheel_rate: -6 });
      await page.waitForFunction((on) => document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-reverse-light-intensities")?.split(",").every((value) => on ? Number(value) > 1 : Number(value) < 0.1), phase);
      assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-camera-view"), "reverse");
      assert.ok(positionDistance(reversePosition, await cameraPosition()) < 0.05, "Blink edges must not move the camera");
      await page.waitForTimeout(1_000);
      assert.ok(positionDistance(reversePosition, await cameraPosition()) < 0.05, "The one-second blink interval must retain the reverse composition");
    }
    await streamTumblerTelemetry({ throttle: -1, steering: 30, rocket_lights_on: false, boost: true, flicker: true, measured_wheel_rate: -0.2 });
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-wheel-angular-velocity")) < 0);
    await cameraSettled();
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-camera-view"), "reverse", "Gentle reverse and concurrent effects must retain the rear green light's composition");
    await streamTumblerTelemetry({ throttle: -1, steering: 100, rocket_lights_on: true, boost: true, flicker: true, measured_wheel_rate: -0.2 });
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-steering")) < -0.4);
    await cameraSettled();
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-camera-view"), "reverse", "Full steering must also keep the reversing signal's view");
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-reverse-light-intensities")?.split(",").every((value) => Number(value) > 1));
    assert.ok(await canvasValue("data-wheel-rotation") < initialRotation, "Reverse feedback must roll the wheels backward");
  });

  await checkpoint("Combined controls smoothly retarget a single cinematic camera", async () => {
    assert.equal(await page.getByLabel("Follow active part", { exact: true }).isChecked(), true);
    await page.evaluate(() => {
      window.__AXLE_CAMERA_SAMPLES__ = [];
      window.__AXLE_CAMERA_SAMPLING__ = true;
      let lastFrame;
      function sample() {
        const canvas = document.querySelector(".tumbler-viewer canvas");
        const frame = canvas?.getAttribute("data-rendered-frames");
        if (frame !== lastFrame) {
          lastFrame = frame;
          window.__AXLE_CAMERA_SAMPLES__.push({
            position: canvas?.getAttribute("data-camera-position")?.split(",").map(Number),
            target: canvas?.getAttribute("data-camera-target")?.split(",").map(Number)
          });
        }
        if (window.__AXLE_CAMERA_SAMPLING__) requestAnimationFrame(sample);
      }
      sample();
    });
    await streamTumblerTelemetry({ throttle: 60, steering: 40, boost: true });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-camera-view") === "boost");
    assert.equal(await page.locator(".tumbler-viewer canvas").getAttribute("data-camera-moving"), "true");
    // Retarget while still moving: front attack and rear boost need one broad
    // composition, while driving and steering continue simultaneously.
    await streamTumblerTelemetry({ throttle: 60, steering: 40, boost: true, flicker: true });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-camera-view") === "combined");
    await cameraSettled();
    const combinedPosition = await cameraPosition();
    assert.ok(await canvasValue("data-boost-intensity") > 1);
    assert.ok(await canvasValue("data-front-light-intensity") > 1);
    assert.ok(await canvasValue("data-steering") < 0);
    const samples = await page.evaluate(() => { window.__AXLE_CAMERA_SAMPLING__ = false; return window.__AXLE_CAMERA_SAMPLES__; });
    assert.ok(samples.length > 8, "The actual rendered camera must travel through intermediate positions");
    for (let index = 0; index < samples.length; index++) {
      assert.ok(positionDistance(samples[index].position, samples[index].target) >= 4.45, "Camera transitions must stay outside the chassis");
      assert.ok(samples[index].position[1] > 0.5, "Camera must remain above the floor");
      if (index) assert.ok(positionDistance(samples[index].position, samples[index - 1].position) < 2, "Retargeting must not jump between shots");
    }
    await page.waitForTimeout(450);
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-camera-view"), "combined", "Simultaneous controls must not cycle between individual parts");
    assert.ok(positionDistance(combinedPosition, await cameraPosition()) < 0.05);
    await screenshot("26-tumbler-combined-controls");
    const combinedPreview = path.join(output, "26-tumbler-combined-model.png");
    await page.locator(".tumbler-viewer__stage").screenshot({ path: combinedPreview });
    screenshots.push(combinedPreview);
  });

  await checkpoint("Tumbler drive animation stops when feedback becomes stale", async () => {
    await streamTumblerTelemetry({ throttle: 60, measured_wheel_rate: 8 });
    const initialRotation = await canvasValue("data-wheel-rotation");
    await page.waitForFunction((before) => Math.abs(Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-wheel-rotation")) - before) > 0.05, initialRotation);
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-active-part"), "drive");
    await streamTumblerTelemetry({ throttle: 60, boost: true, rocket_lights_on: true, flicker: true, measured_wheel_rate: 12 });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-active-part") === "attack");
    await page.getByRole("button", { name: "Boost", exact: true }).click();
    await cameraSettled();
    await screenshot("23-tumbler-live-boost");
    await fixture("stopTelemetry");
    await visible(page.getByText("Waiting for wheel feedback", { exact: true }));
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-live"), "true", "Encoder expiry must occur before the longer control-feedback timeout");
    assert.equal(await canvasValue("data-wheel-angular-velocity"), 0, "Silent encoders must stop immediately without extrapolating drive power");
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "false");
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-wheel-angular-velocity")) === 0);
    const staleRotation = await canvasValue("data-wheel-rotation");
    await page.waitForTimeout(200);
    assert.equal(await canvasValue("data-wheel-rotation"), staleRotation, "Lost telemetry must not keep showing a moving car");
    assert.ok(await canvasValue("data-boost-intensity") < 0.1);
    const staleReverse = (await page.locator(".tumbler-viewer canvas").getAttribute("data-reverse-light-intensities")).split(",").map(Number);
    assert.ok(staleReverse.every((value) => value < 0.1), "Stale feedback must also turn green reverse lamps off");
  });

  await checkpoint("Reduced motion retains live pose without revolving wheels or automatic camera", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await visible(page.getByText("Automatic views paused for reduced motion.", { exact: true }));
    assert.equal(await page.getByLabel("Follow active part", { exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Rear drive", exact: true }).click();
    const stillRotation = await canvasValue("data-wheel-rotation");
    await streamTumblerTelemetry({ steering: 30, throttle: 60, measured_wheel_rate: 8 });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "true");
    await page.waitForTimeout(200);
    assert.equal(await canvasValue("data-wheel-rotation"), stillRotation, "Reduced motion must suppress revolving wheel animation");
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-camera-view"), "drive", "Reduced motion must retain the manually chosen camera view");
    assert.ok((await canvasValue("data-steering")) < 0, "Reduced motion must retain the correctly directed steering pose");
    await screenshot("24-tumbler-reduced-motion");
    await page.emulateMedia({ reducedMotion: "no-preference" });
  });

  await checkpoint("New automatic sessions reject stale and other-model feedback", async () => {
    await fixture("stopTelemetry");
    await fixture("status", { status: "exited", exitCode: 0 });
    const count = (await fixture("calls")).filter((call) => call.method === "startBridge").length;
    await page.waitForFunction((count) => window.__AXLE_TEST__.calls().filter((call) => call.method === "startBridge").length > count, count);
    await page.waitForFunction(() => window.__AXLE_TEST__.snapshot().status === "running");
    await fixture("setup");
    await tumblerTelemetry({ model_name: "42160 Rally Car", steering: 80, throttle: 90 });
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-live"), "false");
    await streamTumblerTelemetry({ front_lights_on: true });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "true");
    assert.equal(await page.getByLabel("Vehicle model", { exact: true }).isEnabled(), true);
  });
  await checkpoint("Touch exit stays reachable on Steam Deck and reports cleanup failure", async () => {
    await resize(1280, 800);
    const exit = page.getByRole("button", { name: "Quit Axle", exact: true });
    const bounds = await exit.boundingBox();
    assert.ok(bounds && bounds.width >= 48 && bounds.height >= 48);
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await visible(page.getByText(/Axle could not confirm that control has stopped/));
    assert.equal(await exit.isEnabled(), true);
    assert.equal((await fixture("calls")).filter((call) => call.method === "quitApp").length, 1);
    assert.equal(await exit.evaluate((element) => getComputedStyle(element).outlineStyle), "none");
    await session.detach();
    await screenshot("27-touch-exit");
  });
  assert.deepEqual(runtimeErrors, [], "Unexpected renderer console/runtime errors");
}

(async () => {
  let failure;
  try { await run(); } catch (error) {
    failure = error;
    if (activePage && !activePage.isClosed()) {
      await screenshot("99-failure").catch(() => {});
      await fs.writeFile(path.join(output, "failure-state.json"), JSON.stringify(await activePage.evaluate(() => ({
        canvas: { ...document.querySelector(".tumbler-viewer canvas")?.dataset },
        viewer: { ...document.querySelector(".tumbler-viewer")?.dataset },
        follow: document.querySelector(".tumbler-viewer input")?.checked, hidden: document.hidden
      })), null, 2)).catch(() => {});
      await fs.writeFile(path.join(output, "failure-page.txt"), await activePage.locator("body").innerText().catch(() => "Unavailable")).catch(() => {});
    }
  } finally {
    if (activeApp) await activeApp.close().catch(() => {});
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ success: !failure, checks, screenshots, runtimeErrors, failure: failure?.stack }, null, 2));
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
  if (failure) { console.error(failure); process.exitCode = 1; }
  else process.stdout.write(`\n${checks.length} checks passed. Screenshots and report: ${output}\n`);
})();
