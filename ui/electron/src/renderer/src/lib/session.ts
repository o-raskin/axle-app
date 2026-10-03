import type {
  BridgeOperation,
  BridgeProcessSnapshot,
  BridgeProtocolCommandResultEvent,
  BridgeProtocolEvent,
  BridgeProtocolSetupEvent
} from "../../../shared/bridge";

export type PendingAction = BridgeOperation | "stop" | null;

export type ConnectionView = {
  phase: "idle" | "connecting" | "ready" | "stopping" | "disconnected" | "error" | "diagnostic" | "discovering" | "detected";
  title: string;
  description: string;
  bluetoothReady: boolean;
  controllerReady: boolean;
  vehicleReady: boolean;
};

export type DiscoveryState = {
  bluetoothReady: boolean;
  controllerName: string | null;
  controllerProfile: string | null;
  vehicleName: string | null;
  detail: string;
};

export function discoveryFromTelemetry(value: Record<string, unknown>): DiscoveryState | null {
  if (value.kind !== "hardwareDiscovery" || typeof value.bluetoothReady !== "boolean") return null;
  const controller = value.controller && typeof value.controller === "object" ? value.controller as Record<string, unknown> : null;
  const vehicle = value.vehicle && typeof value.vehicle === "object" ? value.vehicle as Record<string, unknown> : null;
  return {
    bluetoothReady: value.bluetoothReady,
    controllerName: typeof controller?.name === "string" ? controller.name : null,
    controllerProfile: typeof controller?.profile === "string" ? controller.profile : null,
    vehicleName: typeof vehicle?.name === "string" ? vehicle.name : null,
    detail: typeof value.detail === "string" ? value.detail : ""
  };
}

export function isProcessActive(snapshot: BridgeProcessSnapshot): boolean {
  return snapshot.status === "starting" || snapshot.status === "running" || snapshot.status === "stopping";
}

/** Checklist flags are stronger evidence than the protocol's inferred stage. */
export function setupReadiness(progress: BridgeProtocolSetupEvent | null): {
  bluetoothReady: boolean;
  controllerReady: boolean;
  vehicleReady: boolean;
  liveReady: boolean;
} {
  const done = (label: string): boolean =>
    progress?.steps.some((step) => step.label.toLowerCase() === label && step.done) ?? false;
  return {
    bluetoothReady: done("bluetooth enabled"),
    controllerReady: done("gamepad controller detected"),
    vehicleReady: done("technic move hub connected"),
    liveReady: done("live drive session ready")
  };
}

export function hasModelMismatch(progress: BridgeProtocolSetupEvent | null): boolean {
  return /expected model ports are missing|not ready to drive|HubPortMismatch/i.test(
    `${progress?.title ?? ""} ${progress?.message ?? ""} ${progress?.detail ?? ""}`
  );
}

/** Each setup announcement starts a new calibration checkpoint, even if its
 * hardware checklist is already complete. Only a subsequent live frame arms it. */
export function updateLiveReadiness(
  current: boolean,
  event: BridgeProtocolEvent,
  snapshot: BridgeProcessSnapshot,
  progress: BridgeProtocolSetupEvent | null
): boolean {
  if (event.type === "setup/progress" || event.type === "exit" || event.type === "error") return false;
  if (event.type !== "telemetry") return current;
  const flags = setupReadiness(progress);
  return snapshot.operation === "live" && isProcessActive(snapshot)
    && event.telemetry.kind !== "gamepadProbe" && typeof event.telemetry.model_name === "string"
    && (progress === null || (flags.liveReady && flags.controllerReady && flags.vehicleReady));
}

export function friendlyError(
  error: unknown,
  context: "startup" | "profiles" | "settings" | "connection" | "diagnostic" | "stop" = "connection"
): string {
  const detail = error instanceof Error ? error.message : String(error);
  const diagnostic = context === "diagnostic";
  const retry = diagnostic ? "Try the check again." : "Axle will try again automatically.";
  if (context === "stop") {
    return "The app could not confirm that control has stopped. Try Stop again, or turn off the vehicle.";
  }
  if (context === "settings") {
    return "Your preference could not be saved. Try changing it again.";
  }
  if (/permission|not authorized|not authorised|access denied|not permitted|unauthorized/i.test(detail)) {
    return `Bluetooth access is blocked. Allow Axle to use Bluetooth in your system settings. ${diagnostic ? retry : "We’ll continue automatically."}`;
  }
  if (/calibrat/i.test(detail)) {
    return `Your vehicle could not finish its steering check. Restart the vehicle with its wheels clear. ${retry}`;
  }
  if (/HubPortMismatch|expected.*ports|missing.*ports|unsupported.*hub/i.test(detail)) {
    return "This vehicle does not match the supported Tumbler model. Connect the correct vehicle, or inspect it in Diagnostics.";
  }
  if (/already running|already active/i.test(detail)) {
    return diagnostic
      ? "Another connection or device check is still active. Stop it before trying the check again."
      : "Another connection or device check is still active. Axle will try again when it finishes.";
  }
  if (/No module named|ModuleNotFoundError|python.*not found|ENOENT|runtime.*unavailable/i.test(detail)) {
    return "The driving tools could not start. Reopen the app, or enable Developer mode in Settings to open Diagnostics.";
  }
  if (context === "startup") {
    return "The app could not finish starting. Try again to reload the connection tools.";
  }
  if (context === "profiles") {
    return "Vehicle and controller choices could not load. Try again, or enable Developer mode in Settings to open Diagnostics.";
  }
  if (/bluetooth.*(off|disabled|unavailable)|powered off/i.test(detail)) {
    return `Bluetooth is unavailable. Turn it on in your system settings. ${diagnostic ? retry : "We’ll continue automatically."}`;
  }
  if (/disconnect|connection.*lost|not connected/i.test(detail)) {
    return `The connection was lost. Keep your controller and vehicle nearby. ${diagnostic ? retry : "Axle will reconnect automatically."}`;
  }
  if (diagnostic) return "The device check could not finish. Check that your devices are on, then try the check again.";
  return "The connection could not be completed. Check that your vehicle and controller are on. Axle will try again automatically.";
}

export function commandResultMessage(event: BridgeProtocolCommandResultEvent): string {
  if (!event.ok) {
    return "The device check could not finish. Try again, or open Diagnostics for details.";
  }
  switch (event.command) {
    case "scanHub":
      return "Vehicle scan complete. Results are available below.";
    case "probeGamepad":
      return "Controller detected. Move the sticks and press buttons to check their response.";
    case "gamepadDevices":
      return "Controller check complete. The results are available below.";
    case "audioDevices":
      return "Audio check complete. The results are available below.";
    case "profiles":
      return "Vehicle and controller choices are up to date.";
    case "live":
      return "Connection restarting.";
    case "discover":
      return "Device search complete.";
  }
}

export type ConnectionInput = {
  discovery?: DiscoveryState | null;
  snapshot: BridgeProcessSnapshot;
  progress: BridgeProtocolSetupEvent | null;
  pendingAction: PendingAction;
  liveTelemetryReceived: boolean;
  liveTelemetryFresh: boolean;
  sessionWasReady: boolean;
  actionError: string | null;
};

export function deriveConnection({
  discovery,
  snapshot,
  progress,
  pendingAction,
  liveTelemetryReceived,
  liveTelemetryFresh,
  sessionWasReady,
  actionError
}: ConnectionInput): ConnectionView {
  // After a renderer reload there may be no replayed checklist; fresh vehicle
  // telemetry is still affirmative evidence that the existing drive is ready.
  const flags = progress === null && liveTelemetryReceived
    ? { bluetoothReady: true, controllerReady: true, vehicleReady: true, liveReady: true }
    : setupReadiness(progress);
  const offline = { bluetoothReady: false, controllerReady: false, vehicleReady: false };
  const view = (
    phase: ConnectionView["phase"],
    title: string,
    description: string,
    readiness = offline
  ): ConnectionView => ({ phase, title, description, ...readiness });
  const active = isProcessActive(snapshot) || (pendingAction !== null && pendingAction !== "stop");
  const operation = pendingAction && pendingAction !== "stop" ? pendingAction : snapshot.operation;

  if (pendingAction === "stop") {
    if (snapshot.operation === "discover") return view("stopping", "Stopping device search", "Wait a moment while the device scan closes.");
    return view("stopping", "Stopping your vehicle", "Wait a moment while control ends and the connection closes.");
  }
  if (actionError || snapshot.status === "error" || snapshot.error) {
    return view(
      "error",
      "Connection needs attention",
      actionError ?? friendlyError(snapshot.error ?? "Connection failed",
        snapshot.operation && snapshot.operation !== "live" && snapshot.operation !== "discover" ? "diagnostic" : "connection")
    );
  }
  if (snapshot.status === "stopping") {
    return view("stopping", "Stopping your vehicle", "Wait a moment while control ends and the connection closes.");
  }
  if (operation === "live" && hasModelMismatch(progress)) {
    return view("error", "Check your vehicle model", friendlyError("HubPortMismatch"));
  }
  if (active && operation === "discover") {
    const found = Boolean(discovery?.controllerName && discovery?.vehicleName);
    return view(found ? "detected" : "discovering", found ? "Your devices are nearby" : "Finding your devices",
      found ? "Your controller and vehicle have been found. Axle will connect automatically."
        : discovery && !discovery.bluetoothReady ? friendlyError(discovery.detail || "Bluetooth unavailable")
          : "Turn on your vehicle and pair your controller. We’ll find both.",
      { bluetoothReady: discovery?.bluetoothReady ?? false, controllerReady: Boolean(discovery?.controllerName), vehicleReady: false });
  }
  if (active && operation !== "live") {
    const title = operation === "scanHub" ? "Scanning your vehicle" : "Device check in progress";
    const description = operation === "scanHub"
      ? "Press your vehicle’s power button. Keep it nearby while the scan finishes."
      : operation === "probeGamepad"
        ? "Connect your controller, then move the sticks and press buttons. Stop the check when you’re done."
        : "The results will appear in Diagnostics when the check finishes.";
    return view("diagnostic", title, description);
  }
  if (!active) {
    if (snapshot.operation === "live" && snapshot.status === "exited") {
      return view("disconnected", "Drive ended", "Axle will reconnect automatically. Keep your devices nearby.");
    }
    return view("idle", "Ready when you are", "Turn on your controller and vehicle. Axle will connect automatically.");
  }

  const readiness = {
    bluetoothReady: flags.bluetoothReady,
    controllerReady: flags.controllerReady,
    vehicleReady: flags.vehicleReady
  };
  if (flags.liveReady && flags.controllerReady && flags.vehicleReady && liveTelemetryReceived) {
    if (!liveTelemetryFresh) {
      return view("connecting", "Checking your connection", "We’re waiting for your vehicle to respond. Keep your controller and vehicle nearby.", readiness);
    }
    return view("ready", "Ready to drive", "Your controller is in charge. Enjoy the drive.", readiness);
  }
  const details = `${progress?.message ?? ""} ${progress?.detail ?? ""}`;
  if (/permission|not authorized|not authorised|access denied|not permitted/i.test(details)) {
    return view("connecting", "Allow Bluetooth access", friendlyError("Bluetooth permission denied"), readiness);
  }
  if (progress?.stage === "waiting_for_bluetooth") {
    return view("connecting", "Turn on Bluetooth", "Enable Bluetooth in your system settings. We’ll continue automatically.", readiness);
  }
  if (flags.liveReady && flags.controllerReady && flags.vehicleReady) {
    return view("connecting", "Preparing your vehicle", "Keep the wheels clear while your vehicle checks its steering.", readiness);
  }
  if (progress?.stage === "scanning_hub") {
    return view("connecting", "Getting to know your vehicle", "Press the power button on your vehicle. This first check may take a moment.", readiness);
  }
  if (sessionWasReady) {
    const description = !flags.controllerReady && !flags.vehicleReady
      ? "Control is paused. Reconnect your controller and press your vehicle’s power button."
      : !flags.controllerReady
        ? "Control is paused. Reconnect your controller with Bluetooth or USB."
        : "Control is paused. Press your vehicle’s power button to reconnect.";
    return view("connecting", "Let’s reconnect", description, readiness);
  }
  if (flags.controllerReady && !flags.vehicleReady) {
    return view("connecting", "Turn on your vehicle", "Press your vehicle’s power button so its light blinks. Keep it nearby.", readiness);
  }
  if (!flags.controllerReady && flags.vehicleReady) {
    return view("connecting", "Connect your controller", "Connect your controller with Bluetooth or USB. We’ll detect it automatically.", readiness);
  }
  return view(
    "connecting",
    "Finding your controller and vehicle",
    "Connect your controller with Bluetooth or USB, then press your vehicle’s power button.",
    readiness
  );
}
