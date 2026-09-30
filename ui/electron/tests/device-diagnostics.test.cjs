const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

const compiled = buildSync({
  entryPoints: [path.join(__dirname, "../src/main/bridgeProcessService.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, external: ["electron"]
}).outputFiles[0].text;

function serviceHarness() {
  const execute = vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`, {
    console, process, Date, setTimeout, clearTimeout
  });
  const module = { exports: {} };
  execute((id) => id === "electron" ? { app: {} } : require(id), module, module.exports);
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
