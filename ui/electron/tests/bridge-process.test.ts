import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { BridgeProcessService } from "../src/main/bridgeProcessService";
import { isProcessActive } from "../src/renderer/src/lib/session";
import type { BridgeLogEvent, BridgeProcessSnapshot, BridgeProtocolEvent } from "../src/shared/bridge";

const envelope = { protocol: "lego-technic-bridge", version: 1, timestamp: "2026-10-02T00:00:00Z" };
const catalog = { models: [{ id: "tumbler", name: "Tumbler" }], gamepads: [{ id: "auto", name: "Automatic" }],
  defaults: { model: "tumbler", gamepad: "auto", hubName: "Technic Move" } };
const profilesResult = (payload: unknown = catalog, ok = true) => ({ ...envelope, type: "command/result", command: "profiles", ok, payload });

/** Simulates OS events and separate stdio closure, rather than mocking service methods. */
class FakeChild extends EventEmitter {
  pid = 100;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(signal: string) { this.signals.push(signal); return true; }
  protocol(value: unknown, newline = true) { this.stdout.write(`${JSON.stringify(value)}${newline ? "\n" : ""}`); }
  close(code: number | null = 0, signal: string | null = null) { this.emit("close", code, signal); }
}

function harness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "axle-process-"));
  const resourcesPath = join(directory, "resources");
  mkdirSync(join(resourcesPath, "bridge"), { recursive: true });
  writeFileSync(join(resourcesPath, "bridge", `lego-technic-gamepad-bridge${process.platform === "win32" ? ".exe" : ""}`), "fixture");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const children: FakeChild[] = [];
  const launches: string[][] = [];
  const statuses: BridgeProcessSnapshot[] = [];
  const logs: BridgeLogEvent[] = [];
  const events: BridgeProtocolEvent[] = [];
  let allowed = true;
  const service = new BridgeProcessService({
    canStart: () => allowed,
    publishStatus: (snapshot) => statuses.push(snapshot), publishLog: (event) => logs.push(event), publishEvent: (event) => events.push(event)
  }, { isPackaged: true, resourcesPath, getAppPath: () => directory, getPath: () => join(directory, "data") },
  ((_command: string, args: string[]) => { const child = new FakeChild(); children.push(child); launches.push(args); return child; }) as unknown as typeof spawn);
  return { service, children, launches, statuses, logs, events, allow: (value: boolean) => { allowed = value; },
    prime: async (payload: unknown = catalog) => {
      const result = service.getProfiles();
      children.at(-1)!.protocol(profilesResult(payload)); children.at(-1)!.close();
      return await result;
    } };
}

test("concurrent catalog loads share one worker, validate defaults and cache the result", async (t) => {
  const h = harness(t);
  const first = h.service.getProfiles(); const second = h.service.getProfiles();
  assert.equal(h.children.length, 1);
  assert.equal(h.service.hasActiveProcess(), true);
  const line = JSON.stringify(profilesResult({ ...catalog, defaults: { model: "missing", gamepad: "missing" } }));
  h.children[0].stdout.write(line.slice(0, 47));
  h.children[0].stdout.write(line.slice(47));
  h.children[0].close();
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(one.defaults, catalog.defaults);
  assert.equal(one, two);
  assert.equal(h.service.hasActiveProcess(), false);
  assert.equal(await h.service.getProfiles(), one);
  assert.equal(h.children.length, 1);
});

test("malformed profile output kills its worker and retains ownership until close", async (t) => {
  const h = harness(t);
  const loading = h.service.getProfiles();
  const rejected = assert.rejects(loading, /Malformed Python protocol/);
  h.children[0].stdout.write("{bad json\n");
  await rejected;
  assert.deepEqual(h.children[0].signals, ["SIGKILL"]);
  assert.equal(h.service.hasActiveProcess(), true);
  h.children[0].close(null, "SIGKILL");
  assert.equal(h.service.hasActiveProcess(), false);
  await h.prime();
  assert.equal(h.children.length, 2);
});

test("failed profile commands and missing results cannot masquerade as a valid catalog", async (t) => {
  const h = harness(t);
  for (const event of [profilesResult(catalog, false), { ...envelope, type: "log", message: "no catalog" }]) {
    const loading = h.service.getProfiles();
    const rejected = assert.rejects(loading, /could not read|did not return/);
    h.children.at(-1)!.protocol(event); h.children.at(-1)!.close();
    await rejected;
  }
  assert.equal(h.service.hasActiveProcess(), false);
});

test("profile timeout is deterministic, kills the worker and permits a later retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t);
  const loading = h.service.getProfiles();
  const rejected = assert.rejects(loading, /Timed out/);
  t.mock.timers.tick(10000); await rejected;
  assert.deepEqual(h.children[0].signals, ["SIGKILL"]);
  h.children[0].close(null, "SIGKILL");
  await h.prime();
});

test("application shutdown waits for catalog-worker closure and blocks late launches", async (t) => {
  const h = harness(t);
  const loading = h.service.getProfiles();
  const rejected = assert.rejects(loading, /Python exited/);
  h.allow(false);
  let stopped = false;
  const quitting = h.service.stopForAppQuit().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.deepEqual(h.children[0].signals, ["SIGKILL"]);
  h.children[0].close(null, "SIGKILL");
  await Promise.all([quitting, rejected]);
  assert.equal(h.service.hasActiveProcess(), false);
  const result = await h.service.runCommand({ kind: "gamepadDevices" });
  assert.equal(result.ok, false);
  assert.equal(h.children.length, 1);
});

test("graceful stop is idempotent, serializes cleanup and ignores late running statuses", async (t) => {
  const h = harness(t); await h.prime();
  const started = await h.service.startLive({ modelId: "tumbler", gamepadId: "auto", hubName: "Name; no shell", hubAddress: "AB:CD" });
  assert.equal(started.ok, true);
  const child = h.children[1];
  const control: string[] = [];
  child.stdin.on("data", (data) => control.push(data.toString()));
  const first = h.service.stopActiveProcess(); const second = h.service.stopActiveProcess();
  child.emit("spawn");
  child.protocol({ ...envelope, type: "process/status", status: "running", operation: "live" });
  assert.equal(h.service.getStatus().status, "stopping");
  assert.equal(control.length, 1);
  assert.deepEqual(JSON.parse(control[0]), { protocol: "lego-technic-bridge", version: 1, type: "control/stop" });
  assert.equal((await h.service.runCommand({ kind: "audioDevices" })).ok, false);
  child.close(null, "SIGTERM");
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal(h.service.getStatus().status, "exited");
  assert.equal(h.service.hasActiveProcess(), false);
  assert.ok(h.launches[1].includes("Name; no shell"));
});

test("stuck workers escalate terminate then kill and clear timers after closing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t);
  await h.service.runCommand({ kind: "gamepadDevices" });
  const child = h.children[0];
  const stopping = h.service.stopActiveProcess();
  t.mock.timers.tick(3500);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  t.mock.timers.tick(3500);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  child.close(null, "SIGKILL"); await stopping;
  t.mock.timers.tick(10000);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("process errors retain ownership and the original cause until stdio is closed", async (t) => {
  const h = harness(t);
  await h.service.runCommand({ kind: "gamepadDevices" });
  const child = h.children[0];
  child.emit("error", new Error("spawn ENOENT"));
  assert.equal(h.service.hasActiveProcess(), true);
  assert.equal((await h.service.runCommand({ kind: "audioDevices" })).ok, false);
  child.close(null);
  assert.equal(h.service.getStatus().error, "spawn ENOENT");
  const next = await h.service.runCommand({ kind: "audioDevices" });
  child.emit("spawn");
  assert.equal(h.service.getStatus().sessionId, next.sessionId);
  assert.equal(h.service.getStatus().operation, "audioDevices");
  h.children[1].close();
});

test("JSONL chunks, malformed envelopes and final diagnostic lines preserve observable events", async (t) => {
  const h = harness(t);
  await h.service.runCommand({ kind: "audioDevices" });
  const child = h.children[0]; child.emit("spawn");
  const line = JSON.stringify({ ...envelope, type: "telemetry", telemetry: { throttle: 0.5 } });
  child.stdout.write(line.slice(0, 25)); child.stdout.write(`${line.slice(25)}\r\n`);
  child.stdout.write('{"protocol":"other","version":1}\n');
  child.stderr.write("\u001b[31mfinal diagnostic\u001b[0m");
  child.close(1);
  assert.equal(h.events[0].type, "telemetry");
  assert.equal(h.events[1].type, "error");
  assert.ok(h.logs.some((log) => log.source === "stderr" && log.message === "final diagnostic"));
  assert.equal(h.service.getStatus().status, "error");
});

test("successive same-operation workers always receive distinct session identifiers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const h = harness(t);
  const first = await h.service.runCommand({ kind: "gamepadDevices" }); h.children[0].close();
  const second = await h.service.runCommand({ kind: "gamepadDevices" }); h.children[1].close();
  assert.notEqual(first.sessionId, second.sessionId);
});

test("real subprocess integration loads JSONL profiles and shuts down through the control channel", { timeout: 5000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "axle-real-process-"));
  const resourcesPath = join(directory, "resources");
  mkdirSync(join(resourcesPath, "bridge"), { recursive: true });
  writeFileSync(join(resourcesPath, "bridge", `lego-technic-gamepad-bridge${process.platform === "win32" ? ".exe" : ""}`), "fixture");
  const fixture = join(directory, "bridge.cjs");
  writeFileSync(fixture, `
    const envelope = ${JSON.stringify(envelope)};
    const emit = (event) => process.stdout.write(JSON.stringify({ ...envelope, ...event }) + "\\n");
    if (process.argv.includes("--profiles-json")) {
      emit(${JSON.stringify(profilesResult())});
    } else {
      emit({ type: "process/status", status: "running", operation: "live" });
      emit({ type: "telemetry", telemetry: { model_name: "Tumbler", throttle: 0 } });
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        input += chunk;
        if (input.includes("\\n") && JSON.parse(input).type === "control/stop") {
          emit({ type: "log", level: "info", message: "motor cleanup complete" });
          process.stdin.pause();
        }
      });
    }
  `);
  const logs: BridgeLogEvent[] = [];
  let receiveFrame!: () => void;
  const ready = new Promise<void>((resolve) => { receiveFrame = resolve; });
  const service = new BridgeProcessService({
    publishStatus: () => {}, publishLog: (event) => logs.push(event),
    publishEvent: (event) => { if (event.type === "telemetry") receiveFrame(); }
  }, { isPackaged: true, resourcesPath, getAppPath: () => directory, getPath: () => join(directory, "data") },
  ((_command: string, args: string[], options: Parameters<typeof spawn>[2]) =>
    spawn(process.execPath, [fixture, ...args], options)) as typeof spawn);
  t.after(async () => { await service.stopForAppQuit(); rmSync(directory, { recursive: true, force: true }); });
  assert.deepEqual(await service.getProfiles(), catalog);
  assert.equal((await service.startLive({ modelId: "tumbler", gamepadId: "auto" })).ok, true);
  await ready;
  assert.equal(service.getStatus().status, "running");
  assert.equal((await service.stopActiveProcess()).ok, true);
  assert.equal(service.getStatus().status, "exited");
  assert.equal(service.hasActiveProcess(), false);
  assert.ok(logs.some((event) => event.message === "motor cleanup complete"));
});

test("missing close confirmation reports failure and permits Stop retry without losing worker ownership", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t);
  await h.service.runCommand({ kind: "gamepadDevices" });
  const child = h.children[0];
  const stopping = h.service.stopActiveProcess();
  t.mock.timers.tick(10000);
  assert.equal((await stopping).ok, false);
  assert.equal(h.service.hasActiveProcess(), true);
  assert.match(h.service.getStatus().error!, /did not confirm/);
  assert.equal((await h.service.runCommand({ kind: "audioDevices" })).ok, false);
  assert.equal(child.listenerCount("close"), 1);
  const retry = h.service.stopActiveProcess();
  child.close(null, "SIGKILL");
  assert.equal((await retry).ok, true);
  assert.equal(h.service.hasActiveProcess(), false);
});

test("application quit cannot treat a failed Stop as confirmed vehicle shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t);
  await h.service.runCommand({ kind: "gamepadDevices" });
  const quitting = h.service.stopForAppQuit();
  const rejected = assert.rejects(quitting, /did not confirm/);
  t.mock.timers.tick(10000); await rejected;
  assert.equal(h.service.hasActiveProcess(), true);
  h.children[0].close(null, "SIGKILL");
});

test("catalog workers that never close cannot indefinitely trap application quit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t);
  const loading = h.service.getProfiles();
  const rejectedLoad = assert.rejects(loading, /Timed out/);
  const quitting = h.service.stopForAppQuit();
  const rejectedQuit = assert.rejects(quitting, /profile worker did not confirm/);
  t.mock.timers.tick(10000); await Promise.all([rejectedLoad, rejectedQuit]);
  assert.equal(h.service.hasActiveProcess(), true);
  h.children[0].close(null, "SIGKILL");
});


test("development interpreter discovery skips non-Python and unsupported Python versions", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "axle-python-probe-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const attempts: string[] = [];
  const commands: string[] = [];
  const children: FakeChild[] = [];
  for (const rejectedVersion of ["v25.9.0", "Python 3.8.20"]) {
    attempts.length = 0; commands.length = 0;
    const service = new BridgeProcessService({ publishLog: () => {}, publishStatus: () => {}, publishEvent: () => {} },
      { isPackaged: false, resourcesPath: directory, getAppPath: () => directory, getPath: () => directory },
      ((command: string) => { commands.push(command); const child = new FakeChild(); children.push(child); return child; }) as unknown as typeof spawn,
      ((command: string, args: string[]) => {
        attempts.push(command);
        const usable = command === "py" && args[0] === "-3";
        // All candidates exit successfully, but Python 3.9 is the minimum runtime.
        return { status: 0, stdout: usable ? "" : command === "python" ? "Python 2.7.18" : rejectedVersion,
          stderr: usable ? "Python 3.9.6" : "", pid: 1, signal: null, output: [] };
      }) as unknown as typeof spawnSync);
    const started = await service.runCommand({ kind: "gamepadDevices" });
    assert.equal(started.ok, true);
    assert.deepEqual(commands, ["py"]);
    assert.ok(attempts.includes("python3")); assert.ok(attempts.includes("python"));
    children.at(-1)?.close();
  }
});


test("OS errors on an existing worker preserve active status and PID so Stop remains available", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stopping of [false, true]) {
    const h = harness(t);
    await h.service.runCommand({ kind: "gamepadDevices" });
    const child = h.children[0]; child.emit("spawn");
    t.after(() => child.close(null, "SIGKILL"));
    const stop = stopping ? h.service.stopActiveProcess() : null;
    child.emit("error", new Error("Could not signal the active worker"));
    const snapshot = h.service.getStatus();
    assert.equal(snapshot.status, stopping ? "stopping" : "running");
    assert.equal(snapshot.pid, child.pid);
    assert.equal(snapshot.endedAt, undefined);
    assert.equal(snapshot.error, "Could not signal the active worker");
    assert.equal(isProcessActive(snapshot), true);
    assert.equal(h.service.hasActiveProcess(), true);
    child.close(null, "SIGKILL");
    if (stop) assert.equal((await stop).ok, true);
  }
});

test("a stale async start validation failure cannot hide a newer inventory worker from Stop", async (t) => {
  const h = harness(t);
  const starting = h.service.startLive({ modelId: "unknown", gamepadId: "auto" });
  await Promise.resolve();
  assert.equal(h.children.length, 1);
  assert.equal((await h.service.runCommand({ kind: "gamepadDevices" })).ok, true);
  const child = h.children[1]; child.emit("spawn");
  t.after(() => child.close());
  h.children[0].protocol(profilesResult()); h.children[0].close();
  assert.equal((await starting).ok, false);
  const snapshot = h.service.getStatus();
  assert.equal(snapshot.operation, "gamepadDevices");
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.pid, child.pid);
  assert.equal(snapshot.endedAt, undefined);
  assert.match(snapshot.error!, /Unknown model profile/);
  assert.equal(isProcessActive(snapshot), true);
  assert.equal(h.service.hasActiveProcess(), true);
  child.close();
});
