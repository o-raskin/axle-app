import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import { resolveBridgeLaunch, type BridgeLaunch } from "./bridgeRuntime";

import {
  type BridgeActionResult,
  type BridgeLogEvent,
  type BridgeLogSource,
  type BridgeOperation,
  type BridgeProcessSnapshot,
  type BridgeProcessStatus,
  type BridgeProfileCatalog,
  type BridgeProtocolEvent,
  type BridgeProtocolLogEvent,
  type BridgeSetupStage
} from "../shared/bridge";

type PythonInvocation = {
  command: string;
  args: string[];
};

type ManagedBridgeChild = ChildProcessByStdio<Writable, Readable, Readable>;

type BridgeRuntimeApp = {
  isPackaged: boolean;
  resourcesPath: string;
  getAppPath: () => string;
  getPath: (name: "userData") => string;
};

type BridgeProcessPublisher = {
  canStart?: () => boolean;
  publishLog: (event: BridgeLogEvent) => void;
  publishStatus: (snapshot: BridgeProcessSnapshot) => void;
  publishEvent: (event: BridgeProtocolEvent) => void;
};

const profileIdPattern = /^[A-Za-z0-9_-]+$/;
const stopTimeoutMs = 3500;
const killTimeoutMs = 7000;
const closeTimeoutMs = 10000;
const protocolName = "lego-technic-bridge";
const protocolVersion = 1;
const protocolStatuses: BridgeProcessStatus[] = ["idle", "starting", "running", "stopping", "exited", "error"];
const protocolOperations: BridgeOperation[] = [
  "live",
  "discover",
  "scanHub",
  "probeGamepad",
  "gamepadDevices",
  "audioDevices",
  "profiles"
];
const protocolSetupStages: BridgeSetupStage[] = [
  "waiting_for_bluetooth",
  "bluetooth_ready",
  "waiting_for_gamepad",
  "waiting_for_hub",
  "waiting_for_gamepad_and_hub",
  "scanning_hub",
  "ready"
];
const protocolExitReasons = ["complete", "interrupted", "cancelled", "error"] as const;
type ProtocolExitReason = (typeof protocolExitReasons)[number];

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

function formatCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteCommandPart).join(" ");
}

function stripAnsi(value: string): string {
  // oxlint-disable-next-line no-control-regex -- Remove terminal escape sequences from bridge logs.
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 160) : undefined;
}

function normalizeProfileId(value: unknown, label: string): string {
  if (typeof value !== "string" || !profileIdPattern.test(value)) {
    throw new Error(`Invalid ${label} profile`);
  }
  return value;
}

function normalizeProfileCatalog(value: unknown): BridgeProfileCatalog {
  if (!value || typeof value !== "object") {
    throw new Error("Profile catalog was not an object");
  }

  const candidate = value as Partial<BridgeProfileCatalog>;
  const models = normalizeProfileOptions(candidate.models);
  const gamepads = normalizeProfileOptions(candidate.gamepads);

  if (models.length === 0) {
    throw new Error("No model profiles were returned by Python");
  }
  if (gamepads.length === 0) {
    throw new Error("No gamepad profiles were returned by Python");
  }

  return {
    models,
    gamepads,
    defaults: {
      model:
        typeof candidate.defaults?.model === "string" && models.some((model) => model.id === candidate.defaults?.model)
          ? candidate.defaults.model
          : models[0].id,
      gamepad:
        typeof candidate.defaults?.gamepad === "string" && gamepads.some((gamepad) => gamepad.id === candidate.defaults?.gamepad)
          ? candidate.defaults.gamepad
          : gamepads[0].id,
      hubName:
        typeof candidate.defaults?.hubName === "string" && candidate.defaults.hubName.trim()
          ? candidate.defaults.hubName.trim()
          : "Technic Move"
    }
  };
}

function normalizeProfileOptions(value: unknown): BridgeProfileCatalog["models"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const candidate = item as { id?: unknown; name?: unknown };
    if (typeof candidate.id !== "string" || !profileIdPattern.test(candidate.id)) {
      return [];
    }
    return [
      {
        id: candidate.id,
        name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : candidate.id
      }
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isProtocolOperation(value: unknown): value is BridgeOperation {
  return typeof value === "string" && protocolOperations.includes(value as BridgeOperation);
}

function isProtocolStatus(value: unknown): value is BridgeProcessStatus {
  return typeof value === "string" && protocolStatuses.includes(value as BridgeProcessStatus);
}

function isProtocolSetupStage(value: unknown): value is BridgeSetupStage {
  return typeof value === "string" && protocolSetupStages.includes(value as BridgeSetupStage);
}

function isProtocolExitReason(value: unknown): value is ProtocolExitReason {
  return typeof value === "string" && protocolExitReasons.includes(value as ProtocolExitReason);
}

function normalizeProtocolEvent(value: unknown): BridgeProtocolEvent {
  if (!isRecord(value)) {
    throw new Error("Protocol event is not an object");
  }
  if (value.protocol !== protocolName || value.version !== protocolVersion) {
    throw new Error("Protocol event has an unsupported envelope");
  }
  if (typeof value.type !== "string" || typeof value.timestamp !== "string") {
    throw new Error("Protocol event is missing type or timestamp");
  }

  const envelope = {
    protocol: protocolName,
    version: protocolVersion,
    timestamp: value.timestamp
  } as const;

  switch (value.type) {
    case "process/status": {
      if (!isProtocolStatus(value.status)) {
        throw new Error("Protocol status event has an invalid status");
      }
      return {
        ...envelope,
        type: "process/status",
        status: value.status,
        operation: isProtocolOperation(value.operation) ? value.operation : undefined
      };
    }
    case "setup/progress": {
      if (typeof value.title !== "string" || typeof value.message !== "string") {
        throw new Error("Setup progress event is missing title or message");
      }
      const stage = isProtocolSetupStage(value.stage) ? value.stage : "waiting_for_gamepad_and_hub";
      const rawSteps = Array.isArray(value.steps) ? value.steps : [];
      const steps = rawSteps.flatMap((step) => {
        if (!isRecord(step) || typeof step.label !== "string" || typeof step.done !== "boolean") {
          return [];
        }
        return [{ label: step.label, done: step.done }];
      });
      return {
        ...envelope,
        type: "setup/progress",
        stage,
        title: value.title,
        message: value.message,
        detail: typeof value.detail === "string" ? value.detail : undefined,
        steps
      };
    }
    case "log": {
      if (typeof value.message !== "string") {
        throw new Error("Log event is missing message");
      }
      const level = typeof value.level === "string" ? value.level : "info";
      return {
        ...envelope,
        type: "log",
        level: ["debug", "info", "warning", "error"].includes(level) ? level : "info",
        message: value.message
      } as BridgeProtocolLogEvent;
    }
    case "error": {
      if (typeof value.message !== "string") {
        throw new Error("Error event is missing message");
      }
      return {
        ...envelope,
        type: "error",
        errorType: typeof value.errorType === "string" ? value.errorType : "BridgeError",
        message: value.message
      };
    }
    case "command/result": {
      if (!isProtocolOperation(value.command) || typeof value.ok !== "boolean") {
        throw new Error("Command result event has an invalid command or status");
      }
      return {
        ...envelope,
        type: "command/result",
        command: value.command,
        ok: value.ok,
        payload: value.payload
      };
    }
    case "telemetry": {
      if (!isRecord(value.telemetry)) {
        throw new Error("Telemetry event is missing telemetry object");
      }
      return {
        ...envelope,
        type: "telemetry",
        telemetry: value.telemetry
      };
    }
    case "exit": {
      const reason = isProtocolExitReason(value.reason) ? value.reason : "error";
      return {
        ...envelope,
        type: "exit",
        reason,
        exitCode: typeof value.exitCode === "number" ? value.exitCode : 1
      };
    }
    default:
      throw new Error(`Unknown protocol event type: ${value.type}`);
  }
}

export class BridgeProcessService {
  private child: ManagedBridgeChild | null = null;
  private currentSnapshot: BridgeProcessSnapshot = { status: "idle" };
  private logId = 0;
  private sessionId = 0;
  private projectRoot: string | null = null;
  private pythonInvocation: PythonInvocation | null = null;
  private profileCatalog: BridgeProfileCatalog | null = null;
  private profileRequest: Promise<BridgeProfileCatalog> | null = null;
  private readonly profileChildren = new Map<ReturnType<typeof spawn>, Promise<void>>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stopRequested = false;
  private stopPromise: Promise<BridgeActionResult> | null = null;

  constructor(
    private readonly publisher: BridgeProcessPublisher,
    private readonly runtimeApp: BridgeRuntimeApp,
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly probeProcess: typeof spawnSync = spawnSync
  ) {}

  getStatus(): BridgeProcessSnapshot {
    return this.currentSnapshot;
  }

  hasActiveProcess(): boolean {
    return this.child !== null || this.profileChildren.size > 0;
  }

  async getProfiles(): Promise<BridgeProfileCatalog> {
    if (this.profileCatalog) {
      return this.profileCatalog;
    }

    if (!this.profileRequest) {
      this.profileRequest = this.runPythonProtocolCommand("profiles", ["--profiles-json"], 10000)
        .then((result) => {
          if (!result.ok) throw new Error("Python could not read the profile catalog");
          this.profileCatalog = normalizeProfileCatalog(result.payload);
          return this.profileCatalog;
        }).finally(() => { this.profileRequest = null; });
    }
    return await this.profileRequest;
  }

  async startLive(options: unknown): Promise<BridgeActionResult> {
    try {
      await this.stopDiscovery();
      if (this.child) {
        return {
          ok: false,
          message: "A bridge process is already running. Stop it before starting another command."
        };
      }

      const catalog = await this.getProfiles();
      const candidate = options && typeof options === "object" ? (options as Record<string, unknown>) : {};
      const modelId = normalizeProfileId(candidate.modelId, "model");
      const gamepadId = normalizeProfileId(candidate.gamepadId, "gamepad");

      if (!catalog.models.some((model) => model.id === modelId)) {
        throw new Error(`Unknown model profile: ${modelId}`);
      }
      if (!catalog.gamepads.some((gamepad) => gamepad.id === gamepadId)) {
        throw new Error(`Unknown gamepad profile: ${gamepadId}`);
      }

      const args = ["--model", modelId, "--gamepad", gamepadId];
      this.appendHubArgs(args, candidate, catalog.defaults.hubName);
      return this.startManagedProcess("live", args);
    } catch (error) {
      return this.failAction(error);
    }
  }

  async runCommand(request: unknown): Promise<BridgeActionResult> {
    try {
      await this.stopDiscovery();
      if (this.child) {
        return {
          ok: false,
          message: "A bridge process is already running. Stop it before starting another command."
        };
      }

      const candidate = request && typeof request === "object" ? (request as Record<string, unknown>) : {};
      const kind = candidate?.kind;

      // Device inventory remains available for diagnosing a broken profile catalog.
      if (kind === "gamepadDevices") {
        return this.startManagedProcess("gamepadDevices", ["--gamepad-devices"]);
      }
      if (kind === "audioDevices") {
        return this.startManagedProcess("audioDevices", ["--audio-devices"]);
      }

      const catalog = await this.getProfiles();

      if (kind === "scanHub") {
        const args = ["--scan-hub"];
        this.appendHubArgs(args, candidate, catalog.defaults.hubName);
        return this.startManagedProcess("scanHub", args);
      }

      if (kind === "probeGamepad") {
        const gamepadId = normalizeProfileId(candidate.gamepadId ?? catalog.defaults.gamepad, "gamepad");
        if (!catalog.gamepads.some((gamepad) => gamepad.id === gamepadId)) {
          throw new Error(`Unknown gamepad profile: ${gamepadId}`);
        }
        return this.startManagedProcess("probeGamepad", ["--probe", "--gamepad", gamepadId]);
      }

      throw new Error("Unknown bridge command");
    } catch (error) {
      return this.failAction(error);
    }
  }

  async startDiscovery(): Promise<BridgeActionResult> {
    if (this.child) return { ok: true, sessionId: this.currentSnapshot.sessionId };
    try {
      const catalog = await this.getProfiles();
      const args = ["--discover", "--name", catalog.defaults.hubName];
      return this.startManagedProcess("discover", args);
    } catch (error) {
      return this.failAction(error);
    }
  }

  private async stopDiscovery(): Promise<void> {
    if (this.currentSnapshot.operation === "discover" && this.child) await this.stopForAppQuit();
  }

  async stopActiveProcess(): Promise<BridgeActionResult> {
    if (this.stopPromise) {
      return await this.stopPromise;
    }
    if (!this.child) {
      return { ok: true, message: "No bridge process is running." };
    }

    const child = this.child;
    this.stopRequested = true;
    this.updateStatus({ status: "stopping" });
    this.emitSystemLog("Stop requested. Asking the bridge to shut down safely.");

    this.stopPromise = new Promise<BridgeActionResult>((resolveStop) => {
      let settled = false;
      const stopTimer = setTimeout(() => {
        if (!settled && this.child === child) {
          this.emitSystemLog("Bridge did not exit after the stop request. Sending terminate signal.");
          child.kill("SIGTERM");
        }
      }, stopTimeoutMs);
      const killTimer = setTimeout(() => {
        if (!settled && this.child === child) {
          this.emitSystemLog("Python bridge did not terminate. Sending kill signal.");
          child.kill("SIGKILL");
        }
      }, killTimeoutMs);

      const finishStop = (result: BridgeActionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(stopTimer);
        clearTimeout(killTimer);
        clearTimeout(closeTimer);
        child.removeListener("close", closed);
        resolveStop(result);
      };
      const closed = (): void => { finishStop({ ok: true, message: "Bridge process stopped." }); };
      const closeTimer = setTimeout(() => {
        const message = "The bridge did not confirm shutdown. Try Stop again or turn off the vehicle.";
        this.updateStatus({ error: message });
        this.emitSystemLog(message);
        finishStop({ ok: false, message });
      }, closeTimeoutMs);
      child.once("close", closed);

      // Windows treats child.kill("SIGINT") as forceful termination. A protocol
      // command lets every platform finish motor shutdown and BLE disconnect.
      try {
        child.stdin.end(`${JSON.stringify({ protocol: protocolName, version: protocolVersion, type: "control/stop" })}\n`);
      } catch (error) {
        this.emitSystemLog(`Could not send the stop request: ${errorMessage(error)}`);
      }
    });
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async stopForAppQuit(): Promise<void> {
    // Profile lookups are workers too: quitting must await their actual close.
    const profiles = [...this.profileChildren.entries()];
    for (const [child] of profiles) child.kill("SIGKILL");
    const waitForProfiles = async (): Promise<void> => {
      if (profiles.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(profiles.map(([, closed]) => closed)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("The profile worker did not confirm shutdown")), closeTimeoutMs);
          })
        ]);
      } finally { clearTimeout(timer); }
    };
    await Promise.all([
      this.stopActiveProcess().then((result) => { if (!result.ok) throw new Error(result.message); }),
      waitForProfiles()
    ]);
  }

  private appendHubArgs(args: string[], value: Record<string, unknown>, fallbackHubName: string): void {
    const hubName = normalizeOptionalText(value.hubName) ?? fallbackHubName;
    const hubAddress = normalizeOptionalText(value.hubAddress);

    if (hubName) {
      args.push("--name", hubName);
    }
    if (hubAddress) {
      args.push("--address", hubAddress);
    }
  }

  private async startManagedProcess(operation: BridgeOperation, scriptArgs: string[]): Promise<BridgeActionResult> {
    if (this.publisher.canStart && !this.publisher.canStart()) {
      return { ok: false, message: "Axle is closing or installing an update." };
    }
    if (this.child) {
      return {
        ok: false,
        message: "A bridge process is already running. Stop it before starting another command."
      };
    }

    const invocation = this.getBridgeLaunch();
    const sessionId = `${operation}-${Date.now().toString(36)}-${++this.sessionId}`;
    const args = [...invocation.args, ...scriptArgs];
    const commandLine = formatCommandLine(invocation.command, args);

    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.stopRequested = false;
    this.updateStatus({
      status: "starting",
      operation,
      sessionId,
      commandLine,
      startedAt: nowIso(),
      exitCode: undefined,
      signal: undefined,
      error: undefined,
      endedAt: undefined,
      pid: undefined
    });
    this.emitSystemLog(`Starting: ${commandLine}`);

    try {
      const child = this.spawnProcess(invocation.command, args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });

      this.child = child;
      child.stdin.on("error", (error) => {
        this.emitSystemLog(`Bridge control channel closed: ${error.message}`);
      });
      this.attachOutputStream(child, "stdout");
      this.attachOutputStream(child, "stderr");

      let processError: string | undefined;
      let spawned = false;
      child.once("spawn", () => {
        if (this.child !== child) return;
        spawned = true;
        this.updateStatus({ status: this.stopRequested ? "stopping" : "running", pid: child.pid });
      });

      child.once("error", (error) => {
        if (this.child !== child) return;
        this.flushOutputBuffers();
        processError = error.message;
        // An error does not close stdio. Keep ownership until close so a late
        // callback cannot overwrite the next worker's session.
        this.updateStatus({
          status: spawned ? this.stopRequested ? "stopping" : "running" : "error",
          error: error.message,
          endedAt: spawned ? undefined : nowIso(),
          pid: spawned ? child.pid : undefined
        });
        this.emitSystemLog(`Process error: ${error.message}`);
      });

      child.once("close", (exitCode, signal) => {
        if (this.child !== child) return;
        this.flushOutputBuffers();
        this.child = null;
        const stoppedByRequest = this.stopRequested;
        const failed = !stoppedByRequest && (exitCode !== 0 || processError !== undefined);
        this.updateStatus({
          status: failed ? "error" : "exited",
          exitCode,
          signal,
          error: failed ? processError ?? `Python bridge exited with code ${exitCode ?? "unknown"}` : undefined,
          endedAt: nowIso(),
          pid: undefined
        });
        this.emitSystemLog(
          `Python bridge exited${exitCode === null ? "" : ` with code ${exitCode}`}${signal ? ` (${signal})` : ""}.`
        );
        this.stopRequested = false;
      });

      return { ok: true, sessionId, message: "Bridge process started." };
    } catch (error) {
      const message = errorMessage(error);
      this.updateStatus({
        status: "error",
        error: message,
        endedAt: nowIso()
      });
      this.emitSystemLog(`Could not start Python bridge: ${message}`);
      return { ok: false, message };
    }
  }

  private failAction(error: unknown): BridgeActionResult {
    const message = errorMessage(error);
    // A request can fail after another worker starts while it awaits profiles.
    // Keep that worker's active state visible so its Stop action remains usable.
    this.updateStatus({
      status: this.child ? this.currentSnapshot.status : "error",
      error: message,
      endedAt: this.child ? this.currentSnapshot.endedAt : nowIso()
    });
    this.emitSystemLog(message);
    return { ok: false, message };
  }

  private attachOutputStream(child: ManagedBridgeChild, source: Exclude<BridgeLogSource, "system">): void {
    child[source].setEncoding("utf8");
    child[source].on("data", (chunk: string) => {
      if (source === "stdout") {
        this.stdoutBuffer = this.emitCompleteProtocolLines(`${this.stdoutBuffer}${chunk}`);
      } else {
        this.stderrBuffer = this.emitCompleteDiagnosticLines(`${this.stderrBuffer}${chunk}`, source);
      }
    });
  }

  private emitCompleteProtocolLines(buffer: string): string {
    const normalized = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const lines = normalized.split("\n");
    const pending = lines.pop() ?? "";

    for (const line of lines) {
      this.emitProtocolLine(line);
    }

    return pending;
  }

  private emitCompleteDiagnosticLines(buffer: string, source: Exclude<BridgeLogSource, "system">): string {
    const normalized = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const lines = normalized.split("\n");
    const pending = lines.pop() ?? "";

    for (const line of lines) {
      this.emitLog(source, line);
    }

    return pending;
  }

  private flushOutputBuffers(): void {
    if (this.stdoutBuffer) {
      this.emitProtocolLine(this.stdoutBuffer);
      this.stdoutBuffer = "";
    }
    if (this.stderrBuffer) {
      this.emitLog("stderr", this.stderrBuffer);
      this.stderrBuffer = "";
    }
  }

  private emitProtocolLine(line: string): void {
    const cleaned = stripAnsi(line);
    if (!cleaned.trim()) {
      return;
    }

    try {
      const event = normalizeProtocolEvent(JSON.parse(cleaned));
      this.handleProtocolEvent(event);
    } catch (error) {
      const message = `Malformed Python protocol output: ${errorMessage(error)}. Output: ${cleaned.slice(0, 400)}`;
      this.updateStatus({ error: message });
      this.emitSystemLog(message);
      this.publisher.publishEvent({
        protocol: "lego-technic-bridge",
        version: 1,
        type: "error",
        timestamp: nowIso(),
        errorType: "MalformedProtocolOutput",
        message
      });
    }
  }

  private handleProtocolEvent(event: BridgeProtocolEvent): void {
    this.publisher.publishEvent(event);

    if (event.type === "log") {
      this.emitLog("protocol", event.message);
      return;
    }

    if (event.type === "error") {
      const message = `${event.errorType}: ${event.message}`;
      this.updateStatus({ error: message });
      this.emitLog("protocol", message);
      return;
    }

    if (event.type === "process/status") {
      this.updateStatus({
        status: this.stopRequested ? "stopping" : event.status,
        operation: event.operation ?? this.currentSnapshot.operation
      });
    }
  }

  private emitSystemLog(message: string): void {
    this.emitLog("system", message);
  }

  private emitLog(source: BridgeLogEvent["source"], message: string): void {
    const cleaned = stripAnsi(message);
    if (!cleaned.trim()) {
      return;
    }

    const event: BridgeLogEvent = {
      id: ++this.logId,
      timestamp: nowIso(),
      source,
      message: cleaned,
      operation: this.currentSnapshot.operation,
      sessionId: this.currentSnapshot.sessionId
    };
    this.publisher.publishLog(event);
  }

  private updateStatus(patch: Partial<BridgeProcessSnapshot>): void {
    this.currentSnapshot = {
      ...this.currentSnapshot,
      ...patch
    };
    this.publisher.publishStatus(this.currentSnapshot);
  }

  private async runPythonProtocolCommand(
    expectedCommand: BridgeOperation,
    scriptArgs: string[],
    timeoutMs: number
  ): Promise<Extract<BridgeProtocolEvent, { type: "command/result" }>> {
    if (this.publisher.canStart && !this.publisher.canStart()) {
      throw new Error("Axle is closing or installing an update.");
    }
    const invocation = this.getBridgeLaunch();
    const args = [...invocation.args, ...scriptArgs];

    return await new Promise<Extract<BridgeProtocolEvent, { type: "command/result" }>>((resolveOutput, rejectOutput) => {
      const child = this.spawnProcess(invocation.command, args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      this.profileChildren.set(child, new Promise<void>((resolveClosed) => {
        child.once("close", () => {
          this.profileChildren.delete(child);
          resolveClosed();
        });
      }));
      let stdoutBuffer = "";
      let stderr = "";
      let settled = false;
      let commandResult: Extract<BridgeProtocolEvent, { type: "command/result" }> | null = null;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        rejectOutput(error);
      };
      const timer = setTimeout(() => {
        fail(new Error("Timed out while reading Python profile catalog"));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        const normalized = `${stdoutBuffer}${chunk}`.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        const lines = normalized.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          try {
            const event = normalizeProtocolEvent(JSON.parse(line));
            if (event.type === "command/result" && event.command === expectedCommand) {
              commandResult = event;
            } else if (event.type === "log") {
              this.emitLog("protocol", event.message);
            } else if (event.type === "error") {
              this.emitLog("protocol", `${event.errorType}: ${event.message}`);
            }
          } catch (error) {
            fail(new Error(`Malformed Python protocol output: ${errorMessage(error)}`));
            return;
          }
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        settled = true;
        clearTimeout(timer);
        rejectOutput(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stdoutBuffer.trim()) {
          try {
            const event = normalizeProtocolEvent(JSON.parse(stdoutBuffer));
            if (event.type === "command/result" && event.command === expectedCommand) {
              commandResult = event;
            }
          } catch (error) {
            rejectOutput(new Error(`Malformed Python protocol output: ${errorMessage(error)}`));
            return;
          }
        }
        if (code === 0 && commandResult) {
          resolveOutput(commandResult);
        } else if (code === 0) {
          rejectOutput(new Error(`Python protocol did not return ${expectedCommand} result`));
        } else {
          rejectOutput(new Error(stderr.trim() || `Python exited with code ${code}`));
        }
      });
    });
  }

  private getProjectRoot(): string {
    if (this.projectRoot) {
      return this.projectRoot;
    }

    const startingPoints = [
      process.env.LEGO_BRIDGE_PROJECT_ROOT,
      process.cwd(),
      this.runtimeApp.getAppPath(),
      __dirname
    ].filter((value): value is string => Boolean(value));

    for (const start of startingPoints) {
      const found = this.findProjectRoot(start);
      if (found) {
        this.projectRoot = found;
        return found;
      }
    }

    throw new Error("Could not find gamepad_bridge.py. Set LEGO_BRIDGE_PROJECT_ROOT to the repository root.");
  }

  private findProjectRoot(start: string): string | null {
    let current = resolve(start);
    if (!existsSync(current)) {
      current = dirname(current);
    }

    while (true) {
      if (existsSync(join(current, "gamepad_bridge.py")) && existsSync(join(current, "bridge"))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }

  private getPythonInvocation(): PythonInvocation {
    if (this.pythonInvocation) {
      return this.pythonInvocation;
    }

    const root = this.getProjectRoot();
    const executableName = process.platform === "win32" ? "python.exe" : "python";
    const localCandidates = [
      join(root, "lego-env", process.platform === "win32" ? "Scripts" : "bin", executableName),
      join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin", executableName)
    ];

    const candidates: PythonInvocation[] = [
      ...(process.env.LEGO_BRIDGE_PYTHON ? [{ command: process.env.LEGO_BRIDGE_PYTHON, args: [] }] : []),
      ...localCandidates.filter((command) => existsSync(command)).map((command) => ({ command, args: [] })),
      { command: "python3", args: [] },
      { command: "python", args: [] },
      { command: "py", args: ["-3"] }
    ];

    for (const candidate of candidates) {
      if (this.pythonWorks(candidate)) {
        this.pythonInvocation = candidate;
        return candidate;
      }
    }

    throw new Error("Could not find a working Python 3.9+ command. Set LEGO_BRIDGE_PYTHON to the venv python.");
  }

  private pythonWorks(candidate: PythonInvocation): boolean {
    const result = this.probeProcess(candidate.command, [...candidate.args, "--version"], {
      encoding: "utf8",
      timeout: 5000
    });

    const version = /^Python 3\.(\d+)(?:\.|\s|$)/.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
    return !result.error && result.status === 0 && version !== null && Number(version[1]) >= 9;
  }

  private getBridgeLaunch(): BridgeLaunch {
    return resolveBridgeLaunch({
      isPackaged: this.runtimeApp.isPackaged,
      resourcesPath: this.runtimeApp.resourcesPath,
      userDataPath: this.runtimeApp.getPath("userData"),
      platform: process.platform,
      environment: process.env
    }, () => ({ ...this.getPythonInvocation(), root: this.getProjectRoot() }));
  }
}
