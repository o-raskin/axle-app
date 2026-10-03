const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { vmCoverageFilename } = require("./helpers/vm-coverage.cjs");
const { pathToFileURL } = require("node:url");
const { transformSync } = require("esbuild");

const sourceFile = path.join(__dirname, "../src/main/index.ts");
const source = readFileSync(sourceFile, "utf8");
const compiled = transformSync(source, { loader: "ts", format: "cjs", sourcemap: "inline", sourcefile: sourceFile }).code;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadTypeScript(filename) {
  const code = transformSync(readFileSync(filename, "utf8"), {
    loader: "ts", format: "cjs", sourcemap: "inline", sourcefile: filename
  }).code;
  const module = { exports: {} };
  const localRequire = (id) => id.startsWith(".")
    ? loadTypeScript(path.resolve(path.dirname(filename), `${id}.ts`)) : require(id);
  vm.runInNewContext(code, { require: localRequire, module, exports: module.exports, URL }, { filename: vmCoverageFilename(code, `${filename}.cjs`) });
  return module.exports;
}

async function desktopHarness(active = true, { messageBoxFailure = false } = {}) {
  const app = new EventEmitter();
  const windows = [];
  const pendingStops = [];
  const errors = [];
  const externalUrls = [];
  const messageBoxes = [];
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
      this.webContents.mainFrame = { url: pathToFileURL("/mock/renderer/index.html").href };
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
      app.emit("web-contents-created", {}, this.webContents);
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

  app.commandLine = { hasSwitch: () => false };
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
    electron: {
      app, BrowserWindow: Window,
      dialog: {
        showMessageBox: async (...args) => {
          messageBoxes.push({ parent: args.length === 2 ? args[0] : null, options: args.at(-1) });
          if (messageBoxFailure) throw new Error("Message box unavailable");
          return { response: 0 };
        }
      },
      ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
      Menu: { buildFromTemplate() {}, setApplicationMenu() {} },
      shell: { openExternal: async (url) => { externalUrls.push(url); } }
    },
    "node:fs": { mkdirSync() {}, readFileSync() { throw new Error("No saved settings"); }, writeFileSync() {} },
    "node:path": path,
    "node:url": require("node:url"),
    "./rendererSecurity": loadTypeScript(path.join(__dirname, "../src/main/rendererSecurity.ts")),
    "./desktopSettings": loadTypeScript(path.join(__dirname, "../src/main/desktopSettings.ts")),
    "./bridgeProcessService": { BridgeProcessService },
    "./appUpdates": { createAppUpdates: (options) => { updateOptions = options; return { check: async () => { updateCheckCalls += 1; } }; } },
    "../shared/bridge": { bridgeIpcChannels: { startLive: "bridge:start", runCommand: "bridge:command", discover: "bridge:discover" } },
    "../shared/bootstrap": { buildTargets: [], runtimeItems: [] },
    "../shared/settings": { defaultDesktopSettings: { launchFullscreen: false } }
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    require: (id) => {
      assert.ok(id in imports, `Unexpected main-process import: ${id}`);
      return imports[id];
    },
    module, exports: module.exports, __dirname: "/mock/main",
    console: { error: (...args) => errors.push(args) },
    URL,
    process: { platform: "darwin", arch: "arm64", versions: {}, env: {} }
  }, { filename: vmCoverageFilename(compiled, `${sourceFile}.cjs`) });
  await flush();

  return {
    app, window: windows[0], errors, pendingStops, updateOptions, handlers, externalUrls, messageBoxes,
    invoke: (name, ...args) => handlers.get(name)({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }, ...args),
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
    assert.equal(desktop.invoke(name, {}).ok, false);
  }
  desktop.pendingStops[0].resolve();
  await preparing;
});

test("touch Exit waits for motor cleanup and blocks new sessions before quitting", async () => {
  const desktop = await desktopHarness();
  const exiting = desktop.invoke("app:quit");
  assert.equal(desktop.quitCompleted, false);
  assert.equal(desktop.invoke("bridge:start", {}).ok, false);
  assert.equal(desktop.invoke("bridge:discover").ok, false);
  desktop.pendingStops[0].resolve();
  assert.equal((await exiting).ok, true);
  assert.equal(desktop.quitCompleted, true);
});

test("failed Exit cleanup keeps the app open and allows retry", async () => {
  const desktop = await desktopHarness();
  const exiting = desktop.invoke("app:quit");
  desktop.pendingStops[0].reject(new Error("cleanup failed"));
  assert.equal((await exiting).ok, false);
  assert.equal(desktop.quitCompleted, false);
  assert.equal(desktop.messageBoxes.length, 0, "In-app Exit already reports its own failure");
  const retry = desktop.invoke("app:quit");
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
  assert.equal(desktop.messageBoxes.length, 1);
  assert.equal(desktop.messageBoxes[0].parent, desktop.window);
  assert.equal(desktop.messageBoxes[0].options.type, "error");
  assert.match(desktop.messageBoxes[0].options.message, /could not confirm.*control stopped/i);
  assert.match(desktop.messageBoxes[0].options.detail, /stayed open.*Try Exit again.*turn off your vehicle/i);
  desktop.window.close();
  assert.equal(desktop.stopCalls, 2);
  desktop.pendingStops[1].resolve();
  await flush();
  assert.equal(desktop.window.isDestroyed(), true);
  assert.equal(desktop.messageBoxes.length, 1);
});

test("failed native app quit explains why Axle stayed open and permits retry", async () => {
  const desktop = await desktopHarness();
  desktop.app.quit();
  desktop.app.quit();
  assert.equal(desktop.stopCalls, 1);
  desktop.pendingStops[0].reject(new Error("Interrupted shutdown"));
  await flush();
  assert.equal(desktop.quitCompleted, false);
  assert.equal(desktop.window.isDestroyed(), false);
  assert.equal(desktop.messageBoxes.length, 1);
  assert.equal(desktop.messageBoxes[0].parent, desktop.window);
  assert.match(desktop.messageBoxes[0].options.detail, /stayed open.*Try Exit again.*turn off your vehicle/i);
  desktop.app.quit();
  assert.equal(desktop.stopCalls, 2);
  desktop.pendingStops[1].resolve();
  await flush();
  assert.equal(desktop.quitCompleted, true);
  assert.equal(desktop.messageBoxes.length, 1);
});

test("overlapping native close and app quit failures show one recovery notice", async () => {
  const desktop = await desktopHarness();
  desktop.window.close();
  desktop.app.quit();
  desktop.pendingStops[0].reject(new Error("Interrupted shutdown"));
  await flush();
  assert.equal(desktop.stopCalls, 1);
  assert.equal(desktop.messageBoxes.length, 1);
  assert.equal(desktop.window.isDestroyed(), false);
});

test("a rejected shutdown notice is handled and does not prevent retry", async () => {
  for (const action of ["close", "quit"]) {
    const desktop = await desktopHarness(true, { messageBoxFailure: true });
    if (action === "close") desktop.window.close(); else desktop.app.quit();
    desktop.pendingStops[0].reject(new Error("Interrupted shutdown"));
    await flush();
    assert.equal(desktop.window.isDestroyed(), false);
    assert.equal(desktop.messageBoxes.length, 1);
    assert.equal(desktop.errors.length, 2);
    assert.match(desktop.errors[1][0], /Could not display the shutdown failure notice/);
    if (action === "close") desktop.window.close(); else desktop.app.quit();
    assert.equal(desktop.stopCalls, 2);
    desktop.pendingStops[1].resolve();
    await flush();
    assert.equal(desktop.window.isDestroyed(), true);
  }
});

test("shutdown recovery notice avoids parenting to a destroyed window", async () => {
  const desktop = await desktopHarness();
  desktop.app.quit();
  desktop.window.destroyed = true;
  desktop.pendingStops[0].reject(new Error("Interrupted shutdown"));
  await flush();
  assert.equal(desktop.messageBoxes.length, 1);
  assert.equal(desktop.messageBoxes[0].parent, null);
});

test("automatic startup cannot restart control during window close or app quit", async () => {
  for (const action of ["close", "quit"]) {
    const desktop = await desktopHarness();
    if (action === "close") desktop.window.close(); else desktop.app.quit();
    assert.equal(desktop.invoke("bridge:start", {}).ok, false);
    assert.equal(desktop.invoke("bridge:discover").ok, false);
    desktop.pendingStops[0].resolve();
    await flush();
  }
});


test("main IPC rejects a foreign window, subframe, or navigated document before taking action", async () => {
  const desktop = await desktopHarness();
  const contents = desktop.window.webContents;
  const quit = desktop.handlers.get("app:quit");
  for (const event of [{ sender: {}, senderFrame: contents.mainFrame },
    { sender: contents, senderFrame: { ...contents.mainFrame } },
    { sender: contents, senderFrame: null }]) {
    assert.throws(() => quit(event), /Desktop IPC/);
  }
  contents.mainFrame.url = "file:///tmp/untrusted.html";
  assert.throws(() => desktop.invoke("app:quit"), /Desktop IPC/);
  assert.equal(desktop.stopCalls, 0);
  assert.equal(desktop.quitCompleted, false);
});

test("navigation and redirects cannot replace the application document with arbitrary local files", async () => {
  const desktop = await desktopHarness(false);
  const contents = desktop.window.webContents;
  for (const eventName of ["will-navigate", "will-redirect"]) {
    for (const url of ["file:///tmp/untrusted.html", "https://example.invalid/"]) {
      let prevented = false;
      contents.emit(eventName, { preventDefault: () => { prevented = true; } }, url);
      assert.equal(prevented, true);
    }
    let prevented = false;
    contents.emit(eventName, { preventDefault: () => { prevented = true; } }, `${contents.mainFrame.url}#main`);
    assert.equal(prevented, false);
  }
  let prevented = false;
  contents.emit("will-attach-webview", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(desktop.window.openHandler({ url: "file:///Applications/Terminal.app" }).action, "deny");
  assert.equal(desktop.externalUrls.length, 0);
  assert.equal(desktop.window.openHandler({ url: "https://github.com/o-raskin/axle-app" }).action, "deny");
  assert.deepEqual(desktop.externalUrls, ["https://github.com/o-raskin/axle-app"]);
});
