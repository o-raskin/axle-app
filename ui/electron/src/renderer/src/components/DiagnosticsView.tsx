import type { BridgeCommandKind } from "../../../shared/bridge";
import { Icon } from "./Icon";
import type { BridgeController } from "./types";

const commands: { kind: BridgeCommandKind; title: string; description: string; requiresProfile: boolean }[] = [
  {
    kind: "scanHub",
    title: "Inspect vehicle",
    description: "Discover the hub and refresh its port map.",
    requiresProfile: true
  },
  {
    kind: "gamepadDevices",
    title: "Find controllers",
    description: "List controllers available to this computer.",
    requiresProfile: false
  },
  {
    kind: "probeGamepad",
    title: "Test controller input",
    description: "Watch buttons and sticks respond live.",
    requiresProfile: true
  },
  {
    kind: "audioDevices",
    title: "Find audio devices",
    description: "Check available sound outputs.",
    requiresProfile: false
  }
];

export type DiagnosticTab = "results" | "events" | "logs";

type DiagnosticsViewProps = {
  bridge: BridgeController;
  tab: DiagnosticTab;
  onTabChange: (tab: DiagnosticTab) => void;
};

function DiagnosticResults({ bridge }: { bridge: BridgeController }) {
  return (
    <>
      {bridge.commandResults.length ? bridge.commandResults.map((result, index) => (
        <details key={`${result.timestamp}-${index}`} open>
          <summary>{result.command} · {result.ok ? "Completed" : "Failed"}</summary>
          <pre>{JSON.stringify(result.payload ?? {}, null, 2)}</pre>
        </details>
      )) : (
        <div className="empty-state">
          <Icon name="tool" size={28} />
          <h3>Ready to investigate</h3>
          <p>Choose a device check above. Results will appear here.</p>
        </div>
      )}
      {bridge.telemetry && (
        <details>
          <summary>Latest telemetry</summary>
          <pre>{JSON.stringify(bridge.telemetry, null, 2)}</pre>
        </details>
      )}
    </>
  );
}

function DiagnosticEvents({ bridge }: { bridge: BridgeController }) {
  if (!bridge.protocolEvents.length) {
    return (
      <div className="empty-state">
        <h3>No events yet</h3>
        <p>Connect a vehicle or run a device check to see its events.</p>
      </div>
    );
  }

  return bridge.protocolEvents.map((event, index) => (
    <details key={`${event.timestamp}-${index}`}>
      <summary>
        <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
        {event.type}
      </summary>
      <pre>{JSON.stringify(event, null, 2)}</pre>
    </details>
  ));
}

function DiagnosticLogs({ bridge }: { bridge: BridgeController }) {
  if (!bridge.logs.length) {
    return (
      <div className="empty-state">
        <h3>A clean slate</h3>
        <p>Connection and device messages will appear here.</p>
      </div>
    );
  }

  return (
    <div className="log-list">
      {bridge.logs.map((log) => (
        <div className="log-row" key={log.id}>
          <time>{new Date(log.timestamp).toLocaleTimeString()}</time>
          <span>{log.source}</span>
          <p>{log.message}</p>
        </div>
      ))}
    </div>
  );
}

export function DiagnosticsView({ bridge, tab, onTabChange }: DiagnosticsViewProps) {
  return (
    <section className="diagnostics" aria-label="Device diagnostics">
      <div className="diagnostic-intro">
        <div>
          <h2>Understand your connection</h2>
          <p>Device checks and technical details, when you need them.</p>
        </div>
        {bridge.bridgeActive && (
          <button
            type="button"
            className="button button--stop"
            onClick={bridge.stopBridge}
            disabled={!bridge.canStop || bridge.pendingAction === "stop"}
          >
            <Icon name="pause" />
            {bridge.pendingAction === "stop" ? "Stopping…" : "Stop session"}
          </button>
        )}
      </div>
      {bridge.bridgeActive && (
        <div className="notice">
          <Icon name="help" size={18} />
          <p>Stop the current session before starting another check.</p>
        </div>
      )}
      <div className="diagnostic-commands">
        {commands.map((command) => (
          <button
            type="button"
            key={command.kind}
            disabled={(bridge.bridgeActive && !bridge.discoveryActive) || !!bridge.pendingAction || (command.requiresProfile && bridge.controlsDisabled)}
            onClick={() => {
              onTabChange("results");
              void bridge.runBridgeCommand(command.kind);
            }}
          >
            <Icon name={command.kind === "scanHub" ? "vehicle" : command.kind === "audioDevices" ? "tool" : "controller"} />
            <strong>{command.title}</strong>
            <span>{command.description}</span>
            <Icon name="arrow" size={17} />
          </button>
        ))}
      </div>
      {bridge.actionError && (
        <div className="notice notice--error" role="alert">
          <Icon name="warning" size={18} />
          <p>{bridge.actionError}</p>
        </div>
      )}
      {bridge.actionMessage && <p className="notice" role="status">{bridge.actionMessage}</p>}

      <div className="debug-panel">
        <div className="debug-toolbar">
          <div className="segmented" role="group" aria-label="Diagnostic view">
            {(["results", "events", "logs"] as const).map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={tab === item}
                onClick={() => onTabChange(item)}
              >
                {item === "results" ? "Results" : item === "events" ? "Events" : "Logs"}
                {item !== "results" && (
                  <span>{item === "events" ? bridge.protocolEvents.length : bridge.logs.length}</span>
                )}
              </button>
            ))}
          </div>
          {tab !== "results" && (
            <button
              type="button"
              className="text-button"
              onClick={tab === "logs" ? bridge.clearLogs : bridge.clearEvents}
            >
              Clear
            </button>
          )}
        </div>
        <div className="debug-content" tabIndex={0} aria-label={`${tab} output`}>
          {tab === "results" && <DiagnosticResults bridge={bridge} />}
          {tab === "events" && <DiagnosticEvents bridge={bridge} />}
          {tab === "logs" && <DiagnosticLogs bridge={bridge} />}
        </div>
      </div>

      <details className="disclosure runtime-details">
        <summary>Runtime details <Icon name="chevron" size={16} /></summary>
        {bridge.bootstrapState && (
          <dl>
            <div>
              <dt>Desktop</dt>
              <dd>
                {bridge.bootstrapState.platform} · {bridge.bootstrapState.arch} · v{bridge.bootstrapState.appVersion}
              </dd>
            </div>
            <div>
              <dt>Electron / Chromium / Node</dt>
              <dd>
                {bridge.bootstrapState.electronVersion} / {bridge.bootstrapState.chromiumVersion} / {bridge.bootstrapState.nodeVersion}
              </dd>
            </div>
          </dl>
        )}
        <pre>{JSON.stringify(bridge.bridgeStatus, null, 2)}</pre>
        {bridge.currentProgress && <pre>{JSON.stringify(bridge.currentProgress, null, 2)}</pre>}
      </details>
    </section>
  );
}
