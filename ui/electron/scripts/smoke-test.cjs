#!/usr/bin/env node
/**
 * UI smoke tests against the built renderer in a real, isolated Electron window.
 * No application main process, Bluetooth connection, Python process, or real
 * settings file is used. Fixture APIs exist only in the generated test preload.
 *
 * npm run build
 * npm run test:ui
 * Optional: AXLE_AUDIT_DIR=/path/to/screenshots ELECTRON_EXECUTABLE=/path/to/electron
 * Headless Linux: AXLE_UI_SOFTWARE_GL=1 LIBGL_ALWAYS_SOFTWARE=1 xvfb-run npm run test:ui
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
const processLogs = [];
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
      // Native X11 borders round fractional device pixels and change the
      // content height. Layout checks need an exact CSS-sized fixture window.
      frame: process.env.AXLE_UI_SOFTWARE_GL !== "1",
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
    // Mesa llvmpipe avoids SwiftShader's input stalls with the full CAD scene.
    // Lower only the physical pixel density: CSS layout, geometry, MSAA, PCSS
    // and volumetric lighting still run through the production renderer.
    args: ["--enable-unsafe-swiftshader", ...(process.env.AXLE_UI_SOFTWARE_GL === "1"
      ? ["--use-gl=angle", "--use-angle=gl", "--ignore-gpu-blocklist", "--force-device-scale-factor=0.5"] : []),
      path.join(temporary, "main.cjs")],
    env: { ...process.env, AXLE_SMOKE_USER_DATA: path.join(temporary, `user-data-${scenario}`), AXLE_SMOKE_PRELOAD: path.join(temporary, "preload.cjs"), AXLE_SMOKE_RENDERER: renderer, AXLE_SMOKE_SCENARIO: scenario }
  });
  activeApp.process().stderr?.on("data", (chunk) => {
    processLogs.push({ scenario, message: chunk.toString().slice(-8000) });
    if (processLogs.length > 100) processLogs.shift();
  });
  const page = await activeApp.firstWindow();
  activePage = page;
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => runtimeErrors.push({ scenario, type: "pageerror", message: error.message }));
  page.on("console", (message) => {
    const text = message.text();
    const invalidGpu = message.type() === "warning" && /WebGL|shader|framebuffer/i.test(text)
      && /error|invalid|incomplete|removed|not supported/i.test(text);
    if (message.type() === "error" || invalidGpu) runtimeErrors.push({ scenario, type: "console", message: text });
  });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.__AXLE_TEST__));
  return page;
}

async function screenshot(name) {
  const file = path.join(output, `${name}.png`);
  await activePage.screenshot({ path: file, fullPage: true });
  screenshots.push(file);
}

async function stageScreenshot(file) {
  // Camera/visibility assertions precede these captures. The fixed stage can
  // be captured directly while live GPU animation continues; asking a locator
  // to wait for extra stable animation frames can stall on software drivers.
  const clip = await activePage.locator(".tumbler-viewer__stage").boundingBox();
  assert.ok(clip && clip.width > 0 && clip.height > 0, "The rendered stage must be visible for its screenshot");
  await activePage.screenshot({ path: file, clip });
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
async function openCameraMenu() {
  const menu = activePage.locator(".tumbler-viewer__toolbar");
  if (await menu.getAttribute("open") === null) await menu.locator("summary").click();
  return menu;
}
async function selectCameraView(name) {
  const menu = await openCameraMenu();
  await menu.getByRole("button", { name, exact: true }).click();
  assert.equal(await menu.getAttribute("open"), null, "Choosing a view must collapse the camera menu");
}
async function setCameraFollow(enabled) {
  const menu = await openCameraMenu();
  await menu.getByLabel("Follow active part", { exact: true }).setChecked(enabled);
  await activePage.keyboard.press("Escape");
  assert.equal(await menu.getByLabel("Follow active part", { exact: true }).isChecked(), enabled,
    "Closing the menu must retain the chosen automatic-camera preference");
}
async function setStreetScene(enabled) {
  const menu = await openCameraMenu();
  await menu.getByLabel("Street scene", { exact: true }).setChecked(enabled);
  await activePage.keyboard.press("Escape");
  await activePage.waitForFunction((enabled) => document.querySelector(".tumbler-viewer canvas")?.dataset.streetScene === String(enabled), enabled);
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
    assert.equal(await page.getByLabel("Vehicle model", { exact: true }).count(), 0);
    const dialog = await settingsDialog();
    const model = dialog.getByLabel("Vehicle model", { exact: true });
    assert.equal(await model.isEnabled(), true);
    assert.equal(await model.locator("option").count(), 1);
    await model.selectOption("tumbler");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByLabel("Vehicle model", { exact: true }).count(), 0);
    await noHorizontalOverflow();
    await screenshot("01-automatic-startup");
  });
  await checkpoint("Live readiness and lost devices require fresh feedback", async () => {
    await fixture("setup");
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-live"), "false");
    assert.equal(await page.locator(".tumbler-viewer__diagnostics").count(), 0,
      "Repeated connection and wheel-feedback notes must be absent from the normal preview");
    const footerBounds = await page.locator(".vehicle-card__bottom").boundingBox();
    assert.ok(footerBounds && footerBounds.height <= 104, "The vehicle footer must stay compact while retaining touch-sized controls");
    await streamTumblerTelemetry({ throttle: 30, measured_wheel_rate: 4 });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "true");
    assert.equal(await page.getByLabel("Vehicle model", { exact: true }).count(), 0);
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
    await visible(page.locator(".vehicle-name h2").filter({ hasText: "Batmobile Tumbler" }));
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
    await visible(page.locator(".vehicle-name h2").filter({ hasText: "Batmobile Tumbler" }));
    const canvas = page.getByLabel("Interactive Tumbler model", { exact: true });
    await visible(canvas);
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-rendered-frames")) > 0);
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.dataset.surfaceTexturesReady === "true");
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.dataset.antialias === "smaa");
    assert.ok(await canvasValue("data-multisample-count") >= 2, "The offscreen beauty render must antialias real geometry edges");
    assert.equal(await canvas.getAttribute("data-volumetric-lighting"), "true", "HDR-capable GPUs must render depth-aware participating fog");
    assert.equal(await canvas.getAttribute("data-shadow-technique"), "pcss");
    if (process.env.AXLE_UI_SOFTWARE_GL === "1") {
      assert.equal(await canvas.getAttribute("data-software-graphics"), "true", "Headless graphics must use the real CPU rendering preset");
      assert.equal(await canvas.getAttribute("data-shadow-map-size"), "512");
    }
    assert.ok(await canvasValue("data-soft-shadow-materials") > 20, "Loaded CAD and street/ground materials must receive the contact-hardening filter");
    await page.getByLabel("Camera views", { exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector(".tumbler-viewer button")?.disabled);
    const canvasBounds = await canvas.boundingBox();
    assert.ok(canvasBounds && canvasBounds.width > 250 && canvasBounds.height > 150, `The model needs a usable rendering area: ${JSON.stringify(canvasBounds)}`);
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-live"), "false");
    assert.equal(await page.getByLabel("Follow active part", { exact: true }).isChecked(), true, "Smooth automatic camera must be enabled by default");
    assert.equal(await page.getByLabel("Street scene", { exact: true }).isChecked(), false, "The optional street must be off by default");
    assert.ok(await canvasValue("data-render-triangles") < 910_000, "Night atmosphere must add only lightweight geometry");
    assert.ok(await canvasValue("data-render-calls") < 65, "The night scene must preserve a modest draw-call budget");
    const cameraMenu = page.locator(".tumbler-viewer__toolbar");
    assert.equal(await cameraMenu.getAttribute("open"), null, "Camera controls must be compact by default");
    const trigger = cameraMenu.locator("summary");
    const triggerBounds = await trigger.boundingBox();
    const viewportBounds = await page.locator(".tumbler-viewer__viewport").boundingBox();
    const nameRowBounds = await page.locator(".vehicle-name__row").boundingBox();
    const nameBounds = await page.locator(".vehicle-name h2").boundingBox();
    assert.ok(triggerBounds && viewportBounds && triggerBounds.height >= 48 && triggerBounds.width >= 48);
    assert.ok(nameRowBounds && nameBounds && Math.abs(nameRowBounds.x + nameRowBounds.width - triggerBounds.x - triggerBounds.width) < 2,
      "The compact camera control must align with the right edge of the vehicle title row");
    assert.ok(Math.abs(nameBounds.y + nameBounds.height / 2 - triggerBounds.y - triggerBounds.height / 2) < 2,
      "The camera control and vehicle name must share the same vertical center");
    assert.ok(triggerBounds.y > viewportBounds.y + viewportBounds.height,
      "The closed camera control must leave the model viewport unobstructed");
    await trigger.focus();
    await page.keyboard.press("Enter");
    assert.notEqual(await cameraMenu.getAttribute("open"), null, "Keyboard must open the camera controls");
    for (const button of await cameraMenu.locator("button").all()) {
      const bounds = await button.boundingBox();
      assert.ok(bounds && bounds.width >= 48 && bounds.height >= 48, "Each part view needs a touch-sized target");
    }
    await page.keyboard.press("Escape");
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true, "Escape must restore focus to the compact control");
    await openCameraMenu();
    await page.locator(".vehicle-card__heading").click();
    assert.equal(await cameraMenu.getAttribute("open"), null, "Clicking outside must close the camera menu");
    assert.equal(await page.getByLabel("Follow active part", { exact: true }).isChecked(), true,
      "Opening and dismissing camera controls must preserve automatic following");
    await cameraSettled();
    const overviewPosition = await cameraPosition();
    for (const [name, view] of [["Steering", "steering"], ["Rear drive", "drive"], ["Reverse", "reverse"], ["Lights", "lights"], ["Attack", "attack"], ["Boost", "boost"], ["Overview", "overview"]]) {
      const before = await cameraPosition();
      if (name === "Steering") {
        const touch = await page.context().newCDPSession(page);
        try {
          await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
          const tap = async (locator) => {
            const bounds = await locator.boundingBox();
            assert.ok(bounds, "Touch target must be visible");
            await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] });
            await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          };
          await tap(trigger);
          await visible(cameraMenu.getByRole("button", { name, exact: true }));
          await tap(cameraMenu.getByRole("button", { name, exact: true }));
          await page.waitForFunction(() => !document.querySelector(".tumbler-viewer__toolbar").open);
        } finally {
          await touch.send("Emulation.setTouchEmulationEnabled", { enabled: false });
          await touch.detach();
        }
      } else {
        await selectCameraView(name);
      }
      await page.waitForFunction((view) => document.querySelector(".tumbler-viewer")?.getAttribute("data-camera-view") === view, view);
      await cameraSettled();
      assert.ok(positionDistance(before, await cameraPosition()) > 0.1, `${name} must move the rendered camera, not only its selected label`);
      const shotPreview = path.join(output, `camera-${view}.png`);
      await stageScreenshot(shotPreview);
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
    const vehiclePreview = path.join(output, "20-vehicle-card.png");
    await page.locator(".vehicle-card").screenshot({ path: vehiclePreview });
    screenshots.push(vehiclePreview);
    await resize(760, 600);
    await canvas.scrollIntoViewIfNeeded();
    await cameraSettled();
    await noHorizontalOverflow();
    const exit = page.getByRole("button", { name: "Quit Axle", exact: true });
    await exit.scrollIntoViewIfNeeded();
    assert.equal(await exit.isEnabled(), true);
    const narrowMenu = await openCameraMenu();
    const panel = await narrowMenu.locator(".tumbler-viewer__camera-panel").boundingBox();
    const narrowCard = await page.locator(".vehicle-card").boundingBox();
    const narrowTrigger = await narrowMenu.locator("summary").boundingBox();
    const narrowName = await page.locator(".vehicle-name h2").boundingBox();
    assert.ok(panel && narrowCard && panel.x >= narrowCard.x
      && panel.x + panel.width <= narrowCard.x + narrowCard.width
      && panel.y >= narrowCard.y, "The upward-opening camera panel must fit inside the narrow vehicle card");
    assert.ok(narrowTrigger && narrowName && Math.abs(narrowName.y + narrowName.height / 2 - narrowTrigger.y - narrowTrigger.height / 2) < 2,
      "The camera control must remain beside the vehicle name on a narrow window");
    await screenshot("21-tumbler-760x600");
    await page.keyboard.press("Escape");
    await resize(1280, 800);
    await canvas.scrollIntoViewIfNeeded();
    await cameraSettled();
  });

  await checkpoint("Camera transitions keep wall-clock timing at low frame rates and after idle", async () => {
    await cameraSettled();
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      window.__AXLE_NATIVE_RAF__ = window.requestAnimationFrame;
      window.__AXLE_SLOW_FRAMES__ = [];
      window.requestAnimationFrame = (callback) => window.__AXLE_NATIVE_RAF__(() => {
        setTimeout(() => {
          const canvas = document.querySelector(".tumbler-viewer canvas");
          const frame = canvas?.dataset.renderedFrames;
          callback(performance.now());
          if (canvas?.dataset.renderedFrames !== frame) {
            window.__AXLE_SLOW_FRAMES__?.push(canvas.dataset.cameraPosition.split(",").map(Number));
          }
        }, 250);
      });
    });
    try {
      const before = await cameraPosition();
      await selectCameraView("Rear drive");
      await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.dataset.cameraMoving === "true");
      await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.dataset.cameraMoving === "false",
        undefined, { timeout: 6000 });
      const frames = await page.evaluate(() => window.__AXLE_SLOW_FRAMES__);
      assert.ok(frames.length >= 2 && positionDistance(before, frames[0]) < 0.1,
        "Resuming after idle must start smoothly rather than counting idle time as camera movement");
      assert.ok(positionDistance(before, await cameraPosition()) > 1, "A slow GPU must still complete the actual camera move");
    } finally {
      await page.evaluate(() => {
        window.requestAnimationFrame = window.__AXLE_NATIVE_RAF__;
        delete window.__AXLE_NATIVE_RAF__;
        delete window.__AXLE_SLOW_FRAMES__;
      });
    }
    await selectCameraView("Overview");
    await cameraSettled();
  });

  await checkpoint("Preview diagnostics follow Developer mode without recreating the 3D view", async () => {
    await page.locator(".tumbler-viewer canvas").evaluate((canvas) => { window.__AXLE_PREVIEW_CANVAS__ = canvas; });
    const view = await page.locator(".tumbler-viewer").getAttribute("data-camera-view");
    const dialog = await settingsDialog();
    await dialog.getByRole("switch", { name: /Developer mode/ }).check();
    await page.keyboard.press("Escape");
    await visible(page.locator(".tumbler-viewer__diagnostics"));
    await visible(page.getByText("Connect your Tumbler to see its controls in motion.", { exact: true }));
    const settings = await settingsDialog();
    await settings.getByRole("switch", { name: /Developer mode/ }).uncheck();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".tumbler-viewer__diagnostics").count(), 0);
    assert.equal(await page.locator(".tumbler-viewer__note").count(), 0);
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-camera-view"), view);
    assert.equal(await page.evaluate(() => window.__AXLE_PREVIEW_CANVAS__ === document.querySelector(".tumbler-viewer canvas")), true,
      "Developer mode must not reload the asset or reset the renderer");
  });

  await checkpoint("Live Tumbler steering updates pose and reveals a hidden active part", async () => {
    await page.waitForFunction(() => window.__AXLE_TEST__.snapshot().status === "running");
    await fixture("setup");
    await streamTumblerTelemetry({ steering: 25, front_lights_on: true });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-wheel-motion-basis") === "encoder");
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "true");
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-steering")) < -0.01);
    const rightSteering = await canvasValue("data-steering");
    await setCameraFollow(false);
    await selectCameraView("Rear drive");
    await cameraSettled();
    const rearPosition = await cameraPosition();
    await streamTumblerTelemetry({ steering: -50 });
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-steering")) > 0.01);
    assert.ok(rightSteering < 0 && (await canvasValue("data-steering")) > 0, "Right/left controller input must turn the actual wheel pivots toward the driver's right/left");
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-camera-view"), "drive", "Manual view must be retained while follow is off");
    await setCameraFollow(true);
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
    async function sampleGreenLights(flicker = false) {
      return page.locator(".tumbler-viewer canvas").evaluate(async (canvas, flicker) => {
        const samples = [];
        const started = performance.now();
        let lit = false;
        let dark = false;
        // A software GPU may present only one frame in 500 ms. Observe both
        // rendered phases rather than assuming a particular presentation rate.
        while (performance.now() - started < 5000
          && (performance.now() - started < 500 || (flicker && !(lit && dark)))) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const values = canvas.dataset.reverseLightIntensities.split(",").map(Number);
          const effects = canvas.dataset.lampEffects.split(",").map(Number);
          if (effects[1] !== (values[0] > 1 ? 1 : 0)) throw new Error("Green glow must use the exact optical-lens phase");
          if (Math.abs(effects[0] * 4 - Number(canvas.dataset.frontLightIntensity)) > 0.001) {
            // The lens keeps an unlit material baseline; the secondary effects
            // become fully invisible rather than glowing at that baseline.
            if (!(effects[0] === 0 && Number(canvas.dataset.frontLightIntensity) < 0.1)) throw new Error("White beams must follow the same resolved lamp intensity");
          }
          samples.push(values);
          lit ||= values.every((value) => value > 1);
          dark ||= values.every((value) => value < 0.1);
        }
        return samples;
      }, flicker);
    }
    function assertFlicker(samples) {
      assert.ok(samples.every((values) => values.length >= 6 && values.every((value) => value === values[0])),
        "The green cones and clear bars in all three optical assemblies must flicker together");
      assert.ok(samples.some((values) => values.every((value) => value > 1)), "Attack must illuminate green lamps without reverse");
      assert.ok(samples.some((values) => values.every((value) => value < 0.1)), "Attack must also produce dark frames");
    }
    await streamTumblerTelemetry({ flicker: true, rocket_lights_on: false, front_lights_on: false });
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-attack-light-intensity")) > 1);
    assertFlicker(await sampleGreenLights(true));
    assert.ok(await canvasValue("data-boost-intensity") < 0.1, "Attack alone must leave the orange boost lens dark");

    // Simultaneous reverse lighting must not mask the Attack dark phases.
    await streamTumblerTelemetry({ throttle: -40, flicker: true, rocket_lights_on: true });
    assertFlicker(await sampleGreenLights(true));
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
      // Capture the rate, angle and time in the same rendered frame. Separate
      // automation calls could cross into a held pose awaiting encoder data,
      // especially when a software GPU takes longer than the feedback buffer.
      const sample = async (minimumTime = 0) => {
        const result = await page.waitForFunction(({ rate, minimumTime }) => {
          const canvas = document.querySelector(".tumbler-viewer canvas");
          const time = Number(canvas?.dataset.wheelSampledAt);
          if (time < minimumTime || Math.abs(Number(canvas?.dataset.wheelAngularVelocity) - rate) >= 0.001) return false;
          return { angle: Number(canvas.dataset.wheelRotation), time };
        }, { rate: expected, minimumTime });
        try { return await result.jsonValue(); } finally { await result.dispose(); }
      };
      // Switching lighting can compile a new GPU program. Refill the encoder
      // interpolation buffer after that first rendered turn, then measure the
      // sustained rate rather than including an intentionally held stale pose.
      const first = await sample();
      const start = await sample(first.time + 800);
      const end = await sample(start.time + 400);
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

  await checkpoint("Optional street keeps the live camera and follows signed encoder travel", async () => {
    await streamTumblerTelemetry({ measured_wheel_rate: 0 });
    await selectCameraView("Overview");
    await cameraSettled();
    const before = await cameraPosition();
    await page.evaluate(() => { window.__AXLE_STREET_CANVAS__ = document.querySelector(".tumbler-viewer canvas"); });
    const menu = await openCameraMenu();
    const touch = await page.context().newCDPSession(page);
    try {
      await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      const bounds = await menu.locator(".tumbler-street").boundingBox();
      assert.ok(bounds && bounds.height >= 48, "Street scene must have a touch-sized label");
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.dataset.streetScene === "true");
    } finally {
      await touch.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await touch.detach();
    }
    await page.keyboard.press("Escape");
    assert.equal(await menu.getByLabel("Street scene", { exact: true }).isChecked(), true);
    assert.equal(await page.evaluate(() => window.__AXLE_STREET_CANVAS__ === document.querySelector(".tumbler-viewer canvas")), true,
      "Changing the environment must preserve the renderer and model");
    assert.ok(positionDistance(before, await cameraPosition()) < 0.01, "Street toggle must not move the camera");
    assert.equal((await fixture("snapshot")).status, "running", "Street toggle must leave live control running");
    assert.ok(await canvasValue("data-render-triangles") > 920_000 && await canvasValue("data-render-triangles") < 950_000,
      "Detailed city geometry must render within its measured scene budget");
    assert.ok(await canvasValue("data-render-calls") < 120, "Detailed street must still use shared instanced geometry");
    assert.ok(await canvasValue("data-reflection-calls") > 0 && await canvasValue("data-reflection-calls") < 120,
      "Real puddle reflections use one bounded shared scene render");
    assert.ok(await canvasValue("data-reflection-triangles") < 950_000,
      "Reflections cannot silently multiply city geometry or recurse");
    await streamTumblerTelemetry({ front_lights_on: true, throttle: 80, measured_wheel_rate: 8 });
    const start = await canvasValue("data-street-travel");
    await page.waitForFunction((before) => Number(document.querySelector(".tumbler-viewer canvas")?.dataset.streetTravel) > before + 0.1, start);
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.dataset.shadowCalls) > 0);
    assert.ok(await canvasValue("data-shadow-calls") <= 65, "Moving geometry must share one bounded cached key shadow render");
    assert.ok(await canvasValue("data-shadow-triangles") < 950_000, "Volumetrics must reuse the key shadow rather than adding headlight shadow maps");
    assert.ok(await canvasValue("data-render-triangles") < 950_000, "Shadow updates must not inflate beauty geometry measurements");
    await screenshot("28-night-street-headlights");
    const preview = path.join(output, "28-night-street-model.png");
    await stageScreenshot(preview);
    await streamTumblerTelemetry({ throttle: -60, rocket_lights_on: true, measured_wheel_rate: -6 });
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.dataset.wheelAngularVelocity) < -5);
    const reverseStart = await canvasValue("data-street-travel");
    await page.waitForFunction((before) => Number(document.querySelector(".tumbler-viewer canvas")?.dataset.streetTravel) < before - 0.1, reverseStart);
    await streamTumblerTelemetry({ throttle: 100, measured_wheel_rate: 0 });
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.dataset.wheelAngularVelocity) === 0);
    const stopped = await canvasValue("data-street-travel");
    await page.waitForTimeout(200);
    assert.equal(await canvasValue("data-street-travel"), stopped, "Full throttle with a stalled car must not scroll the road");
    await setStreetScene(false);
    await setStreetScene(true);
    assert.equal(await canvasValue("data-street-travel"), stopped, "Toggling the environment must not reset measured travel");
  });

  await checkpoint("Reverse camera remains steady through green-lamp blink phases", async () => {
    await setCameraFollow(true);
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
    await stageScreenshot(reversePreview);
    for (const phase of [false, true, false]) {
      await streamTumblerTelemetry({ throttle: -60, steering: 30, rocket_lights_on: phase, measured_wheel_rate: -6 });
      await page.waitForFunction((on) => document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-reverse-light-intensities")?.split(",").every((value) => on ? Number(value) > 1 : Number(value) < 0.1), phase);
      assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-camera-view"), "reverse");
      const phasePosition = await cameraPosition();
      assert.ok(positionDistance(reversePosition, phasePosition) < 0.05,
        `Blink edges must not move the camera: ${JSON.stringify({ reversePosition, phasePosition, phase })}`);
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
      const canvas = document.querySelector(".tumbler-viewer canvas");
      let lastFrame;
      function sample() {
        const frame = Number(canvas.getAttribute("data-rendered-frames"));
        if (frame !== lastFrame) {
          lastFrame = frame;
          window.__AXLE_CAMERA_SAMPLES__.push({
            frame,
            time: Number(canvas.getAttribute("data-wheel-sampled-at")),
            position: canvas.getAttribute("data-camera-position").split(",").map(Number),
            target: canvas.getAttribute("data-camera-target").split(",").map(Number)
          });
        }
      }
      // Observe completed render turns. A second animation loop can miss a
      // rendered frame under load, making a per-frame distance assertion
      // compare positions separated by several valid camera steps.
      const observer = new MutationObserver(sample);
      observer.observe(canvas, { attributes: true, attributeFilter: ["data-rendered-frames"] });
      window.__AXLE_STOP_CAMERA_SAMPLING__ = () => {
        sample();
        observer.disconnect();
        return window.__AXLE_CAMERA_SAMPLES__;
      };
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
    const samples = await page.evaluate(() => window.__AXLE_STOP_CAMERA_SAMPLING__());
    await fs.writeFile(path.join(output, "camera-transition-samples.json"), JSON.stringify(samples, null, 2));
    assert.ok(samples.length > 2, "The actual rendered camera must travel through intermediate positions");
    for (let index = 0; index < samples.length; index++) {
      assert.ok(positionDistance(samples[index].position, samples[index].target) >= 4.45, "Camera transitions must stay outside the chassis");
      assert.ok(samples[index].position[1] > 0.5, "Camera must remain above the floor");
      if (index) {
        const previous = samples[index - 1];
        assert.equal(samples[index].frame, previous.frame + 1, "Camera continuity must compare consecutive rendered frames");
        const distance = positionDistance(samples[index].position, previous.position);
        const elapsed = (samples[index].time - previous.time) / 1000;
        assert.ok(distance < Math.max(2, elapsed * 40), `Retargeting must not jump between shots: frames ${previous.frame}–${samples[index].frame} moved ${distance} in ${elapsed}s`);
      }
    }
    await page.waitForTimeout(450);
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-camera-view"), "combined", "Simultaneous controls must not cycle between individual parts");
    assert.ok(positionDistance(combinedPosition, await cameraPosition()) < 0.05);
    await screenshot("26-tumbler-combined-controls");
    const combinedPreview = path.join(output, "26-tumbler-combined-model.png");
    await stageScreenshot(combinedPreview);
    await resize(760, 600);
    await page.locator(".tumbler-viewer canvas").scrollIntoViewIfNeeded();
    await cameraSettled();
    const narrowCombined = path.join(output, "29-night-street-combined-narrow.png");
    await stageScreenshot(narrowCombined);
    await noHorizontalOverflow();
    await resize(1280, 800);
    await cameraSettled();
  });

  await checkpoint("Tumbler drive animation stops when feedback becomes stale", async () => {
    await streamTumblerTelemetry({ throttle: 60, measured_wheel_rate: 8 });
    const initialRotation = await canvasValue("data-wheel-rotation");
    await page.waitForFunction((before) => Math.abs(Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-wheel-rotation")) - before) > 0.05, initialRotation);
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-active-part"), "drive");
    await streamTumblerTelemetry({ throttle: 60, boost: true, rocket_lights_on: true, flicker: true, measured_wheel_rate: 12 });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-active-part") === "attack");
    await selectCameraView("Boost");
    await cameraSettled();
    await screenshot("23-tumbler-live-boost");
    await fixture("stopTelemetry");
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-wheel-motion-basis") === "none");
    assert.equal(await page.locator(".tumbler-viewer").getAttribute("data-live"), "true", "Encoder expiry must occur before the longer control-feedback timeout");
    assert.equal(await canvasValue("data-wheel-angular-velocity"), 0, "Silent encoders must stop immediately without extrapolating drive power");
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "false");
    await page.waitForFunction(() => Number(document.querySelector(".tumbler-viewer canvas")?.getAttribute("data-wheel-angular-velocity")) === 0);
    const staleRotation = await canvasValue("data-wheel-rotation");
    const staleTravel = await canvasValue("data-street-travel");
    await page.waitForTimeout(200);
    assert.equal(await canvasValue("data-wheel-rotation"), staleRotation, "Lost telemetry must not keep showing a moving car");
    assert.equal(await canvasValue("data-street-travel"), staleTravel, "Lost telemetry must also stop the street");
    assert.equal(await page.locator(".tumbler-viewer canvas").getAttribute("data-lamp-effects"), "0.0000,0.0000,0.0000", "Stale telemetry must extinguish every secondary lamp effect");
    assert.ok(await canvasValue("data-boost-intensity") < 0.1);
    const staleReverse = (await page.locator(".tumbler-viewer canvas").getAttribute("data-reverse-light-intensities")).split(",").map(Number);
    assert.ok(staleReverse.every((value) => value < 0.1), "Stale feedback must also turn green reverse lamps off");
  });

  await checkpoint("Reduced motion retains live pose without revolving wheels or automatic camera", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openCameraMenu();
    await visible(page.getByText("Automatic views paused for reduced motion.", { exact: true }));
    assert.equal(await page.getByLabel("Follow active part", { exact: true }).isDisabled(), true);
    await selectCameraView("Rear drive");
    const stillRotation = await canvasValue("data-wheel-rotation");
    const stillTravel = await canvasValue("data-street-travel");
    await streamTumblerTelemetry({ steering: 30, throttle: 60, measured_wheel_rate: 8 });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "true");
    await page.waitForTimeout(200);
    assert.equal(await canvasValue("data-wheel-rotation"), stillRotation, "Reduced motion must suppress revolving wheel animation");
    assert.equal(await canvasValue("data-street-travel"), stillTravel, "Reduced motion must freeze the street as well as the wheels");
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
    assert.equal(await page.getByLabel("Vehicle model", { exact: true }).count(), 0);
  });
  await checkpoint("Touch exit stays reachable on Steam Deck and reports cleanup failure", async () => {
    await resize(1280, 800);
    const exit = page.getByRole("button", { name: "Quit Axle", exact: true });
    await exit.scrollIntoViewIfNeeded();
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
  await checkpoint("A lost 3D context releases the viewer while vehicle controls remain available", async () => {
    await page.locator(".tumbler-viewer canvas").evaluate((canvas) => {
      const event = new Event("webglcontextlost", { cancelable: true });
      canvas.dispatchEvent(event);
      if (!event.defaultPrevented) throw new Error("Context loss must prevent automatic restoration of the disposed renderer");
    });
    await visible(page.getByText("3D preview unavailable", { exact: true }));
    assert.equal(await page.locator(".tumbler-viewer canvas").count(), 0, "Disposed viewer cannot retain its WebGL canvas");
    for (const button of await page.locator(".tumbler-viewer__views button").all()) {
      assert.equal(await button.isDisabled(), true);
    }
    await streamTumblerTelemetry({ throttle: 30, measured_wheel_rate: 4 });
    await page.waitForFunction(() => document.querySelector(".tumbler-viewer")?.getAttribute("data-live") === "true");
    assert.equal(await page.getByLabel("Vehicle model", { exact: true }).count(), 0);
    await fixture("stopTelemetry");
  });
  assert.deepEqual(runtimeErrors, [], "Unexpected renderer console/runtime errors");
}

(async () => {
  let failure;
  try { await run(); } catch (error) {
    failure = error;
    if (activePage && !activePage.isClosed()) {
      await screenshot("99-failure").catch(() => {});
      const state = await activePage.evaluate(() => ({
        canvas: { ...document.querySelector(".tumbler-viewer canvas")?.dataset },
        viewer: { ...document.querySelector(".tumbler-viewer")?.dataset },
        follow: document.querySelector(".tumbler-viewer input")?.checked, hidden: document.hidden
      })).catch(() => null);
      await fs.writeFile(path.join(output, "failure-state.json"), JSON.stringify(state, null, 2)).catch(() => {});
      await fs.writeFile(path.join(output, "failure-page.txt"), await activePage.locator("body").innerText().catch(() => "Unavailable")).catch(() => {});
    }
  } finally {
    if (activeApp) await activeApp.close().catch(() => {});
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ success: !failure, checks, screenshots, runtimeErrors, processLogs, failure: failure?.stack }, null, 2));
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
  if (failure) { console.error(failure); process.exitCode = 1; }
  else process.stdout.write(`\n${checks.length} checks passed. Screenshots and report: ${output}\n`);
})();
