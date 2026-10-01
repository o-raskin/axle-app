export type BridgeProcessStatus = "idle" | "starting" | "running" | "stopping" | "exited" | "error";

export type BridgeOperation =
  | "live"
  | "discover"
  | "scanHub"
  | "probeGamepad"
  | "gamepadDevices"
  | "audioDevices"
  | "profiles";

export type BridgeLogSource = "stdout" | "stderr" | "system";
export type BridgeProtocolLogSource = BridgeLogSource | "protocol";

export type BridgeSetupStage =
  | "waiting_for_bluetooth"
  | "bluetooth_ready"
  | "waiting_for_gamepad"
  | "waiting_for_hub"
  | "waiting_for_gamepad_and_hub"
  | "scanning_hub"
  | "ready";

export type BridgeProfileOption = {
  id: string;
  name: string;
};

export type BridgeProfileCatalog = {
  models: BridgeProfileOption[];
  gamepads: BridgeProfileOption[];
  defaults: {
    model: string;
    gamepad: string;
    hubName: string;
  };
};

export type BridgeStartOptions = {
  modelId: string;
  gamepadId: string;
  hubName?: string;
  hubAddress?: string;
};

export type BridgeCommandKind = "scanHub" | "probeGamepad" | "gamepadDevices" | "audioDevices";

export type BridgeCommandRequest = {
  kind: BridgeCommandKind;
  modelId?: string;
  gamepadId?: string;
  hubName?: string;
  hubAddress?: string;
};

export type BridgeActionResult = {
  ok: boolean;
  message?: string;
  sessionId?: string;
};

export type BridgeProcessSnapshot = {
  status: BridgeProcessStatus;
  operation?: BridgeOperation;
  sessionId?: string;
  pid?: number;
  commandLine?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  startedAt?: string;
  endedAt?: string;
};

export type BridgeLogEvent = {
  id: number;
  timestamp: string;
  source: BridgeProtocolLogSource;
  message: string;
  operation?: BridgeOperation;
  sessionId?: string;
};

export type BridgeProtocolEnvelope = {
  protocol: "lego-technic-bridge";
  version: 1;
  type: string;
  timestamp: string;
};

export type BridgeProtocolStatusEvent = BridgeProtocolEnvelope & {
  type: "process/status";
  status: BridgeProcessStatus;
  operation?: BridgeOperation;
};

export type BridgeProtocolSetupEvent = BridgeProtocolEnvelope & {
  type: "setup/progress";
  stage: BridgeSetupStage;
  title: string;
  message: string;
  detail?: string;
  steps: Array<{
    label: string;
    done: boolean;
  }>;
};

export type BridgeProtocolLogEvent = BridgeProtocolEnvelope & {
  type: "log";
  level: "debug" | "info" | "warning" | "error";
  message: string;
};

export type BridgeProtocolErrorEvent = BridgeProtocolEnvelope & {
  type: "error";
  errorType: string;
  message: string;
};

export type BridgeProtocolCommandResultEvent = BridgeProtocolEnvelope & {
  type: "command/result";
  command: BridgeOperation;
  ok: boolean;
  payload?: unknown;
};

export type BridgeProtocolTelemetryEvent = BridgeProtocolEnvelope & {
  type: "telemetry";
  telemetry: Record<string, unknown>;
};

export type BridgeProtocolExitEvent = BridgeProtocolEnvelope & {
  type: "exit";
  reason: "complete" | "interrupted" | "cancelled" | "error";
  exitCode: number;
};

export type BridgeProtocolEvent =
  | BridgeProtocolStatusEvent
  | BridgeProtocolSetupEvent
  | BridgeProtocolLogEvent
  | BridgeProtocolErrorEvent
  | BridgeProtocolCommandResultEvent
  | BridgeProtocolTelemetryEvent
  | BridgeProtocolExitEvent;

export const bridgeIpcChannels = {
  getProfiles: "bridge:get-profiles",
  getStatus: "bridge:get-status",
  startLive: "bridge:start-live",
  discover: "bridge:discover",
  stop: "bridge:stop",
  runCommand: "bridge:run-command",
  log: "bridge:log",
  status: "bridge:status",
  event: "bridge:event"
} as const;
