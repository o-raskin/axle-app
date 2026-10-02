export type TumblerShadowPose = {
  steering: number;
  wheelRotation: number;
  travel: number;
  streetEnabled: boolean;
  clearance: readonly [number, number];
};

/** Refresh cached geometry shadows on meaningful pose changes, at most 10 Hz
 * during movement. This only samples frames the viewer already renders; it
 * does not start a timer or an animation loop while the car is stationary. */
export class TumblerShadowCache {
  private rendered: TumblerShadowPose | null = null;
  private renderedAt = -Infinity;
  private dirty = false;
  private invalidated = true;

  /** Newly loaded/replaced geometry needs a map immediately, even if its pose
   * matches the previous model. Repeated invalidations coalesce into one map. */
  invalidate(): void { this.invalidated = true; }

  sample(time: number, pose: TumblerShadowPose): boolean {
    if (![time, pose.steering, pose.wheelRotation, pose.travel, ...pose.clearance].every(Number.isFinite)) return false;
    const previous = this.rendered;
    const immediate = this.invalidated || previous === null || previous.streetEnabled !== pose.streetEnabled;
    if (previous !== null) {
      const moving = Math.abs(pose.steering - previous.steering) > 0.03
        || Math.abs(pose.wheelRotation - previous.wheelRotation) >= 0.10;
      const changingStreet = pose.streetEnabled && (Math.abs(pose.travel - previous.travel) >= 0.06
        || Math.abs(pose.clearance[0] - previous.clearance[0]) > 0.04
        || Math.abs(pose.clearance[1] - previous.clearance[1]) > 0.04);
      // Latch changes until a subsequent existing frame can refresh the map.
      // Comparing with the last rendered pose also catches accumulated small
      // movements that would be missed by comparing adjacent input samples.
      this.dirty ||= moving || changingStreet;
    }
    if (!immediate && (!this.dirty || time - this.renderedAt < 100)) return false;
    this.rendered = { ...pose, clearance: [pose.clearance[0], pose.clearance[1]] };
    this.renderedAt = time;
    this.dirty = false;
    this.invalidated = false;
    return true;
  }
}
