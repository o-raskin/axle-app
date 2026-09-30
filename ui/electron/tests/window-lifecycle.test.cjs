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
    electron: { app, BrowserWindow: Window, ipcMain: { handle() {} }, Menu: { buildFromTemplate() {}, setApplicationMenu() {} }, shell: { openExternal() {} } },
    "node:fs": { mkdirSync() {}, readFileSync() { throw new Error("No saved settings"); }, writeFileSync() {} },
    "node:path": path,
    "./bridgeProcessService": { BridgeProcessService },
    "../shared/bridge": { bridgeIpcChannels: {} },
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
    app, window: windows[0], errors, pendingStops,
    get stopCalls() { return stopCalls; },
    get quitCompleted() { return quitCompleted; }
  };
}

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
