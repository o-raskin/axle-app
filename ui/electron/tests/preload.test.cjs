const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { vmCoverageFilename } = require("./helpers/vm-coverage.cjs");
const { transformSync } = require("esbuild");

function preloadHarness() {
  const channels = { getProfiles: "profiles", getStatus: "get-status", startLive: "start", discover: "discover",
    stop: "stop", runCommand: "command", log: "log", status: "status", event: "event" };
  const ipc = new EventEmitter();
  const calls = [];
  ipc.invoke = async (...args) => { calls.push(args); return { ok: true }; };
  let name;
  let api;
  const imports = {
    electron: { contextBridge: { exposeInMainWorld: (key, value) => { name = key; api = value; } }, ipcRenderer: ipc },
    "../shared/bridge": { bridgeIpcChannels: channels }
  };
  const sourceFile = join(__dirname, "../src/preload/index.ts");
  const compiled = transformSync(readFileSync(sourceFile, "utf8"), {
    loader: "ts", format: "cjs", sourcemap: "inline", sourcefile: sourceFile
  }).code;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    require: (id) => { assert.ok(id in imports); return imports[id]; }, module, exports: module.exports
  }, { filename: vmCoverageFilename(compiled, `${sourceFile}.cjs`) });
  return { name, api, calls, ipc, channels };
}

test("preload exposes only the desktop API and preserves declared IPC arguments", async () => {
  const { name, api, calls } = preloadHarness();
  assert.equal(name, "legoBridgeUi");
  const options = { modelId: "tumbler", gamepadId: "auto" };
  const request = { kind: "scanHub", hubAddress: "AB:CD" };
  for (const method of ["quitApp", "discoverHardware", "getBootstrapState", "getSettings", "getBridgeProfiles", "getBridgeStatus", "stopBridge"]) {
    assert.equal((await api[method]()).ok, true);
  }
  await api.updateSettings({ launchFullscreen: true });
  await api.startBridge(options); await api.runBridgeCommand(request);
  assert.deepEqual(calls, [["app:quit"], ["discover"], ["bootstrap:get-state"], ["settings:get"], ["profiles"], ["get-status"], ["stop"],
    ["settings:update", { launchFullscreen: true }], ["start", options], ["command", request]]);
  assert.equal(api.invoke, undefined);
  assert.equal(api.send, undefined);
});

test("preload subscriptions strip privileged event objects and remove only their own listener", () => {
  const { api, ipc, channels } = preloadHarness();
  for (const [method, channel] of [["onBridgeLog", channels.log], ["onBridgeStatus", channels.status], ["onBridgeEvent", channels.event]]) {
    const received = [];
    const otherReceived = [];
    const unsubscribe = api[method]((...args) => received.push(args));
    const otherUnsubscribe = api[method]((data) => otherReceived.push(data));
    const data = { status: "running" };
    ipc.emit(channel, { sender: "privileged" }, data);
    assert.deepEqual(received, [[data]]);
    unsubscribe(); unsubscribe();
    ipc.emit(channel, { sender: "privileged" }, data);
    assert.equal(received.length, 1);
    assert.equal(otherReceived.length, 2);
    otherUnsubscribe();
    assert.equal(ipc.listenerCount(channel), 0);
  }
});
