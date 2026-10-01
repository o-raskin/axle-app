import assert from "node:assert/strict";
import test from "node:test";

import type { VehicleVisualState } from "../src/renderer/src/lib/vehicleState.ts";
import {
  automaticCameraIntent,
  CAMERA_SHOTS,
  nearestOrbitAngle,
  stepCameraSpring,
  type SpringValue
} from "../src/renderer/src/vehicle/tumblerCamera.ts";

function feedback(changes: Partial<VehicleVisualState> = {}): VehicleVisualState {
  return {
    steering: 0, speed: 0, attack: 0, lights: false, rocketLights: false,
    brake: false, boost: false, crash: false, activePart: null, live: true,
    motionBasis: "commanded", statusLabel: "Live command feedback", ...changes
  };
}

function near(actual: number, expected: number, tolerance = 1e-10): void {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `Expected ${expected} ± ${tolerance}, received ${actual}`);
}

function advance(initial: SpringValue, destination: number, steps: number[]): SpringValue {
  return steps.reduce((current, elapsed) => stepCameraSpring(current, destination, elapsed), initial);
}

test("simultaneous front effects and boost compose a single view rather than cycling parts", () => {
  for (const state of [
    feedback({ lights: true, boost: true }),
    feedback({ attack: 1, boost: true }),
    feedback({ speed: 0.8, steering: -0.6, attack: 1, boost: true, lights: true, activePart: "attack" })
  ]) {
    const intent = automaticCameraIntent(state);
    assert.equal(intent.view, "combined");
    assert.equal(intent.steeringBias, state.steering);
    assert.equal(intent.moving, state.speed !== 0);
  }
  const wide = CAMERA_SHOTS.combined.offset;
  assert.ok(Math.abs(wide[0]) > Math.abs(wide[2]), "Opposing front and rear effects need a side composition");
  assert.ok(Math.hypot(...wide) > Math.hypot(...CAMERA_SHOTS.overview.offset), "Combined controls must preserve room for the entire assembly");
});

test("forward drive, steering, and boost keep a chase composition with steering bias", () => {
  const intent = automaticCameraIntent(feedback({
    speed: 0.75, steering: 0.55, lights: true, boost: true, activePart: "steering"
  }));
  assert.deepEqual(intent, { view: "boost", moving: true, steeringBias: 0.55 });
  assert.ok(CAMERA_SHOTS.boost.offset[2] < 0, "Forward boost needs a view from behind the jet");
  assert.equal(CAMERA_SHOTS.boost.focus, "overview", "A moving chase view must keep the whole car in frame");
  assert.deepEqual(automaticCameraIntent(feedback({ speed: 0.75, steering: -0.4, lights: true })),
    { view: "drive", moving: true, steeringBias: -0.4 });
  for (const speed of [0.01, 0.02]) {
    assert.deepEqual(automaticCameraIntent(feedback({ speed, lights: true })),
      { view: "drive", moving: true, steeringBias: 0 },
      "Low-power forward commands still need the moving chase view rather than a stationary lamp view");
  }
});

test("reverse direction holds its camera through both phases of the reverse-light blink", () => {
  for (const speed of [-0.01, -0.02, -0.65]) {
    const states = [false, true, false, true, false].map((rocketLights) => feedback({
      speed, steering: 0.3, rocketLights, activePart: rocketLights ? "reverse" : "drive"
    }));
    const intents = states.map(automaticCameraIntent);
    for (const intent of intents) assert.deepEqual(intent, { view: "reverse", moving: true, steeringBias: 0.3 },
      `Reverse at ${Math.abs(speed) * 100}% power must retain its direction through dark blink phases`);
    const boosted = states.map((state) => automaticCameraIntent({ ...state, boost: true }));
    for (const intent of boosted) assert.equal(intent.view, "reverse", "Boost must retain the reverse composition and its rear green signal");
    assert.equal(automaticCameraIntent({ ...states[0], boost: true, attack: 1 }).view, "reverse",
      "Concurrent effects must not hide the reversing signal");
  }
  assert.ok(CAMERA_SHOTS.reverse.offset[2] > 0, "Reverse needs the opposite end from the forward chase view");
  assert.equal(CAMERA_SHOTS.reverse.focus, "reverse");
});

test("isolated effects and braking reveal their own physical assemblies", () => {
  assert.equal(automaticCameraIntent(feedback({ steering: -0.7 })).view, "steering");
  assert.equal(automaticCameraIntent(feedback({ lights: true })).view, "lights");
  assert.equal(automaticCameraIntent(feedback({ attack: 1 })).view, "attack");
  assert.equal(automaticCameraIntent(feedback({ rocketLights: true })).view, "reverse");
  assert.deepEqual(automaticCameraIntent(feedback({ brake: true })),
    { view: "drive", moving: false, steeringBias: 0 });
});

test("paused feedback and impact lockout cannot move the camera toward lingering commands", () => {
  const lingering = feedback({ speed: -0.8, steering: 0.7, attack: 1, boost: true, lights: true, rocketLights: true });
  assert.deepEqual(automaticCameraIntent({ ...lingering, live: false }),
    { view: "overview", moving: false, steeringBias: 0 });
  assert.deepEqual(automaticCameraIntent({ ...lingering, crash: true }),
    { view: "overview", moving: false, steeringBias: 0 });
});

test("orbit destinations unwrap across the angular seam without a full revolution", () => {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  near(nearestOrbitAngle(radians(179), radians(-179)), radians(181));
  near(nearestOrbitAngle(radians(-179), radians(179)), radians(-181));
  for (const current of [-7 * Math.PI, -0.5, 0.5, 9 * Math.PI]) {
    for (const destination of [-2.8, 0, 2.8]) {
      const unwrapped = nearestOrbitAngle(current, destination);
      assert.ok(Math.abs(unwrapped - current) <= Math.PI + 1e-12);
      near(Math.sin(unwrapped), Math.sin(destination));
      near(Math.cos(unwrapped), Math.cos(destination));
    }
  }
});

test("the camera spring reaches the same pose and velocity at 30, 60, and 120 frames per second", () => {
  const initial = { value: -2.7, velocity: 1.8 };
  const elapsed = 1.5;
  const destination = 3.9;
  const exact = stepCameraSpring(initial, destination, elapsed);
  for (const framesPerSecond of [30, 60, 120]) {
    const result = advance(initial, destination, Array.from({ length: elapsed * framesPerSecond }, () => 1 / framesPerSecond));
    near(result.value, exact.value);
    near(result.velocity, exact.velocity);
  }
  const irregular = [0.04, 0.013, 0.1, 0.007, 0.29, 0.55, 0.5];
  near(irregular.reduce((sum, value) => sum + value, 0), elapsed);
  const result = advance(initial, destination, irregular);
  near(result.value, exact.value);
  near(result.velocity, exact.velocity);
});

test("retargeting preserves ongoing velocity and starts the new composition without a jump", () => {
  const moving = stepCameraSpring({ value: 10, velocity: 0 }, -2, 0.2);
  assert.ok(Math.abs(moving.velocity) > 1, "The fixture must be in the middle of a camera movement");
  const retargeted = stepCameraSpring(moving, 8, 0);
  near(retargeted.value, moving.value);
  near(retargeted.velocity, moving.velocity);
  const elapsed = 1e-6;
  const next = stepCameraSpring(moving, 8, elapsed);
  near((next.value - moving.value) / elapsed, moving.velocity, 0.0005);
  assert.ok(next.value < moving.value, "An existing inward velocity must not suddenly reset on a new target");
  const settled = stepCameraSpring(next, 8, 5);
  near(settled.value, 8, 1e-8);
  near(settled.velocity, 0, 1e-8);
});

test("springing orbit radius keeps every preset transition outside the vehicle envelope", () => {
  // The assembly is roughly 6×3.5×2.2 display units. A 4.5-unit camera clearance
  // exceeds its bounding sphere; presets and intermediate orbital radii should
  // retain that clearance instead of interpolating a chord through the body.
  const minimumClearance = 4.5;
  for (const start of Object.values(CAMERA_SHOTS)) {
    const initialRadius = Math.hypot(...start.offset);
    assert.ok(initialRadius >= 8.2);
    for (const end of Object.values(CAMERA_SHOTS)) {
      const destination = Math.hypot(...end.offset);
      let radius = { value: initialRadius, velocity: 0 };
      for (let frame = 0; frame < 240; frame += 1) {
        radius = stepCameraSpring(radius, destination, 1 / 60);
        assert.ok(radius.value > minimumClearance, "An orbital transition cannot enter the car");
        assert.ok(radius.value >= Math.min(initialRadius, destination) - 1e-10,
          "A resting critically damped radius must not overshoot inside its closer preset");
      }
      near(radius.value, destination, 1e-7);
    }
  }
});
