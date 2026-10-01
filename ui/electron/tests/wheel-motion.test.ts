import assert from "node:assert/strict";
import test from "node:test";

import { deriveVehicleVisualState, WHEEL_FEEDBACK_MAX_AGE_MS } from "../src/renderer/src/lib/vehicleState.ts";
import { WheelMotion, WHEEL_INTERPOLATION_DELAY_MS } from "../src/renderer/src/vehicle/wheelMotion.ts";

const WALL_START = 10_000;
function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-8, `Expected ${expected}, received ${actual}`);
}
function feed(motion: WheelMotion, at: number, position: number,
  patch: Record<string, unknown> = {}, samplePatch: Record<string, unknown> = {}): void {
  const receivedAt = WALL_START + at;
  const state = deriveVehicleVisualState({
    telemetry: {
      model_name: "42239 Batmobile Tumbler", max_drive: 100, max_steering: 100,
      throttle: 0, steering: 0,
      wheel_motion: { source: "encoder", session: "drive-1", position_radians: position,
        sample_time: 30 + at / 1_000, sample_age_ms: 0, ...samplePatch },
      ...patch
    }, selectedModelId: "tumbler", ready: true, receivedAt, now: receivedAt
  });
  motion.update(state, receivedAt, receivedAt, at);
}
function start(): WheelMotion {
  const motion = new WheelMotion();
  motion.setRunning(true, 0);
  feed(motion, 0, 0);
  return motion;
}

test("measured travel is identical at 30, 10 and 1 rendered frames per second", () => {
  for (const fps of [30, 10, 1]) {
    const motion = start();
    const events: Array<{ at: number; feedback: boolean }> = [];
    for (let at = 100; at <= 2_000; at += 100) events.push({ at, feedback: true });
    for (let frame = 1; frame <= fps * 2; frame += 1) events.push({ at: frame * 1_000 / fps, feedback: false });
    events.sort((a, b) => a.at - b.at);
    for (const event of events) {
      if (event.feedback) feed(motion, event.at, event.at / 1_000 * 12);
      else motion.advance(event.at);
    }
    close(motion.advance(2_000), (2_000 - WHEEL_INTERPOLATION_DELAY_MS) / 1_000 * 12);
  }
});

test("the same held trigger can produce any measured rate or a stationary stall", () => {
  for (const actualRate of [0, 2, 8, 14]) {
    const motion = start();
    for (let at = 100; at <= 1_000; at += 100) feed(motion, at, at / 1_000 * actualRate,
      { throttle: 100, trigger_pressure: 1, speed_mode: 3 });
    close(motion.advance(1_000), (1_000 - WHEEL_INTERPOLATION_DELAY_MS) / 1_000 * actualRate);
  }
});

test("boost and speed modes affect animation only through measured movement", () => {
  const motion = start();
  feed(motion, 100, 1, { throttle: 25, boost: false, speed_mode: 1 });
  feed(motion, 200, 3, { throttle: 25, boost: true, speed_mode: 1 });
  close(motion.advance(270), 2);
  close(motion.angularVelocity, 20);
});

test("coasting and residual movement during braking or impact follow the encoder", () => {
  for (const patch of [{ throttle: 0 }, { throttle: 100, brake: true }, { throttle: 0, crash: true }]) {
    const motion = start();
    feed(motion, 100, 0.5, patch);
    feed(motion, 200, 1, patch);
    close(motion.advance(270), 0.75);
  }
});

test("forward and reverse change direction from measured positions", () => {
  const motion = start();
  feed(motion, 100, 1, { throttle: 50 });
  feed(motion, 200, 0, { throttle: -50 });
  close(motion.advance(270), 0.5);
  assert.ok(motion.angularVelocity < 0);
  feed(motion, 300, -1, { throttle: -50 });
  close(motion.advance(420), -1);
});

test("missing measurements never fall back to guessed power-based rotation", () => {
  const motion = start();
  feed(motion, 100, 0, { throttle: 100, boost: true, trigger_pressure: 1, wheel_motion: null });
  close(motion.advance(2_000), 0);
  close(motion.angularVelocity, 0);
});

test("an unchanged measured position stops at its sample boundary despite held throttle", () => {
  const motion = start();
  feed(motion, 100, 1, { throttle: 100 });
  feed(motion, 200, 1, { throttle: 100 });
  close(motion.advance(270), 1);
  close(motion.angularVelocity, 0);
  close(motion.advance(400), 1);
});

test("no extrapolation beyond the last encoder observation", () => {
  const motion = start();
  feed(motion, 100, 1);
  close(motion.advance(10_000), 1);
  close(motion.angularVelocity, 0);
  assert.equal(motion.pending, false);
});

test("duplicate and out-of-order sample times cannot create extra wheel travel", () => {
  const motion = start();
  feed(motion, 100, 1);
  feed(motion, 150, 900, {}, { sample_time: 30.1 });
  feed(motion, 180, -900, {}, { sample_time: 30.05 });
  close(motion.advance(300), 1);
});

test("delayed samples use hub sample time rather than frontend receipt spacing", () => {
  const motion = start();
  feed(motion, 150, 1, {}, { sample_time: 30.1, sample_age_ms: 50 });
  feed(motion, 200, 2);
  close(motion.advance(270), 1.5);
  close(motion.angularVelocity, 10);
});

test("an expired gap and a reconnect establish an origin without replaying missed travel", () => {
  for (const samplePatch of [{}, { session: "drive-2", sample_time: 1 }]) {
    const motion = start();
    feed(motion, 100, 1);
    motion.advance(250);
    feed(motion, 1_000, 800, {}, samplePatch);
    close(motion.advance(1_050), 1);
  }
});

for (const reason of ["hidden", "reduced motion"]) {
  test(`${reason} pauses without catching up missed motion on resume`, () => {
    const motion = start();
    feed(motion, 100, 1);
    motion.advance(250);
    motion.setRunning(false, 250);
    feed(motion, 300, 10);
    feed(motion, 400, 20);
    close(motion.advance(500), 1);
    motion.setRunning(true, 500);
    feed(motion, 500, 30);
    feed(motion, 600, 31);
    close(motion.advance(720), 2);
  });
}

test("stale or future sample ages clear motion immediately", () => {
  for (const sample_age_ms of [-1, WHEEL_FEEDBACK_MAX_AGE_MS + 1]) {
    const motion = start();
    feed(motion, 100, 1);
    const before = motion.advance(200);
    feed(motion, 200, 2, {}, { sample_age_ms });
    close(motion.advance(500), before);
    close(motion.angularVelocity, 0);
  }
});

test("production 200ms telemetry with aged encoder samples preserves rolling in forward, reverse and boost", () => {
  for (const [rate, throttle, boost] of [[5, 30, false], [-5, -30, false], [12, 30, true]] as const) {
    const motion = start();
    for (let at = 200; at <= 2000; at += 200) {
      feed(motion, at, rate * at / 1000, { throttle, boost }, { sample_age_ms: 150 });
      motion.advance(at + 180);
    }
    assert.ok(Math.abs(motion.rotation) > 5);
    assert.equal(Math.sign(motion.rotation), Math.sign(rate));
  }
});
