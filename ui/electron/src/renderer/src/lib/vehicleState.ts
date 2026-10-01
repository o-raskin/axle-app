export type VehiclePart = "steering" | "drive" | "attack" | "lights" | "boost" | "reverse";

/** The bridge sends a frame every 100 ms. Expire controls if the stream stops. */
export const VEHICLE_FEEDBACK_MAX_AGE_MS = 1_500;
export const WHEEL_FEEDBACK_MAX_AGE_MS = 600;

export type WheelPositionFeedback = {
  session: string;
  positionRadians: number;
  sampleTime: number;
  ageMs: number;
};

export type VehicleVisualState = {
  /** Normalized steering command: positive is driver's right, negative is left. */
  steering: number;
  /** Normalized drive command, not measured vehicle velocity. */
  speed: number;
  /** The reported PLAYVM flicker command. It does not describe an actuator position. */
  attack: number;
  lights: boolean;
  rocketLights: boolean;
  brake: boolean;
  boost: boolean;
  crash: boolean;
  activePart: VehiclePart | null;
  live: boolean;
  wheelPosition: WheelPositionFeedback | null;
  motionBasis: "encoder" | "none";
  statusLabel: string;
};

export type VehicleVisualInput = {
  telemetry: Record<string, unknown> | null;
  selectedModelId: string;
  ready: boolean;
  receivedAt: number | null;
  now?: number;
};

export function isTumblerModel(modelId: string): boolean {
  return modelId === "tumbler";
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizedCommand(value: unknown, limit: unknown): number | null {
  if (!finiteNumber(value) || !finiteNumber(limit) || limit <= 0) return null;
  return Math.max(-1, Math.min(1, value / limit));
}

function preview(statusLabel: string): VehicleVisualState {
  return {
    steering: 0,
    speed: 0,
    attack: 0,
    lights: false,
    rocketLights: false,
    brake: false,
    boost: false,
    crash: false,
    activePart: null,
    live: false,
    wheelPosition: null,
    motionBasis: "none",
    statusLabel
  };
}

/**
 * Tumbler telemetry describes the bridge's resolved commands and impact lockout.
 * Wheel travel comes from the hub's drive encoders. Steering and effects still
 * describe commands. A disconnected view is a neutral model preview.
 */
export function deriveVehicleVisualState({
  telemetry, selectedModelId, ready, receivedAt, now = Date.now()
}: VehicleVisualInput): VehicleVisualState {
  if (!isTumblerModel(selectedModelId) || !ready) return preview("Vehicle preview");
  if (!telemetry || receivedAt === null) return preview("Waiting for vehicle feedback");
  if (!finiteNumber(receivedAt) || !finiteNumber(now)
    || now < receivedAt || now - receivedAt > VEHICLE_FEEDBACK_MAX_AGE_MS) {
    return preview("Vehicle feedback paused");
  }
  if (telemetry.kind === "gamepadProbe"
    || telemetry.model_name !== "42239 Batmobile Tumbler") {
    return preview("Waiting for Tumbler feedback");
  }

  const steeringCommand = normalizedCommand(telemetry.steering, telemetry.max_steering);
  const driveCommand = normalizedCommand(telemetry.throttle, telemetry.max_drive);
  if (steeringCommand === null || driveCommand === null) return preview("Waiting for vehicle feedback");

  const crash = telemetry.crash === true;
  const brake = !crash && telemetry.brake === true;
  const steering = crash ? 0 : steeringCommand;
  const speed = crash || brake ? 0 : driveCommand;
  const attack = !crash && telemetry.flicker === true ? 1 : 0;
  const lights = !crash && telemetry.front_lights_on === true;
  const rocketLights = !crash && telemetry.rocket_lights_on === true;
  const boost = !crash && !brake && telemetry.boost === true;
  const wheel = telemetry.wheel_motion;
  let wheelPosition: WheelPositionFeedback | null = null;
  if (wheel !== null && typeof wheel === "object") {
    const value = wheel as Record<string, unknown>;
    if (value.source === "encoder" && typeof value.session === "string" && value.session.length > 0
      && finiteNumber(value.position_radians) && finiteNumber(value.sample_time)
      && finiteNumber(value.sample_age_ms) && value.sample_age_ms >= 0
      && value.sample_age_ms + now - receivedAt <= WHEEL_FEEDBACK_MAX_AGE_MS) {
      wheelPosition = {
        session: value.session, positionRadians: value.position_radians,
        sampleTime: value.sample_time, ageMs: value.sample_age_ms
      };
    }
  }
  const activePart: VehiclePart | null = crash ? null
    : attack ? "attack"
      : boost ? "boost"
        : Math.abs(steering) > 0.03 ? "steering"
          : speed !== 0 || brake ? "drive"
            : lights ? "lights" : rocketLights ? "reverse" : null;

  return {
    steering, speed, attack, lights, rocketLights, brake, boost, crash,
    activePart, live: true, wheelPosition, motionBasis: wheelPosition ? "encoder" : "none",
    statusLabel: crash ? "Impact detected · control paused"
      : wheelPosition ? "Live wheel feedback" : "Waiting for wheel feedback"
  };
}
