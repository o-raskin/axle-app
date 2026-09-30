const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

const compiled = buildSync({
  entryPoints: [path.join(__dirname, "../src/main/bridgeProcessService.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, external: ["electron"]
}).outputFiles[0].text;

function harness() {
  const timers = new Map();
  const execute = vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`, {
    console, process: { platform: "win32" }, Date,
    setTimeout(callback, duration) { timers.set(duration, callback); return duration; },
    clearTimeout(timer) { timers.delete(timer); }
  });
  const module = { exports: {} };
  execute((id) => id === "electron" ? { app: {} } : require(id), module, module.exports);
  const service = new module.exports.BridgeProcessService({ publishLog() {}, publishStatus() {}, publishEvent() {} });
  const child = new EventEmitter();
  const signals = [];
  const writes = [];
  child.stdin = new PassThrough();
  child.stdin.on("data", (chunk) => writes.push(chunk.toString()));
  child.kill = (signal) => { signals.push(signal); return true; };
  service.child = child;
  return { service, child, signals, writes, timers };
}

test("Windows stop requests async motor cleanup through stdin before considering forceful signals", async () => {
  const h = harness();
  const stop = h.service.stopActiveProcess();
  const repeatedStop = h.service.stopActiveProcess();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(JSON.parse(h.writes[0]), { protocol: "lego-technic-bridge", version: 1, type: "control/stop" });
  assert.deepEqual(h.signals, []);
  assert.equal(h.service.getStatus().status, "stopping");
  h.child.emit("close", 130, null);
  assert.equal((await stop).ok, true);
  assert.equal((await repeatedStop).ok, true);
  assert.equal(h.timers.size, 0);
});

test("an unresponsive bridge is terminated only after graceful shutdown deadlines", async () => {
  const h = harness();
  const stop = h.service.stopActiveProcess();
  h.timers.get(3500)();
  assert.deepEqual(h.signals, ["SIGTERM"]);
  h.timers.get(7000)();
  assert.deepEqual(h.signals, ["SIGTERM", "SIGKILL"]);
  h.child.emit("close", null, "SIGKILL");
  assert.equal((await stop).ok, true);
  assert.equal(h.timers.size, 0);
});
