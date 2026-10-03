import type { BridgeActionResult, BridgeProcessSnapshot, BridgeStartOptions } from "../../../shared/bridge";
import { isProcessActive } from "./session";

/** Serializes session handovers; a model change never starts a second worker. */
export class AutomaticSession {
  private desired: BridgeStartOptions | null = null;
  private applied: string | null = null;
  private busy = false;
  private disposed = false;
  private enabled = true;
  private retryAt = 0;
  constructor(private api: {
    getBridgeStatus(): Promise<BridgeProcessSnapshot>;
    startBridge(options: BridgeStartOptions): Promise<BridgeActionResult>;
    stopBridge(): Promise<BridgeActionResult>;
  }, private report: (message: string) => void) {}

  configure(options: BridgeStartOptions): void {
    this.desired = options;
    void this.reconcile();
  }

  dispose(): void { this.disposed = true; }
  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  async reconcile(now = Date.now()): Promise<void> {
    if (this.busy || this.disposed || !this.enabled || !this.desired || now < this.retryAt) return;
    this.busy = true;
    const requestedAt = Date.now();
    try {
      let snapshot = await this.api.getBridgeStatus();
      if (this.disposed || !this.enabled) return;
      // Adopt an existing live worker on renderer reload. Returning from
      // diagnostics stops its worker before resuming drive. Never interrupt stop.
      if (snapshot.status === "stopping") return;
      if (this.applied === null && snapshot.operation === "live" && isProcessActive(snapshot)) this.applied = JSON.stringify(this.desired);
      while (!this.disposed && this.enabled && this.desired) {
        const key = JSON.stringify(this.desired);
        if (isProcessActive(snapshot)) {
          if (snapshot.operation === "live" && key === this.applied) return;
          const stopped = await this.api.stopBridge();
          if (!stopped.ok) throw new Error(stopped.message || "Could not stop the previous session.");
          snapshot = await this.api.getBridgeStatus();
          if (isProcessActive(snapshot)) return;
        }
        if (this.disposed || !this.enabled) return;
        const options = this.desired;
        const started = await this.api.startBridge(options);
        if (!started.ok) throw new Error(started.message || "Connection could not start.");
        this.applied = JSON.stringify(options);
        if (JSON.stringify(this.desired) === this.applied) return;
        snapshot = await this.api.getBridgeStatus();
      }
    } catch (error) {
      this.retryAt = now + Math.max(0, Date.now() - requestedAt) + 3000;
      if (!this.disposed && this.enabled) this.report(error instanceof Error ? error.message : String(error));
    } finally { this.busy = false; }
  }
}
