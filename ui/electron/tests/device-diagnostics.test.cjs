const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { vmCoverageFilename } = require("./helpers/vm-coverage.cjs");
const { buildSync } = require("esbuild");

const compiled = buildSync({
  entryPoints: [path.join(__dirname, "../src/main/bridgeProcessService.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, external: ["electron"],
  sourcemap: "inline", sourceRoot: `${path.resolve(__dirname, "../")}/`,
  absWorkingDir: path.resolve(__dirname, "../")
}).outputFiles[0].text;

function serviceHarness() {
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    require: (id) => id === "electron" ? { app: {} } : require(id), module, exports: module.exports,
    console, process, Date, setTimeout, clearTimeout
  }, { filename: vmCoverageFilename(compiled, path.join(__dirname, "../src/main/bridgeProcessService.ts.cjs")) });
  const events = [];
  const starts = [];
  const service = new module.exports.BridgeProcessService({
    publishLog: (event) => events.push(event), publishStatus: (event) => events.push(event), publishEvent() {}
  });
  let profileRequests = 0;
  service.getProfiles = async () => {
    profileRequests += 1;
    throw new Error("The model catalog is corrupt");
  };
  service.startManagedProcess = async (kind, args) => {
    starts.push({ kind, args: Array.from(args) });
    return { ok: true, sessionId: "diagnostic-test" };
  };
  return { service, starts, events, get profileRequests() { return profileRequests; } };
}

for (const [kind, flag] of [["gamepadDevices", "--gamepad-devices"], ["audioDevices", "--audio-devices"]]) {
  test(`${kind} remains available when the profile catalog cannot load`, async () => {
    const harness = serviceHarness();
    const result = await harness.service.runCommand({ kind });
    assert.equal(result.ok, true);
    assert.equal(harness.profileRequests, 0);
    assert.deepEqual(harness.starts, [{ kind, args: [flag] }]);
  });
}

test("controller input probing still requires a valid controller profile", async () => {
  const harness = serviceHarness();
  const result = await harness.service.runCommand({ kind: "probeGamepad" });
  assert.equal(result.ok, false);
  assert.equal(harness.profileRequests, 1);
  assert.equal(harness.starts.length, 0);
});

test("device inventory cannot start alongside an active session", async () => {
  const harness = serviceHarness();
  harness.service.child = {};
  const result = await harness.service.runCommand({ kind: "audioDevices" });
  assert.equal(result.ok, false);
  assert.equal(harness.starts.length, 0);
  assert.equal(harness.profileRequests, 0);
});

test("startup discovery does not select a model or arm the driving engine", async () => {
  const harness = serviceHarness();
  harness.service.getProfiles = async () => ({ defaults: { hubName: "Technic Move" } });
  assert.equal((await harness.service.startDiscovery()).ok, true);
  assert.deepEqual(harness.starts, [{ kind: "discover", args: ["--discover", "--name", "Technic Move"] }]);
});

test("a diagnostic waits for background discovery to close before starting", async () => {
  const harness = serviceHarness();
  harness.service.child = {};
  harness.service.currentSnapshot = { status: "running", operation: "discover" };
  let closed = false;
  harness.service.stopForAppQuit = async () => {
    assert.equal(harness.starts.length, 0);
    harness.service.child = null;
    closed = true;
  };
  assert.equal((await harness.service.runCommand({ kind: "audioDevices" })).ok, true);
  assert.equal(closed, true);
  assert.deepEqual(harness.starts, [{ kind: "audioDevices", args: ["--audio-devices"] }]);
});

test("shutdown guard also rejects a startup already awaiting its profile catalog", async () => {
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    require: (id) => id === "electron" ? { app: {} } : require(id), module, exports: module.exports,
    console, process, Date, setTimeout, clearTimeout
  }, { filename: vmCoverageFilename(compiled, path.join(__dirname, "../src/main/bridgeProcessService.ts.cjs")) });
  let allowed = true;
  const service = new module.exports.BridgeProcessService({
    canStart: () => allowed, publishLog() {}, publishStatus() {}, publishEvent() {}
  });
  let finish;
  service.getProfiles = () => new Promise((resolve) => { finish = resolve; });
  const starting = service.startLive({ modelId: "tumbler", gamepadId: "auto" });
  await new Promise((resolve) => setImmediate(resolve));
  allowed = false;
  finish({ models: [{ id: "tumbler" }], gamepads: [{ id: "auto" }], defaults: { model: "tumbler", gamepad: "auto", hubName: "Technic Move" } });
  assert.equal((await starting).ok, false);
  assert.equal(service.hasActiveProcess(), false);
});
