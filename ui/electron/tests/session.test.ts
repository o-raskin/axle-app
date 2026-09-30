import assert from "node:assert/strict";
import test from "node:test";

import {
  commandResultMessage,
  deriveConnection,
  friendlyError,
  setupReadiness,
  updateLiveReadiness,
  type ConnectionInput
} from "../src/renderer/src/lib/session.ts";

const progress = (controller = true, vehicle = true, ready = true) => ({
  protocol: "lego-technic-bridge" as const,
  version: 1 as const,
  type: "setup/progress" as const,
  timestamp: "2026-09-29T12:00:00Z",
  stage: "ready" as const,
  title: "Hardware ready",
  message: "Hardware connected",
  steps: [
    { label: "Bluetooth enabled", done: true },
    { label: "Gamepad controller detected", done: controller },
    { label: "Technic Move Hub connected", done: vehicle },
    { label: "Live drive session ready", done: ready }
  ]
});

const input = (changes: Partial<ConnectionInput> = {}): ConnectionInput => ({
  snapshot: { status: "running", operation: "live" },
  progress: null,
  pendingAction: null,
  liveTelemetryReceived: false,
  sessionWasReady: false,
  actionError: null,
  ...changes
});

test("a running process does not imply connected hardware", () => {
  const state = deriveConnection(input());
  assert.equal(state.phase, "connecting");
  assert.equal(state.controllerReady, false);
  assert.equal(state.vehicleReady, false);
});

test("ready checklist waits for post-calibration vehicle telemetry", () => {
  const state = deriveConnection(input({ progress: progress() }));
  assert.equal(state.phase, "connecting");
  assert.equal(state.title, "Preparing your vehicle");
});

test("ready hardware with confirmed vehicle telemetry can drive", () => {
  const state = deriveConnection(input({ progress: progress(), liveTelemetryReceived: true }));
  assert.equal(state.phase, "ready");
  assert.equal(state.controllerReady, true);
  assert.equal(state.vehicleReady, true);
});

test("fresh live telemetry recovers an existing drive after a renderer reload", () => {
  assert.equal(deriveConnection(input({ liveTelemetryReceived: true })).phase, "ready");
});

test("reconnection checklist overrides retained telemetry and readiness", () => {
  const state = deriveConnection(input({
    progress: { ...progress(false, true, false), stage: "waiting_for_gamepad" },
    liveTelemetryReceived: true,
    sessionWasReady: true
  }));
  assert.equal(state.phase, "connecting");
  assert.equal(state.title, "Let’s reconnect");
  assert.equal(state.controllerReady, false);
  assert.equal(state.vehicleReady, true);
  assert.match(state.description, /Control is paused/);
});

test("misleading ready stage cannot hide a vehicle model mismatch", () => {
  const mismatch = {
    ...progress(true, true, false),
    title: "Hub connected, but this is not ready to drive",
    message: "The bridge connected to a hub, but the expected model ports are missing."
  };
  const state = deriveConnection(input({
    progress: mismatch,
    snapshot: { status: "exited", operation: "live", exitCode: 0 }
  }));
  assert.equal(state.phase, "error");
  assert.equal(state.title, "Check your vehicle model");
});

test("device checks never appear as live driving, including successful probes", () => {
  const state = deriveConnection(input({
    snapshot: { status: "running", operation: "probeGamepad" },
    progress: progress(true, false, true),
    liveTelemetryReceived: true
  }));
  assert.equal(state.phase, "diagnostic");
  assert.equal(state.vehicleReady, false);
});

test("Bluetooth waiting tells the user the next action without raw error details", () => {
  const state = deriveConnection(input({ progress: {
    ...progress(false, false, false),
    stage: "waiting_for_bluetooth",
    steps: [{ label: "Bluetooth enabled", done: false }]
  } }));
  assert.equal(state.title, "Turn on Bluetooth");
  assert.equal(state.bluetoothReady, false);
});

test("permission errors have a recovery instruction instead of a stack trace", () => {
  const state = deriveConnection(input({ progress: {
    ...progress(false, false, false),
    stage: "waiting_for_bluetooth",
    detail: "BleakError: Bluetooth permission denied at /private/runtime.py:19"
  } }));
  assert.equal(state.title, "Allow Bluetooth access");
  assert.match(state.description, /system settings/);
  assert.doesNotMatch(state.description, /BleakError|private|runtime.py/);
});

test("a stopped drive never retains connected badges from its last frame", () => {
  const state = deriveConnection(input({
    snapshot: { status: "exited", operation: "live", exitCode: 0 },
    progress: progress(),
    liveTelemetryReceived: true,
    sessionWasReady: true
  }));
  assert.equal(state.phase, "disconnected");
  assert.equal(state.controllerReady, false);
  assert.equal(state.vehicleReady, false);
});

test("stop is reflected immediately even before a status callback", () => {
  assert.equal(deriveConnection(input({ pendingAction: "stop", progress: progress(), liveTelemetryReceived: true })).phase, "stopping");
});

test("unexpected errors keep technical details out of consumer copy", () => {
  const message = friendlyError(new Error("Unexpected RuntimeError 0x194 at /Users/person/bridge.py:52"));
  assert.match(message, /try again/);
  assert.doesNotMatch(message, /RuntimeError|0x194|Users/);
  assert.match(friendlyError("RPC failure", "stop"), /turn off the vehicle/);
});

test("readiness follows checklist flags even if stage reports ready", () => {
  assert.equal(setupReadiness(progress(true, false, false)).liveReady, false);
  assert.equal(setupReadiness(progress(true, false, false)).vehicleReady, false);
});

test("failed command results report failure without presenting payload data", () => {
  const message = commandResultMessage({
    protocol: "lego-technic-bridge", version: 1, timestamp: "2026-09-29T12:00:00Z",
    type: "command/result", command: "scanHub", ok: false, payload: { internal: "0x199" }
  });
  assert.match(message, /could not finish/);
  assert.doesNotMatch(message, /0x199/);
});

test("a new ready checklist revokes earlier telemetry until a new live frame arrives", () => {
  const snapshot = { status: "running" as const, operation: "live" as const };
  const ready = progress();
  const readiness = updateLiveReadiness(true, ready, snapshot, ready);
  assert.equal(readiness, false);
  const frame = {
    protocol: "lego-technic-bridge" as const, version: 1 as const, timestamp: ready.timestamp,
    type: "telemetry" as const, telemetry: { model_name: "Test vehicle", throttle: 0 }
  };
  assert.equal(updateLiveReadiness(readiness, frame, snapshot, ready), true);
  assert.equal(updateLiveReadiness(false, frame, snapshot, progress(false, true, false)), false);
  assert.equal(updateLiveReadiness(false, {
    ...frame, telemetry: { kind: "gamepadProbe", model_name: "Test vehicle" }
  }, snapshot, ready), false);
});

test("a failed stop remains actionable rather than indefinitely showing stopping", () => {
  const error = friendlyError("Permission denied stopping process", "stop");
  const state = deriveConnection(input({
    snapshot: { status: "stopping", operation: "live" }, actionError: error
  }));
  assert.equal(state.phase, "error");
  assert.match(state.description, /Try Stop again/);
  assert.match(state.description, /turn off the vehicle/);
});

test("a scan result reports the result without promising drive readiness", () => {
  const message = commandResultMessage({
    protocol: "lego-technic-bridge", version: 1, timestamp: "2026-09-29T12:00:00Z",
    type: "command/result", command: "scanHub", ok: true, payload: { portMap: {} }
  });
  assert.equal(message, "Vehicle scan complete. Results are available below.");
});
