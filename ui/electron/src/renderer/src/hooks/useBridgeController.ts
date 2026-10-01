import { useCallback, useEffect, useRef, useState } from "react";

import type { BootstrapState } from "../../../shared/bootstrap";
import type {
  BridgeActionResult,
  BridgeCommandKind,
  BridgeLogEvent,
  BridgeProcessSnapshot,
  BridgeProfileCatalog,
  BridgeProtocolCommandResultEvent,
  BridgeProtocolEvent,
  BridgeProtocolSetupEvent
} from "../../../shared/bridge";
import type { DesktopSettings } from "../../../shared/settings";
import {
  commandResultMessage,
  deriveConnection,
  discoveryFromTelemetry,
  type DiscoveryState,
  friendlyError,
  isProcessActive,
  updateLiveReadiness,
  type PendingAction
} from "../lib/session";
import { AutomaticSession } from "../lib/automaticSession";
import { VEHICLE_FEEDBACK_MAX_AGE_MS, WHEEL_FEEDBACK_MAX_AGE_MS } from "../lib/vehicleState";

export function useBridgeController(automaticEnabled = true) {
  const [bootstrapState, setBootstrapState] = useState<BootstrapState | null>(null);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [profiles, setProfiles] = useState<BridgeProfileCatalog | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeProcessSnapshot>({ status: "idle" });
  const [logs, setLogs] = useState<BridgeLogEvent[]>([]);
  const [protocolEvents, setProtocolEvents] = useState<BridgeProtocolEvent[]>([]);
  const [commandResults, setCommandResults] = useState<BridgeProtocolCommandResultEvent[]>([]);
  const [currentProgress, setCurrentProgress] = useState<BridgeProtocolSetupEvent | null>(null);
  const [telemetry, setTelemetry] = useState<Record<string, unknown> | null>(null);
  const [telemetryReceivedAt, setTelemetryReceivedAt] = useState<number | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedGamepad, setSelectedGamepad] = useState("auto");
  const [hubName, setHubName] = useState("Technic Move");
  const [hubAddress, setHubAddress] = useState("");
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [liveTelemetryReceived, setLiveTelemetryReceived] = useState(false);
  const [sessionWasReady, setSessionWasReady] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);
  const [discoveryReceivedAt, setDiscoveryReceivedAt] = useState<number | null>(null);

  const mounted = useRef(false);
  const snapshotRef = useRef<BridgeProcessSnapshot>({ status: "idle" });
  const progressRef = useRef<BridgeProtocolSetupEvent | null>(null);
  const statusRevision = useRef(0);
  const startPending = useRef(false);
  const stopPending = useRef(false);
  const settingsPending = useRef(false);
  const initialProfilesLoaded = useRef(false);
  const diagnosticId = useRef(0);
  const automaticSession = useRef<AutomaticSession | null>(null);
  const automaticEnabledRef = useRef(automaticEnabled);

  const appendDiagnostic = useCallback((context: string, error: unknown): void => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    const event: BridgeLogEvent = {
      id: --diagnosticId.current,
      timestamp: new Date().toISOString(),
      source: "system",
      message: `${context}: ${detail}`,
      operation: snapshotRef.current.operation,
      sessionId: snapshotRef.current.sessionId
    };
    setLogs((current) => [...current, event].slice(-500));
  }, []);

  const receiveStatus = useCallback((snapshot: BridgeProcessSnapshot): void => {
    statusRevision.current += 1;
    const previous = snapshotRef.current;
    if (snapshot.sessionId && snapshot.sessionId !== previous.sessionId) {
      progressRef.current = null;
      setCurrentProgress(null);
      setTelemetry(null);
      setTelemetryReceivedAt(null);
      setLiveTelemetryReceived(false);
      setSessionWasReady(false);
      setActionError(null);
      setActionMessage(null);
    }
    snapshotRef.current = snapshot;
    setBridgeStatus(snapshot);
    if (snapshot.status !== "running" || snapshot.operation !== "live") {
      setTelemetryReceivedAt(null);
    }
    if (snapshot.error) {
      appendDiagnostic("Connection status", snapshot.error);
      setActionError((current) => current ?? friendlyError(snapshot.error));
    } else if (snapshot.status === "error") {
      setActionError((current) => current ?? friendlyError("Connection failed"));
    }
  }, [appendDiagnostic]);

  useEffect(() => {
    automaticEnabledRef.current = automaticEnabled;
    automaticSession.current?.setEnabled(automaticEnabled);
    if (automaticEnabled) void automaticSession.current?.reconcile();
  }, [automaticEnabled]);

  useEffect(() => {
    let alive = true;
    mounted.current = true;
    setLoading(true);
    setStartupError(null);
    setProfileError(null);
    setSettingsError(null);
    const unsubscribers: Array<() => void> = [];
    const api = window.legoBridgeUi;

    if (!api) {
      setStartupError(friendlyError("Desktop API unavailable", "startup"));
      appendDiagnostic("App initialization", "Desktop preload API is unavailable");
      setLoading(false);
      return () => { mounted.current = false; };
    }

    try {
      unsubscribers.push(api.onBridgeLog((event) => {
        if (alive) setLogs((current) => [...current, event].slice(-500));
      }));
      unsubscribers.push(api.onBridgeStatus((snapshot) => {
        if (alive) receiveStatus(snapshot);
      }));
      unsubscribers.push(api.onBridgeEvent((event) => {
        if (!alive) return;
        setProtocolEvents((current) => [...current, event].slice(-120));
        const currentSnapshot = snapshotRef.current;
        const previousProgress = progressRef.current;
        setLiveTelemetryReceived((current) => updateLiveReadiness(current, event, currentSnapshot, previousProgress));
        if (event.type === "setup/progress") {
          setTelemetryReceivedAt(null);
          progressRef.current = event;
          setCurrentProgress(event);
        } else if (event.type === "telemetry") {
          if (event.telemetry.kind === "hardwareDiscovery") {
            if (currentSnapshot.operation === "discover") {
              setDiscovery(discoveryFromTelemetry(event.telemetry));
              setDiscoveryReceivedAt(Date.now());
            }
            return;
          }
          setTelemetry(event.telemetry);
          if (updateLiveReadiness(false, event, currentSnapshot, previousProgress)) {
            setSessionWasReady(true);
            setTelemetryReceivedAt(currentSnapshot.status === "running" ? Date.now() : null);
          } else {
            setTelemetryReceivedAt(null);
          }
        } else if (event.type === "command/result") {
          setCommandResults((current) => [...current, event].slice(-20));
          appendDiagnostic(`${event.command} result`, JSON.stringify(event.payload ?? { ok: event.ok }, null, 2));
          if (event.ok) setActionMessage(commandResultMessage(event));
          else setActionError(commandResultMessage(event));
        } else if (event.type === "error") {
          setTelemetryReceivedAt(null);
          appendDiagnostic(event.errorType, event.message);
          setActionError(friendlyError(`${event.errorType}: ${event.message}`));
        } else if (event.type === "exit") {
          setTelemetryReceivedAt(null);
        }
      }));
    } catch (error) {
      appendDiagnostic("Event subscription", error);
      setStartupError(friendlyError(error, "startup"));
    }

    const initialRevision = statusRevision.current;
    const initialize = async (): Promise<void> => {
      // Each request settles independently so a settings failure cannot hide startup recovery.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => api.getBootstrapState()),
        Promise.resolve().then(() => api.getSettings()),
        Promise.resolve().then(() => api.getBridgeStatus()).then((snapshot) => {
          // Restore Stop immediately on a renderer reload, without waiting for
          // the profile catalog or desktop preferences to finish loading.
          if (alive && statusRevision.current === initialRevision) receiveStatus(snapshot);
          return snapshot;
        }),
        Promise.resolve().then(() => api.getBridgeProfiles())
      ]);
      if (!alive) return;
      const [bootstrapResult, settingsResult, statusResult, profileResult] = results;
      if (bootstrapResult.status === "fulfilled") setBootstrapState(bootstrapResult.value);
      else {
        appendDiagnostic("App initialization", bootstrapResult.reason);
        setStartupError(friendlyError(bootstrapResult.reason, "startup"));
      }
      if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
      else {
        appendDiagnostic("Loading preferences", settingsResult.reason);
        setSettingsError("Your saved preferences could not load. Try reloading the app’s settings.");
      }
      if (statusResult.status === "fulfilled") {
        // An older IPC snapshot must not overwrite a newer event received while loading profiles.
        if (statusRevision.current === initialRevision) receiveStatus(statusResult.value);
      } else {
        appendDiagnostic("Loading connection status", statusResult.reason);
        setStartupError(friendlyError(statusResult.reason, "startup"));
      }
      if (profileResult.status === "fulfilled") {
        const catalog = profileResult.value;
        const preserveSelection = initialProfilesLoaded.current;
        setProfiles({ ...catalog, models: catalog.models.filter((model) => model.id === "tumbler") });
        setSelectedModel((current) => current === "tumbler" ? current : catalog.models.some((item) => item.id === "tumbler") ? "tumbler" : "");
        setSelectedGamepad((current) => preserveSelection && catalog.gamepads.some((item) => item.id === current)
          ? current : catalog.defaults.gamepad);
        if (!initialProfilesLoaded.current) setHubName(catalog.defaults.hubName);
        initialProfilesLoaded.current = true;
      } else {
        appendDiagnostic("Loading vehicle profiles", profileResult.reason);
        setProfileError(friendlyError(profileResult.reason, "profiles"));
      }
      setLoading(false);
    };
    void initialize();

    return () => {
      alive = false;
      mounted.current = false;
      for (const unsubscribe of unsubscribers) {
        try { unsubscribe(); } catch { /* Continue removing the remaining listeners. */ }
      }
    };
  }, [initializationAttempt, appendDiagnostic, receiveStatus]);

  useEffect(() => {
    if (!window.legoBridgeUi) return;
    const session = new AutomaticSession(window.legoBridgeUi, (message) => {
      appendDiagnostic("Automatic connection", message);
      setActionError(friendlyError(message));
    });
    session.setEnabled(automaticEnabledRef.current);
    automaticSession.current = session;
    const timer = window.setInterval(() => { void session.reconcile(); }, 3000);
    return () => { session.dispose(); window.clearInterval(timer); automaticSession.current = null; };
  }, [appendDiagnostic]);

  useEffect(() => {
    if (loading || startupError || profileError || !profiles || !settings || !selectedModel) return;
    const timeout = window.setTimeout(() => {
      automaticSession.current?.configure({ modelId: selectedModel, gamepadId: selectedGamepad, hubName, hubAddress });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [loading, startupError, profileError, profiles, settings, selectedModel, selectedGamepad, hubName, hubAddress]);

  useEffect(() => {
    if (discoveryReceivedAt === null) return;
    const timeout = window.setTimeout(() => setDiscovery(null), Math.max(0, discoveryReceivedAt + 4000 - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [discoveryReceivedAt]);

  useEffect(() => {
    if (telemetryReceivedAt === null) return;
    // Expiration must trigger a render even when a silent connection delivers
    // no further events. Each new live frame replaces this timeout.
    const timeout = window.setTimeout(() => {
      setTelemetryReceivedAt((current) => current === telemetryReceivedAt ? null : current);
    }, Math.max(0, telemetryReceivedAt + VEHICLE_FEEDBACK_MAX_AGE_MS + 1 - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [telemetryReceivedAt]);

  useEffect(() => {
    const wheel = telemetry?.wheel_motion;
    if (!wheel || typeof wheel !== "object" || telemetryReceivedAt === null) return;
    const sampleAge = (wheel as Record<string, unknown>).sample_age_ms;
    if (typeof sampleAge !== "number" || !Number.isFinite(sampleAge)) return;
    const timeout = window.setTimeout(() => {
      setTelemetry((current) => current === telemetry ? { ...current, wheel_motion: null } : current);
    }, Math.max(0, telemetryReceivedAt + WHEEL_FEEDBACK_MAX_AGE_MS - sampleAge + 1 - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [telemetry, telemetryReceivedAt]);

  const retryInitialization = (): void => {
    if (loading || startPending.current || stopPending.current) return;
    setInitializationAttempt((current) => current + 1);
  };

  const updateFullscreen = async (launchFullscreen: boolean): Promise<void> => {
    if (settingsPending.current || !settings) return;
    const previous = settings;
    settingsPending.current = true;
    setSettingsSaving(true);
    setSettingsError(null);
    setSettings({ ...settings, launchFullscreen });
    try {
      const updated = await window.legoBridgeUi.updateSettings({ launchFullscreen });
      if (mounted.current) setSettings(updated);
    } catch (error) {
      if (mounted.current) {
        appendDiagnostic("Saving fullscreen preference", error);
        setSettings(previous);
        setSettingsError(friendlyError(error, "settings"));
      }
    } finally {
      settingsPending.current = false;
      if (mounted.current) setSettingsSaving(false);
    }
  };

  const runAction = async (kind: "live" | BridgeCommandKind): Promise<void> => {
    const requiresProfile = kind !== "gamepadDevices" && kind !== "audioDevices";
    if (startPending.current || stopPending.current || (isProcessActive(snapshotRef.current) && snapshotRef.current.operation !== "discover")
      || loading || startupError
      || (requiresProfile && (profileError || !profiles || !selectedModel || !selectedGamepad))) return;
    startPending.current = true;
    setPendingAction(kind);
    setActionError(null);
    setActionMessage(null);
    progressRef.current = null;
    setCurrentProgress(null);
    setTelemetry(null);
    setTelemetryReceivedAt(null);
    setLiveTelemetryReceived(false);
    setSessionWasReady(false);
    const revisionBeforeStart = statusRevision.current;
    // Clear the previous failure immediately, while the new request is being accepted.
    snapshotRef.current = { status: "idle", operation: kind };
    setBridgeStatus(snapshotRef.current);
    const options = { modelId: selectedModel, gamepadId: selectedGamepad, hubName, hubAddress };
    try {
      const result: BridgeActionResult = kind === "live"
        ? await window.legoBridgeUi.startBridge(options)
        : await window.legoBridgeUi.runBridgeCommand(requiresProfile ? { kind, ...options } : { kind });
      if (!mounted.current) return;
      if (!result.ok) {
        appendDiagnostic("Starting connection", result.message ?? "Action rejected");
        setActionError(friendlyError(result.message ?? "Action rejected"));
      } else if (statusRevision.current === revisionBeforeStart) {
        // Normal IPC publishes status first. Keep an accepted request locked if that event is delayed.
        receiveStatus({ status: "starting", operation: kind, sessionId: result.sessionId });
      }
    } catch (error) {
      if (mounted.current) {
        appendDiagnostic("Starting connection", error);
        setActionError(friendlyError(error));
      }
    } finally {
      startPending.current = false;
      if (mounted.current) setPendingAction((current) => current === kind ? null : current);
    }
  };

  const stopBridge = async (): Promise<void> => {
    if (stopPending.current || !isProcessActive(snapshotRef.current)
      || (snapshotRef.current.status === "stopping" && !actionError)) return;
    const wasDiscovery = snapshotRef.current.operation === "discover";
    stopPending.current = true;
    setPendingAction("stop");
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await window.legoBridgeUi.stopBridge();
      if (!mounted.current) return;
      if (!result.ok) {
        appendDiagnostic("Stopping connection", result.message ?? "Stop rejected");
        setActionError(friendlyError(result.message ?? "Stop rejected", "stop"));
      } else {
        setActionMessage(wasDiscovery ? "Device search stopped. Start driving whenever you’re ready."
          : "Control stopped. You can connect again whenever you’re ready.");
        const revisionBeforeRefresh = statusRevision.current;
        const snapshot = await window.legoBridgeUi.getBridgeStatus();
        if (mounted.current && statusRevision.current === revisionBeforeRefresh) receiveStatus(snapshot);
      }
    } catch (error) {
      if (mounted.current) {
        appendDiagnostic("Stopping connection", error);
        setActionError(friendlyError(error, "stop"));
      }
    } finally {
      stopPending.current = false;
      if (mounted.current) setPendingAction(null);
    }
  };

  const bridgeActive = isProcessActive(bridgeStatus) || pendingAction !== null;
  const canStop = isProcessActive(bridgeStatus) && pendingAction !== "stop"
    && (bridgeStatus.status !== "stopping" || Boolean(actionError));
  const discoveryActive = bridgeStatus.operation === "discover" && isProcessActive(bridgeStatus);
  const controlsDisabled = (bridgeActive && !discoveryActive) || loading || Boolean(startupError || profileError)
    || profiles === null || !selectedModel || !selectedGamepad;
  const connection = deriveConnection({
    discovery,
    snapshot: bridgeStatus,
    progress: currentProgress,
    pendingAction,
    liveTelemetryReceived,
    sessionWasReady,
    actionError
  });

  return {
    bootstrapState, settings, profiles, bridgeStatus, logs, protocolEvents, currentProgress, telemetry, telemetryReceivedAt, discovery, discoveryActive,
    selectedModel, setSelectedModel, selectedGamepad, setSelectedGamepad, hubName, setHubName,
    hubAddress, setHubAddress, loading, startupError, profileError, settingsError, actionError, actionMessage,
    bridgeActive, canStop, controlsDisabled, pendingAction, connection, settingsSaving,
    commandResults, lastCommandResult: commandResults.at(-1) ?? null,
    retryInitialization, updateFullscreen,
    startLiveControl: (): Promise<void> => runAction("live"),
    runBridgeCommand: (kind: BridgeCommandKind): Promise<void> => runAction(kind),
    stopBridge,
    clearLogs: (): void => setLogs([]),
    clearEvents: (): void => { setProtocolEvents([]); setCommandResults([]); }
  };
}
