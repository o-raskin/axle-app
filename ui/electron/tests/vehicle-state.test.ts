import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveVehicleVisualState,
  isTumblerModel,
  VEHICLE_FEEDBACK_MAX_AGE_MS,
  WHEEL_FEEDBACK_MAX_AGE_MS,
  type VehicleVisualInput
} from "../src/renderer/src/lib/vehicleState.ts";

const input = (changes: Partial<VehicleVisualInput> = {}): VehicleVisualInput => ({
  telemetry: {
    model_name: "42239 Batmobile Tumbler",
    max_drive: 100,
    max_steering: 100,
    throttle: 0,
    steering: 0,
    front_lights_on: false,
    rocket_lights_on: false,
    flicker: false,
    brake: false,
    boost: false,
    crash: false
  },
  selectedModelId: "tumbler",
  ready: true,
  receivedAt: 10_000,
  now: 10_200,
  ...changes
});

const frame = (telemetry: Record<string, unknown>) => {
  const base = input();
  return deriveVehicleVisualState({ ...base, telemetry: { ...base.telemetry, ...telemetry } });
};

function assertPreview(changes: Partial<VehicleVisualInput>): void {
  const state = deriveVehicleVisualState(input(changes));
  assert.equal(state.live, false);
  assert.equal(state.motionBasis, "none");
  assert.equal(state.speed, 0);
  assert.equal(state.steering, 0);
  assert.equal(state.attack, 0);
  assert.equal(state.lights, false);
  assert.equal(state.boost, false);
  assert.equal(state.activePart, null);
}

test("Tumbler commands retain signed limits without inventing measured wheel movement", () => {
  const state = frame({ throttle: -45, steering: 25, max_steering: 50 });
  assert.equal(state.live, true);
  assert.equal(state.speed, -0.45);
  assert.equal(state.steering, 0.5);
  assert.equal(state.motionBasis, "none");
  assert.equal(state.wheelPosition, null);
  assert.equal(state.activePart, "steering");
  assert.match(state.statusLabel, /Waiting for wheel feedback/);
});

test("validated encoder observations animate independently of drive commands", () => {
  const state = frame({ throttle: 0, brake: true, wheel_motion: {
    source: "encoder", session: "session-1", position_radians: 12,
    sample_time: 30, sample_age_ms: 10
  } });
  assert.equal(state.motionBasis, "encoder");
  assert.deepEqual(state.wheelPosition, { session: "session-1", positionRadians: 12, sampleTime: 30, ageMs: 10 });
  assert.equal(state.statusLabel, "Live wheel feedback");
});

test("malformed or stale encoder observations cannot claim measured movement", () => {
  const base = { source: "encoder", session: "session-1", position_radians: 12,
    sample_time: 30, sample_age_ms: 0 };
  for (const patch of [
    { source: "command" }, { session: "" }, { position_radians: Number.NaN },
    { sample_time: "30" }, { sample_age_ms: -1 }, { sample_age_ms: WHEEL_FEEDBACK_MAX_AGE_MS - 199 }
  ]) {
    const state = frame({ throttle: 100, wheel_motion: { ...base, ...patch } });
    assert.equal(state.wheelPosition, null);
    assert.equal(state.motionBasis, "none");
  }
});

test("command values beyond their configured limits are clamped", () => {
  const state = frame({ throttle: -500, steering: 300 });
  assert.equal(state.speed, -1);
  assert.equal(state.steering, 1);
});

test("controller pressure and an unreported speed field cannot fabricate motion", () => {
  const state = frame({ throttle: 0, speed: 100, trigger_pressure: 1, forward_pressure: 1 });
  assert.equal(state.speed, 0);
  assert.equal(state.activePart, null);
});

test("only resolved light, flicker and boost flags animate effects", () => {
  const state = frame({ front_lights_pressed: true, attack_pressed: true, boost_pressed: true });
  assert.equal(state.lights, false);
  assert.equal(state.attack, 0);
  assert.equal(state.boost, false);
  assert.equal(state.activePart, null);
  assert.equal(frame({ front_lights_on: true }).lights, true);
  assert.equal(frame({ flicker: true }).attack, 1);
  assert.equal(frame({ boost: true }).boost, true);
});

test("reverse green lamps remain distinct from attack and orange boost", () => {
  const state = frame({ throttle: -40, rocket_lights_on: true });
  assert.equal(state.rocketLights, true);
  assert.equal(state.attack, 0);
  assert.equal(state.boost, false);
  assert.equal(state.activePart, "drive");
  assert.equal(frame({ rocket_lights_on: true }).activePart, "reverse", "The reverse optical assemblies have their own camera view");
  assert.equal(frame({ throttle: -1 }).activePart, "drive", "A gentle resolved reverse command still represents movement");
});

test("active effects focus first, followed by steering, drive and lights", () => {
  assert.equal(frame({ flicker: true, boost: true, steering: 50, throttle: 50 }).activePart, "attack");
  assert.equal(frame({ boost: true, steering: 50, throttle: 50 }).activePart, "boost");
  assert.equal(frame({ steering: 50, throttle: 50 }).activePart, "steering");
  assert.equal(frame({ throttle: 50, front_lights_on: true }).activePart, "drive");
  assert.equal(frame({ front_lights_on: true }).activePart, "lights");
});

test("braking stops wheel motion and boost while steering can remain commanded", () => {
  const state = frame({ brake: true, throttle: 80, steering: -20, boost: true });
  assert.equal(state.speed, 0);
  assert.equal(state.steering, -0.2);
  assert.equal(state.brake, true);
  assert.equal(state.boost, false);
});

test("impact lockout suppresses motion and effects without hiding the live impact state", () => {
  const state = frame({ crash: true, throttle: 80, steering: 40, flicker: true,
    front_lights_on: true, rocket_lights_on: true, boost: true });
  assert.equal(state.live, true);
  assert.equal(state.crash, true);
  assert.equal(state.speed, 0);
  assert.equal(state.steering, 0);
  assert.equal(state.attack, 0);
  assert.equal(state.lights, false);
  assert.equal(state.rocketLights, false);
  assert.equal(state.boost, false);
  assert.equal(state.activePart, null);
});

test("freshness expires without another bridge event", () => {
  assert.equal(deriveVehicleVisualState(input({ now: 10_000 + VEHICLE_FEEDBACK_MAX_AGE_MS })).live, true);
  assertPreview({ now: 10_001 + VEHICLE_FEEDBACK_MAX_AGE_MS });
});

test("stopped, disconnected and reconnecting views cannot retain live animation", () => {
  assertPreview({ ready: false, telemetry: { ...input().telemetry, throttle: 100, flicker: true } });
  assertPreview({ receivedAt: null });
  assertPreview({ telemetry: null });
});

test("gamepad diagnostic telemetry and another model cannot animate Tumbler", () => {
  assertPreview({ telemetry: { ...input().telemetry, kind: "gamepadProbe" } });
  assertPreview({ telemetry: { ...input().telemetry, model_name: "Off-road Buggy" } });
  assertPreview({ selectedModelId: "off_road_buggy" });
  assert.equal(isTumblerModel("tumbler"), true);
  assert.equal(isTumblerModel("not_tumbler"), false);
});

test("invalid and future receipt timestamps cannot look like fresh feedback", () => {
  assertPreview({ receivedAt: Number.NaN });
  assertPreview({ receivedAt: Number.POSITIVE_INFINITY });
  assertPreview({ receivedAt: 11_000 });
  assertPreview({ now: Number.NaN });
});

test("malformed commands and absent or invalid limits are never guessed", () => {
  for (const patch of [
    { throttle: "100" }, { throttle: Number.NaN }, { steering: Number.POSITIVE_INFINITY },
    { max_drive: 0 }, { max_steering: -100 }, { max_steering: undefined }
  ]) {
    assertPreview({ telemetry: { ...input().telemetry, ...patch } });
  }
});

test("truthy strings are not accepted as reported boolean flags", () => {
  const state = frame({ brake: "true", boost: "true", crash: "false",
    front_lights_on: "true", flicker: "true" });
  assert.equal(state.brake, false);
  assert.equal(state.boost, false);
  assert.equal(state.crash, false);
  assert.equal(state.lights, false);
  assert.equal(state.attack, 0);
});
