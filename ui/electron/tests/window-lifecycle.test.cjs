const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

const source = readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
const compiled = transformSync(source, { loader: "ts", format: "cjs" }).code;
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function desktopHarness(active = true) {
  const app = new EventEmitter();
  const windows = [];
  const pendingStops = [];
  const errors = [];
  let stopCalls = 0;
  let quitCompleted = false;
  let updateOptions;
  let updateCheckCalls = 0;
  const handlers = new Map();

  function cancelableEvent() {
    return { prevented: false, preventDefault() { this.prevented = true; } };
  }

  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    static getAllWindows() { return windows.filter((window) => !window.destroyed); }
    async loadURL() {}
    async loadFile() {}
    setFullScreen() {}
    isDestroyed() { return this.destroyed; }
    close() {
      const event = cancelableEvent();
      this.emit("close", event);
      if (!event.prevented) {
        this.destroyed = true;
        this.emit("closed");
        app.emit("window-all-closed");
      }
    }
  }

  app.setName = (name) => { app.name = name; };
  app.getPath = () => "/mock-desktop-user-data";
  app.getName = () => app.name;
  app.getVersion = () => "0.0.0-test";
  app.whenReady = () => Promise.resolve();
  app.quit = () => {
    const event = cancelableEvent();
    app.emit("before-quit", event);
    if (!event.prevented) {
      Window.getAllWindows().forEach((window) => window.close());
      quitCompleted = Window.getAllWindows().length === 0;
    }
  };

  class BridgeProcessService {
    hasActiveProcess() { return active; }
    stopForAppQuit() {
      stopCalls += 1;
      return new Promise((resolve, reject) => {
        pendingStops.push({ resolve: () => { active = false; resolve(); }, reject });
      });
    }
  }

  const imports = {
    electron: { app, BrowserWindow: Window, ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, Menu: { buildFromTemplate() {}, setApplicationMenu() {} }, shell: { openExternal() {} } },
    "node:fs": { mkdirSync() {}, readFileSync() { throw new Error("No saved settings"); }, writeFileSync() {} },
    "node:path": path,
    "./bridgeProcessService": { BridgeProcessService },
    "./appUpdates": { createAppUpdates: (options) => { updateOptions = options; return { check: async () => { updateCheckCalls += 1; } }; } },
    "../shared/bridge": { bridgeIpcChannels: { startLive: "bridge:start", runCommand: "bridge:command", discover: "bridge:discover" } },
    "../shared/bootstrap": { buildTargets: [], runtimeItems: [] },
    "../shared/settings": { defaultDesktopSettings: { launchFullscreen: false } }
  };
  const execute = vm.runInNewContext(`(function(require, module, exports, __dirname) { ${compiled}\n})`, {
    console: { error: (...args) => errors.push(args) },
    process: { platform: "darwin", arch: "arm64", versions: {}, env: {} }
  });
  const module = { exports: {} };
  execute((id) => {
    assert.ok(id in imports, `Unexpected main-process import: ${id}`);
    return imports[id];
  }, module, module.exports, "/mock/main");
  await flush();

  return {
    app, window: windows[0], errors, pendingStops, updateOptions, handlers,
    get updateCheckCalls() { return updateCheckCalls; },
    get stopCalls() { return stopCalls; },
    get quitCompleted() { return quitCompleted; }
  };
}

test("startup update check runs once after the renderer loads", async () => {
  const desktop = await desktopHarness(false);
  assert.equal(desktop.updateCheckCalls, 0);
  desktop.window.webContents.emit("did-finish-load");
  desktop.window.webContents.emit("did-finish-load");
  await flush();
  assert.equal(desktop.updateCheckCalls, 1);
});

test("update preparation stops vehicle control and blocks new bridge commands", async () => {
  const desktop = await desktopHarness();
  const preparing = desktop.updateOptions.prepareInstall();
  assert.equal(desktop.stopCalls, 1);
  for (const name of ["bridge:start", "bridge:command"]) {
    assert.equal(desktop.handlers.get(name)({}, {}).ok, false);
  }
  desktop.pendingStops[0].resolve();
  await preparing;
});

test("touch Exit waits for motor cleanup and blocks new sessions before quitting", async () => {
  const desktop = await desktopHarness();
  const exiting = desktop.handlers.get("app:quit")();
  assert.equal(desktop.quitCompleted, false);
  assert.equal(desktop.handlers.get("bridge:start")({}, {}).ok, false);
  assert.equal(desktop.handlers.get("bridge:discover")().ok, false);
  desktop.pendingStops[0].resolve();
  assert.equal((await exiting).ok, true);
  assert.equal(desktop.quitCompleted, true);
});

test("failed Exit cleanup keeps the app open and allows retry", async () => {
  const desktop = await desktopHarness();
  const exiting = desktop.handlers.get("app:quit")();
  desktop.pendingStops[0].reject(new Error("cleanup failed"));
  assert.equal((await exiting).ok, false);
  assert.equal(desktop.quitCompleted, false);
  const retry = desktop.handlers.get("app:quit")();
  desktop.pendingStops[1].resolve();
  assert.equal((await retry).ok, true);
});

test("idle window closes immediately and keeps the established app identity", async () => {
  const desktop = await desktopHarness(false);
  assert.equal(desktop.app.name, "LEGO Technic Gamepad Bridge");
  assert.equal(desktop.window.options.width, 1180);
  assert.equal(desktop.window.options.height, 800);
  assert.equal(desktop.window.options.minWidth, 760);
  assert.equal(desktop.window.options.minHeight, 600);
  desktop.window.close();
  assert.equal(desktop.window.isDestroyed(), true);
  assert.equal(desktop.stopCalls, 0);
});

test("repeated window close waits for one bridge shutdown", async () => {
  const desktop = await desktopHarness();
  desktop.window.close();
  desktop.window.close();
  assert.equal(desktop.window.isDestroyed(), false);
  assert.equal(desktop.stopCalls, 1);
  desktop.pendingStops[0].resolve();
  await flush();
  assert.equal(desktop.window.isDestroyed(), true);
});

test("window close and repeated app quit share the in-flight shutdown", async () => {
  const desktop = await desktopHarness();
  desktop.window.close();
  desktop.app.quit();
  desktop.app.quit();
  assert.equal(desktop.stopCalls, 1);
  assert.equal(desktop.quitCompleted, false);
  assert.equal(desktop.window.isDestroyed(), false);
  desktop.pendingStops[0].resolve();
  await flush();
  assert.equal(desktop.window.isDestroyed(), true);
  assert.equal(desktop.quitCompleted, true);
});

test("failed shutdown retains the control window and allows a later retry", async () => {
  const desktop = await desktopHarness();
  desktop.window.close();
  desktop.pendingStops[0].reject(new Error("Interrupted shutdown"));
  await flush();
  assert.equal(desktop.window.isDestroyed(), false);
  assert.equal(desktop.errors.length, 1);
  desktop.window.close();
  assert.equal(desktop.stopCalls, 2);
  desktop.pendingStops[1].resolve();
  await flush();
  assert.equal(desktop.window.isDestroyed(), true);
});

test("automatic startup cannot restart control during window close or app quit", async () => {
  for (const action of ["close", "quit"]) {
    const desktop = await desktopHarness();
    if (action === "close") desktop.window.close(); else desktop.app.quit();
    assert.equal(desktop.handlers.get("bridge:start")({}, {}).ok, false);
    assert.equal(desktop.handlers.get("bridge:discover")().ok, false);
    desktop.pendingStops[0].resolve();
    await flush();
  }
});
