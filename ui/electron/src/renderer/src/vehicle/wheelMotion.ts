import { WHEEL_FEEDBACK_MAX_AGE_MS, type VehicleVisualState } from "../lib/vehicleState";

// Draw between actual encoder samples, with a short buffer for polling and transport latency.
// Never extrapolate power into RPM: stalled, coasting and boosted wheels must
// follow the distance the drivetrain actually travelled.
export const WHEEL_INTERPOLATION_DELAY_MS = 120;
type Point = { time: number; position: number; sampleTime: number };

export class WheelMotion {
  rotation = 0;
  angularVelocity = 0;
  private points: Point[] = [];
  private session: string | null = null;
  private positionOffset = 0;
  private timeOffset = 0;
  private expiresAt = 0;
  private running = false;

  get pending(): boolean {
    return this.angularVelocity !== 0 || this.points.some((point) => Math.abs(point.position - this.rotation) > 1e-8);
  }

  advance(animationTime: number): number {
    this.angularVelocity = 0;
    if (!this.running || this.points.length === 0) return this.rotation;
    const time = Math.min(animationTime, this.expiresAt) - WHEEL_INTERPOLATION_DELAY_MS;
    while (this.points.length > 1 && this.points[1].time <= time) this.points.shift();
    const first = this.points[0];
    const next = this.points[1];
    if (!next || time <= first.time) {
      this.rotation = first.position;
      return this.rotation;
    }
    const fraction = Math.max(0, Math.min(1, (time - first.time) / (next.time - first.time)));
    this.rotation = first.position + (next.position - first.position) * fraction;
    if (animationTime <= this.expiresAt) {
      this.angularVelocity = (next.position - first.position) / ((next.time - first.time) / 1_000);
    }
    return this.rotation;
  }

  update(state: VehicleVisualState, receivedAt: number | null, wallTime: number, animationTime: number): void {
    this.advance(animationTime);
    const sample = state.wheelPosition;
    const age = receivedAt === null ? Infinity : wallTime - receivedAt + (sample?.ageMs ?? 0);
    if (!state.live || !sample || age < 0 || age > WHEEL_FEEDBACK_MAX_AGE_MS) {
      this.points = [];
      this.session = null;
      this.angularVelocity = 0;
      return;
    }
    const last = this.points.at(-1);
    // A stale packet cannot shorten or extend the lifetime of newer feedback.
    if (this.running && this.session === sample.session && last && sample.sampleTime <= last.sampleTime) return;
    this.expiresAt = animationTime + WHEEL_FEEDBACK_MAX_AGE_MS - age;
    // A new session starts from the visible pose. Hidden/reduced-motion
    // intervals also establish an origin without replaying missed travel.
    if (!this.running || this.session !== sample.session || !last
      || animationTime - last.time > WHEEL_FEEDBACK_MAX_AGE_MS) {
      this.session = sample.session;
      this.positionOffset = this.rotation - sample.positionRadians;
      this.timeOffset = animationTime - age - sample.sampleTime * 1_000;
      this.points = [{ time: animationTime - age, position: this.rotation, sampleTime: sample.sampleTime }];
      return;
    }
    this.points.push({
      time: sample.sampleTime * 1_000 + this.timeOffset,
      position: sample.positionRadians + this.positionOffset,
      sampleTime: sample.sampleTime
    });
    if (this.points.length > 8) this.points.shift();
  }

  setRunning(running: boolean, animationTime: number): void {
    this.advance(animationTime);
    if (running !== this.running) {
      this.points = [];
      this.session = null;
    }
    this.running = running;
  }
}
