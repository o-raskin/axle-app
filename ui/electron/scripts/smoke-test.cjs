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
  const profiles = {
    models: [{ id: "42124", name: "42124 Off-road Buggy" }, { id: "42160", name: "42160 Rally Car" }],
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
  const subscribe = (kind, callback) => {
    callbacks[kind].add(callback);
    return () => callbacks[kind].delete(callback);
  };
  const begin = async (operation, payload) => {
    calls.push({ method: operation === "live" ? "startBridge" : "runBridgeCommand", payload });
    if (options.startFailure) throw new Error("Bluetooth permission denied");
    status = { status: "starting", operation, sessionId: `fixture-${++session}`, startedAt: new Date().toISOString() };
    publishStatus({});
    await delay(35);
    publishStatus({ status: "running" });
    return { ok: true, sessionId: status.sessionId };
  };
  contextBridge.exposeInMainWorld("legoBridgeUi", {
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
    telemetry: (patch = {}) => publishEvent({ type: "telemetry", telemetry: { kind: "vehicle", model_name: "Off-road Buggy", speed: 0, steering: 0, battery: 87, ...patch } }),
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
    args: [path.join(temporary, "main.cjs")],
    env: { ...process.env, AXLE_SMOKE_USER_DATA: path.join(temporary, `user-data-${scenario}`), AXLE_SMOKE_PRELOAD: path.join(temporary, "preload.cjs"), AXLE_SMOKE_RENDERER: renderer, AXLE_SMOKE_SCENARIO: scenario }
  });
  const page = await activeApp.firstWindow();
  activePage = page;
  page.setDefaultTimeout(7000);
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

async function run() {
  await fs.access(renderer).catch(() => { throw new Error("Built renderer is missing. Run npm run build in ui/electron first."); });
  await fs.mkdir(output, { recursive: true });
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axle-smoke-"));
  await fs.writeFile(path.join(temporary, "main.cjs"), `(${fixtureMain.toString()})();\n`);
  await fs.writeFile(path.join(temporary, "preload.cjs"), `(${fixturePreload.toString()})();\n`);
  let page = await launch();

  await checkpoint("Offline start and wide layout", async () => {
    await visible(page.getByRole("heading", { name: "Ready when you are" }));
    assert.equal(await page.getByRole("button", { name: "Connect vehicle", exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "Diagnostics", exact: true }).count(), 0);
    await noHorizontalOverflow();
    await screenshot("01-offline-1280x800");
  });

  await checkpoint("Narrow layout keeps connection controls reachable", async () => {
    await resize(760, 600);
    await noHorizontalOverflow();
    const primaryBounds = await page.getByRole("button", { name: "Connect vehicle", exact: true }).boundingBox();
    assert.ok(primaryBounds && primaryBounds.y + primaryBounds.height <= 600, `Primary action must fit within 760×600 viewport: ${JSON.stringify(primaryBounds)}`);
    await page.getByRole("button", { name: "Connect vehicle", exact: true }).scrollIntoViewIfNeeded();
    await screenshot("02-offline-760x600");
    await resize(1280, 800);
  });

  await checkpoint("200 percent zoom reflows without horizontal overflow", async () => {
    await activeApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    await page.waitForFunction(() => innerWidth === 640);
    await noHorizontalOverflow();
    await screenshot("16-zoom-200-percent");
    await activeApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await page.waitForFunction(() => innerWidth === 1280);
  });

  await checkpoint("Settings, keyboard focus, and Escape restoration", async () => {
    const dialog = await settingsDialog();
    for (let index = 0; index < 14; index++) { await page.keyboard.press("Tab"); await assertFocusInsideDialog(); }
    for (let index = 0; index < 3; index++) { await page.keyboard.press("Shift+Tab"); await assertFocusInsideDialog(); }
    await screenshot("03-settings");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).evaluate((element) => element === document.activeElement), true);
    await page.getByRole("button", { name: "How to drive" }).click();
    await visible(page.getByRole("heading", { name: "Your hands know the way." }));
    await screenshot("04-controls");
    await page.keyboard.press("Escape");
  });

  await checkpoint("Advanced options and preference persistence payloads", async () => {
    const dialog = await settingsDialog();
    await dialog.getByLabel("Controller profile").selectOption("dualsense");
    await dialog.getByText("Advanced connection", { exact: true }).click();
    await dialog.getByLabel("Hub name").fill("Smoke Test Hub");
    await dialog.getByLabel(/Bluetooth address/).fill("AA:BB:CC:DD:EE:FF");
    await dialog.getByRole("switch", { name: /Fullscreen/ }).check();
    let calls = await fixture("calls");
    assert.deepEqual(calls.find((call) => call.method === "updateSettings").payload, { launchFullscreen: true });
    await fixture("configure", { settingsFailure: true });
    // A rejected write rolls back immediately; uncheck() would incorrectly
    // require the optimistic state to remain in place after the click.
    await dialog.getByRole("switch", { name: /Fullscreen/ }).click();
    await visible(dialog.getByRole("alert"));
    assert.equal(await dialog.getByRole("switch", { name: /Fullscreen/ }).isChecked(), true, "Failed preference write must restore its previous value");
    await fixture("configure", { settingsFailure: false });
    await dialog.getByRole("switch", { name: /Fullscreen/ }).uncheck();
    await dialog.getByRole("switch", { name: /Developer mode/ }).check();
    await screenshot("05-advanced-settings");
    await page.keyboard.press("Escape");
    await visible(page.getByRole("button", { name: "Diagnostics", exact: true }));
  });

  await checkpoint("Connection starts with exact selected payload", async () => {
    await page.getByRole("button", { name: "Connect vehicle", exact: true }).click();
    await visible(page.getByRole("heading", { name: "Finding your controller and vehicle" }));
    const calls = await fixture("calls");
    assert.deepEqual(calls.find((call) => call.method === "startBridge").payload, { modelId: "42124", gamepadId: "dualsense", hubName: "Smoke Test Hub", hubAddress: "AA:BB:CC:DD:EE:FF" });
    await screenshot("06-connecting");
  });

  await checkpoint("Connected state waits for setup and live telemetry", async () => {
    await fixture("setup", { controller: false, vehicle: false, ready: false });
    await fixture("telemetry");
    assert.equal(await page.getByRole("heading", { name: "Ready to drive" }).count(), 0, "Telemetry cannot bypass an incomplete setup checklist");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const motionDuration = await page.locator(".status-pill--busy .status-dot").evaluate((element) => getComputedStyle(element).animationDuration);
    assert.ok(motionDuration.split(",").every((value) => parseFloat(value) <= 0.00001), `Reduced-motion animation duration must be near zero, received ${motionDuration}`);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await fixture("setup", { controller: true, vehicle: true, ready: true });
    await visible(page.getByRole("heading", { name: "Preparing your vehicle" }));
    await fixture("telemetry");
    await visible(page.getByRole("heading", { name: "Ready to drive" }));
    await visible(page.getByRole("button", { name: "Stop driving", exact: true }));
    await screenshot("07-connected");
    const dialog = await settingsDialog();
    assert.equal(await dialog.getByLabel("Controller profile").isDisabled(), true);
    await page.keyboard.press("Escape");
  });

  await checkpoint("Impact pause preserves immediate Stop access", async () => {
    await fixture("telemetry", { crash: true });
    await visible(page.getByRole("heading", { name: "A moment to reset", exact: true }));
    await visible(page.getByText("Control paused", { exact: true }));
    assert.equal(await page.getByRole("button", { name: "Stop driving", exact: true }).isEnabled(), true);
    await screenshot("17-impact-paused");
    await fixture("telemetry", { crash: false });
    await visible(page.getByRole("heading", { name: "Ready to drive" }));
  });

  await checkpoint("Lost device returns to reconnecting and requires fresh telemetry", async () => {
    await fixture("setup", { controller: true, vehicle: false, ready: false });
    await visible(page.getByRole("heading", { name: "Let’s reconnect" }));
    assert.equal(await page.getByLabel("Vehicle waiting", { exact: true }).count(), 1);
    await screenshot("08-reconnecting");
    await fixture("setup", { controller: true, vehicle: true, ready: true });
    await visible(page.getByRole("heading", { name: "Preparing your vehicle" }));
    await fixture("telemetry");
    await visible(page.getByRole("heading", { name: "Ready to drive" }));
  });

  await checkpoint("Stop ends session and exposes reconnect", async () => {
    await page.getByRole("button", { name: "Stop driving", exact: true }).click();
    await visible(page.getByRole("heading", { name: "Drive ended" }));
    await visible(page.getByRole("button", { name: "Reconnect vehicle", exact: true }));
    assert.equal((await fixture("calls")).filter((call) => call.method === "stopBridge").length, 1);
    await screenshot("09-stopped");
  });

  await checkpoint("Connection errors are recoverable", async () => {
    await fixture("configure", { startFailure: true });
    await page.getByRole("button", { name: "Reconnect vehicle", exact: true }).click();
    await visible(page.getByRole("heading", { name: "Connection needs attention" }));
    await visible(page.getByText(/Bluetooth access is blocked/));
    await screenshot("10-connection-error");
    await fixture("configure", { startFailure: false });
    await page.getByRole("button", { name: "Reconnect vehicle", exact: true }).click();
    await visible(page.getByRole("heading", { name: "Finding your controller and vehicle" }));
    await page.getByRole("button", { name: "Cancel connection", exact: true }).click();
    await visible(page.getByRole("button", { name: "Reconnect vehicle", exact: true }));
  });

  await checkpoint("All diagnostics forward payloads and render results", async () => {
    await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
    for (const [kind, title] of [["scanHub", "Inspect vehicle"], ["gamepadDevices", "Find controllers"], ["probeGamepad", "Test controller input"], ["audioDevices", "Find audio devices"]]) {
      await page.getByRole("button", { name: new RegExp(title) }).click();
      await visible(page.getByRole("button", { name: "Stop session", exact: true }));
      await page.waitForFunction(() => window.__AXLE_TEST__.snapshot().status === "running");
      const calls = await fixture("calls");
      const expected = kind === "gamepadDevices" || kind === "audioDevices"
        ? { kind }
        : { kind, modelId: "42124", gamepadId: "dualsense", hubName: "Smoke Test Hub", hubAddress: "AA:BB:CC:DD:EE:FF" };
      assert.deepEqual(calls.filter((call) => call.method === "runBridgeCommand").at(-1).payload, expected);
      await page.evaluate(({ kind }) => window.__AXLE_TEST__.complete(kind, { fixture: true, devices: [{ name: "Smoke test device" }] }), { kind });
      await visible(page.getByText(`${kind} · Completed`, { exact: true }));
    }
    await fixture("log", "Smoke fixture message");
    await screenshot("11-diagnostics-results");
    await page.getByRole("button", { name: /^Logs/ }).click();
    await visible(page.getByText("Smoke fixture message", { exact: true }));
    await screenshot("12-diagnostics-logs");
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await visible(page.getByRole("heading", { name: "A clean slate" }));
    await page.getByRole("button", { name: /^Events/ }).click();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await visible(page.getByRole("heading", { name: "No events yet" }));
    await resize(760, 600);
    await noHorizontalOverflow();
    await screenshot("13-diagnostics-760x600");
  });

  await checkpoint("Profile-load failure and retry", async () => {
    page = await launch("profile-failure");
    await visible(page.getByRole("heading", { name: "A little setup needed" }));
    assert.equal(await page.getByRole("button", { name: "Connect vehicle", exact: true }).count(), 0);
    await screenshot("14-profile-error");
    await fixture("configure", { profileFailure: false });
    await page.getByRole("button", { name: "Try again" }).click();
    await visible(page.getByRole("heading", { name: "Ready when you are" }));
    assert.equal(await page.getByRole("button", { name: "Connect vehicle", exact: true }).isEnabled(), true);
  });

  await checkpoint("Bootstrap failure and retry", async () => {
    page = await launch("bootstrap-failure");
    await visible(page.getByRole("heading", { name: "Let’s try that again" }));
    await screenshot("15-bootstrap-error");
    await fixture("configure", { bootstrapFailure: false });
    await page.getByRole("button", { name: "Try again" }).click();
    await visible(page.getByRole("heading", { name: "Ready when you are" }));
  });

  await checkpoint("Existing drive remains stoppable while profiles load", async () => {
    page = await launch("reload-live-slow-profiles");
    await visible(page.getByRole("heading", { name: "Getting things ready" }));
    const stop = page.getByRole("button", { name: "Stop session", exact: true });
    await visible(stop);
    assert.equal(await stop.isEnabled(), true);
    assert.equal(await page.getByRole("heading", { name: "Getting things ready" }).isVisible(), true, "Stop must be available before delayed profiles resolve");
    await screenshot("18-loading-existing-session");
    await stop.click();
    await visible(page.getByRole("heading", { name: "Drive ended" }));
    assert.equal((await fixture("calls")).filter((call) => call.method === "stopBridge").length, 1);
  });

  await checkpoint("Existing drive remains stoppable after bootstrap failure", async () => {
    page = await launch("bootstrap-failure-live");
    await visible(page.getByRole("heading", { name: "Let’s try that again" }));
    const stop = page.getByRole("button", { name: "Stop session", exact: true });
    assert.equal(await stop.isEnabled(), true);
    await screenshot("19-bootstrap-failure-existing-session");
    await stop.click();
    await stop.waitFor({ state: "detached" });
    assert.equal((await fixture("calls")).filter((call) => call.method === "stopBridge").length, 1);
  });

  assert.deepEqual(runtimeErrors, [], "Unexpected renderer console/runtime errors");
}

(async () => {
  let failure;
  try { await run(); } catch (error) {
    failure = error;
    if (activePage && !activePage.isClosed()) {
      await screenshot("99-failure").catch(() => {});
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
