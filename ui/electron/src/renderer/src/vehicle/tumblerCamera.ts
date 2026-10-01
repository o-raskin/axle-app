import type { VehiclePart, VehicleVisualState } from "../lib/vehicleState";

export type CameraView = "overview" | "combined" | VehiclePart;
export type CameraIntent = { view: CameraView; steeringBias: number; moving: boolean };
export type CameraShot = { offset: [number, number, number]; focus: VehiclePart | "overview" };

// +Z is forward. Drive/boost are rear chase views; reverse looks into the open
// cockpit from the front. An elevated side view accommodates opposing effects.
export const CAMERA_SHOTS: Record<CameraView, CameraShot> = {
  overview: { offset: [5.2, 2.75, 5.8], focus: "overview" },
  steering: { offset: [6.2, 2.7, 5.3], focus: "steering" },
  drive: { offset: [4.8, 2.9, -7.6], focus: "overview" },
  reverse: { offset: [-5.8, 5.6, 4.0], focus: "reverse" },
  lights: { offset: [-4.5, 2.8, 6.5], focus: "lights" },
  attack: { offset: [4.6, 3.2, 6.7], focus: "lights" },
  boost: { offset: [5.3, 2.7, -7.6], focus: "overview" },
  combined: { offset: [8.8, 5.8, 1.4], focus: "overview" }
};

/** One composition for all resolved controls, rather than cycling through them. */
export function automaticCameraIntent(state: VehicleVisualState): CameraIntent {
  if (!state.live || state.crash) return { view: "overview", steeringBias: 0, moving: false };
  const moving = state.speed !== 0;
  // The drive direction keeps this view steady during reverse-lamp blink gaps.
  const reverse = state.speed < 0 || state.rocketLights;
  const frontEffect = Boolean(state.attack) || (!moving && state.lights);
  let view: CameraView;
  // Reversing keeps the rear green signal in view even with boost or attack.
  if (reverse) view = "reverse";
  else if (frontEffect && state.boost) view = "combined";
  else if (state.attack) view = "attack";
  else if (state.boost) view = "boost";
  else if (moving || state.brake) view = "drive";
  else if (Math.abs(state.steering) > 0.03) view = "steering";
  else if (state.lights) view = "lights";
  else view = "overview";
  return { view, moving, steeringBias: Math.max(-1, Math.min(1, state.steering)) };
}

/** Unwrap a destination around the current orbit to take the shorter arc. */
export function nearestOrbitAngle(current: number, destination: number): number {
  return current + Math.atan2(Math.sin(destination - current), Math.cos(destination - current));
}

export type SpringValue = { value: number; velocity: number };

/** Exact critically damped spring; retaining velocity makes retargeting smooth. */
export function stepCameraSpring(current: SpringValue, destination: number, dt: number): SpringValue {
  const omega = 5.5;
  const elapsed = Math.max(0, dt);
  const displacement = current.value - destination;
  const coefficient = current.velocity + omega * displacement;
  const decay = Math.exp(-omega * elapsed);
  return {
    value: destination + (displacement + coefficient * elapsed) * decay,
    velocity: (current.velocity - omega * coefficient * elapsed) * decay
  };
}

export const CAMERA_INTENT_DWELL_MS = 320;
export const CAMERA_IDLE_DWELL_MS = 1_000;
