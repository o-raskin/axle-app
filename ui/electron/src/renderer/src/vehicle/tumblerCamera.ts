import type { VehiclePart, VehicleVisualState } from "../lib/vehicleState";

export type CameraView = "overview" | "combined" | VehiclePart;
export type CameraIntent = { view: CameraView; steeringBias: number; moving: boolean };
export type CameraShot = { offset: [number, number, number]; focus: VehiclePart | "overview"; targetYOffset?: number };

// +Z is forward. Drive/boost are rear chase views; reverse looks into the open
// cockpit from the front. An elevated side view accommodates opposing effects.
export const CAMERA_SHOTS: Record<CameraView, CameraShot> = {
  overview: { offset: [4.25, 1.95, 4.85], focus: "overview", targetYOffset: -0.3 },
  steering: { offset: [4.6, 1.35, 3.5], focus: "steering" },
  drive: { offset: [3.8, 1.6, -6.2], focus: "overview", targetYOffset: -0.3 },
  reverse: { offset: [-5.1, 4.95, 3.52], focus: "reverse" },
  lights: { offset: [-3.7, 1.6, 4.8], focus: "lights" },
  attack: { offset: [3.9, 2.6, 5.0], focus: "lights" },
  boost: { offset: [3.9, 1.4, -6.0], focus: "overview", targetYOffset: -0.3 },
  combined: { offset: [7.25, 3.7, 1.15], focus: "overview", targetYOffset: -0.3 }
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
export const CAMERA_FRAMING_MIN_ASPECT = 1.55;
