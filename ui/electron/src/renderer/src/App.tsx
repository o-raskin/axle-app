import { useEffect, useState } from "react";

import { ControlsDialog } from "./components/ControlsDialog";
import { controllerControls } from "./components/controllerControls";
import { DiagnosticsView, type DiagnosticTab } from "./components/DiagnosticsView";
import { Icon } from "./components/Icon";
import { SettingsDialog } from "./components/SettingsDialog";
import { TumblerViewer } from "./components/TumblerViewer";
import { VehicleIllustration } from "./components/VehicleIllustration";
import { useBridgeController } from "./hooks/useBridgeController";
import { deriveVehicleVisualState, isTumblerModel } from "./lib/vehicleState";

type Sheet = "settings" | "controls" | null;

const connectionStatusLabels = {
  ready: "Connected",
  discovering: "Searching",
  detected: "Devices found",
  connecting: "Connecting",
  stopping: "Stopping",
  diagnostic: "Checking devices",
  error: "Needs attention",
  idle: "Not connected",
  disconnected: "Not connected"
};

function App() {
  const [sheet, setSheet] = useState<Sheet>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [debugTab, setDebugTab] = useState<DiagnosticTab>("results");
  const [page, setPage] = useState<"drive" | "diagnostics">("drive");
  const bridge = useBridgeController(page === "drive");
  const [exiting, setExiting] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);
  const { connection } = bridge;
  const ready = connection.phase === "ready";
  const busy = connection.phase === "connecting" || connection.phase === "stopping";
  const impactPaused = ready && bridge.telemetry?.crash === true;
  const vehicleNearby = bridge.discoveryActive && Boolean(bridge.discovery?.vehicleName);
  const selectedModel = bridge.profiles?.models.find((model) => model.id === bridge.selectedModel);
  const modelNumber = selectedModel?.name.match(/^\d+/)?.[0];
  const vehicleName = selectedModel?.name.replace(/^\d+\s*/, "") || "Choose your vehicle";
  const tumbler = isTumblerModel(bridge.selectedModel);
  const vehicleState = deriveVehicleVisualState({
    telemetry: bridge.telemetry,
    selectedModelId: bridge.selectedModel,
    ready,
    receivedAt: bridge.telemetryReceivedAt
  });
  const controls = controllerControls(bridge.selectedGamepad);
  const statusText = impactPaused ? "Control paused" : connectionStatusLabels[connection.phase];
  const connectionTitle = bridge.profileError
    ? "A little setup needed"
    : impactPaused ? "A moment to reset" : connection.title;
  const connectionDescription = bridge.profileError || (impactPaused
    ? "An impact was detected. Release the triggers while your vehicle resets."
    : connection.description);

  useEffect(() => {
    if (!showDebug) {
      setPage("drive");
    }
  }, [showDebug]);

  async function quitApp() {
    if (exiting) return;
    setExiting(true);
    setExitError(null);
    try {
      const result = await window.legoBridgeUi.quitApp();
      if (!result.ok) throw new Error(result.message);
    } catch {
      setExiting(false);
      setExitError("Axle could not confirm that control has stopped. Try Exit again, or turn off the vehicle.");
    }
  }

  const exitButton = (
    <button type="button" className="exit-button" aria-label="Quit Axle" title="Quit Axle"
      onClick={() => { void quitApp(); }} disabled={exiting}>
      <Icon name="exit" /><span>{exiting ? "Exiting…" : "Exit"}</span>
    </button>
  );
  const exitNotice = exitError && <div className="notice notice--error" role="alert"><Icon name="warning" /><p>{exitError}</p></div>;

  function renderConnectionAction() {
    if (bridge.profileError) return <button type="button" className="button button--primary" onClick={bridge.retryInitialization}>Try again</button>;
    return <p className="small-note" role="status">{ready
      ? "Ready to drive. Use your controller."
      : "Axle connects and reconnects your devices automatically."}</p>;
  }

  if (bridge.loading) {
    return (
      <main className="startup">
        <div className="startup-exit">{exitButton}</div>
        <div className="brand-mark" aria-hidden="true"><span /><span /></div>
        <span className="spinner" />
        <h1>Getting things ready</h1>
        <p>Your next drive is a moment away.</p>
        {exitNotice}
        {bridge.bridgeActive && (
          <button type="button" className="button button--stop" onClick={bridge.stopBridge} disabled={!bridge.canStop}>
            <Icon name="pause" />{bridge.pendingAction === "stop" ? "Stopping…" : "Stop session"}
          </button>
        )}
      </main>
    );
  }

  if (bridge.startupError || !bridge.bootstrapState || !bridge.settings) {
    return (
      <main className="startup">
        <div className="startup-exit">{exitButton}</div>
        <Icon name="warning" size={36} />
        <h1>Let’s try that again</h1>
        {exitNotice}
        <p>
          {bridge.startupError || bridge.settingsError
            || "The desktop app could not start. Restart the app and try again."}
        </p>
        <button type="button" className="button button--primary" onClick={bridge.retryInitialization}>
          Try again <Icon name="arrow" />
        </button>
        {bridge.bridgeActive && (
          <button type="button" className="button button--stop" onClick={bridge.stopBridge} disabled={!bridge.canStop}>
            <Icon name="pause" />{bridge.pendingAction === "stop" ? "Stopping…" : "Stop session"}
          </button>
        )}
      </main>
    );
  }

  const pageTitle = page === "diagnostics"
    ? "Diagnostics"
    : impactPaused ? "A moment to reset." : ready ? "You’re in control." : "Let’s drive.";

  return (
    <div className={`app-shell ${bridge.bootstrapState.platform === "darwin" ? "app-shell--mac" : ""}`}>
      {bridge.bootstrapState.platform === "darwin" && <div className="window-drag-region" aria-hidden="true" />}
      <header className="app-header">
        <a className="brand" href="#main" aria-label="Axle home" onClick={() => setPage("drive")}>
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>axle<span className="brand-dot">.</span></span>
        </a>
        <nav className="navigation" aria-label="Main navigation">
          <button
            type="button"
            aria-current={page === "drive" ? "page" : undefined}
            onClick={() => setPage("drive")}
          >
            Drive
          </button>
          {showDebug && (
            <button
              type="button"
              aria-current={page === "diagnostics" ? "page" : undefined}
              onClick={() => setPage("diagnostics")}
            >
              Diagnostics
            </button>
          )}
        </nav>
        <div className="header-actions">
          <button type="button" className="text-button help-button" aria-label="How to drive" onClick={() => setSheet("controls")}>
            <Icon name="help" /><span>How to drive</span>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setSheet("settings")}
          >
            <Icon name="settings" />
          </button>
          {exitButton}
        </div>
      </header>

      <main id="main" className="workspace" tabIndex={-1}>
        {exitNotice}
        <div className="page-heading">
          <div>
            <p className="eyebrow">{page === "drive" ? "GOOD TIMES. BUILT BY YOU." : "A CLOSER LOOK"}</p>
            <h1>{pageTitle}</h1>
          </div>
          <span
            className={`status-pill ${ready && !impactPaused ? "status-pill--ready" : ""} ${impactPaused ? "status-pill--warning" : ""} ${busy ? "status-pill--busy" : ""}`}
            role="status"
          >
            <span className="status-dot" />{statusText}
          </span>
        </div>

        {page === "drive" ? (
          <>
            <div className="drive-layout">
              <section className={`vehicle-card ${ready ? "vehicle-card--connected" : ""} ${tumbler ? "vehicle-card--3d" : ""}`} aria-label="Your vehicle">
                <div className="vehicle-card__heading">
                  <span className="eyebrow">YOUR VEHICLE</span>
                  <span className="vehicle-tag">{tumbler ? "INTERACTIVE 3D" : "GAMEPAD CONTROL"}</span>
                </div>
                {tumbler
                  ? <TumblerViewer state={vehicleState} receivedAt={bridge.telemetryReceivedAt}
                    vehicleName={vehicleName} modelNumber={modelNumber} developerMode={showDebug} />
                  : <>
                    <div className="vehicle-art"><VehicleIllustration connected={ready} /></div>
                    <div className="vehicle-card__bottom">
                      <div className="vehicle-name">
                        <p className="eyebrow">{modelNumber ? `MODEL ${modelNumber}` : "YOUR BUILD"}</p>
                        <h2>{vehicleName}</h2>
                        <p>Built for a real-world adventure.</p>
                      </div>
                      <span className="vehicle-card__motif" aria-hidden="true"><i /><i /><i /></span>
                    </div>
                  </>}
              </section>

              <section
                className={`connect-card ${ready ? "connect-card--ready" : ""}`}
                aria-labelledby="connection-heading"
              >
                <div className={`connection-icon ${ready && !impactPaused ? "connection-icon--ready" : ""}`}>
                  <Icon name={impactPaused ? "pause" : ready ? "check" : connection.phase === "error" ? "warning" : "bluetooth"} size={25} />
                </div>
                <div className="connection-copy" aria-live="polite" aria-atomic="true">
                  <h2 id="connection-heading">{connectionTitle}</h2>
                  <p>{connectionDescription}</p>
                </div>
                <div className="device-list" aria-label="Connection checklist">
                  <div className="device-row">
                    <span className="device-icon"><Icon name="controller" size={25} /></span>
                    <div>
                      <strong>Controller</strong>
                      <span>{bridge.discoveryActive && bridge.discovery?.controllerName || (connection.controllerReady ? "Connected to your computer" : "Pair with your computer")}</span>
                    </div>
                    <span
                      className={`device-state ${connection.controllerReady ? "device-state--done" : ""}`}
                      aria-label={connection.controllerReady ? "Controller connected" : "Controller waiting"}
                    >
                      {connection.controllerReady ? <Icon name="check" size={15} /> : "1"}
                    </span>
                  </div>
                  <div className="device-row">
                    <span className="device-icon"><Icon name="vehicle" size={25} /></span>
                    <div>
                      <strong>Vehicle</strong>
                      <span>{vehicleNearby ? "Hub detected nearby" : connection.vehicleReady ? "Hub connected" : "Press your hub’s power button"}</span>
                    </div>
                    <span
                      className={`device-state ${connection.vehicleReady || vehicleNearby ? "device-state--done" : ""}`}
                      aria-label={vehicleNearby ? "Vehicle detected" : connection.vehicleReady ? "Vehicle connected" : "Vehicle waiting"}
                    >
                      {connection.vehicleReady || vehicleNearby ? <Icon name="check" size={15} /> : "2"}
                    </span>
                  </div>
                </div>
                {bridge.actionError && bridge.actionError !== connectionDescription && (
                  <div className="notice notice--error" role="alert">
                    <Icon name="warning" size={18} />
                    <p>{bridge.actionError}</p>
                  </div>
                )}
                <div className="connection-actions">
                  {renderConnectionAction()}
                  <p className="connection-footnote">
                    {ready
                      ? "Keep the app open while you drive."
                      : bridge.bridgeActive
                        ? "Keep your controller and vehicle nearby."
                        : "We’ll find your controller and vehicle."}
                  </p>
                </div>
              </section>
            </div>

            <section className="quick-guide" aria-label="Driving essentials">
              <div className="quick-guide__title">
                <span className="eyebrow">THE BASICS</span>
                <h2>Pick up. Play.</h2>
                <button type="button" className="text-button" onClick={() => setSheet("controls")}>
                  All controls <Icon name="arrow" size={16} />
                </button>
              </div>
              <div className="control-tip">
                <span className="stick-key" aria-hidden="true"><i /></span>
                <div><strong>Find your line</strong><span>Left stick to steer</span></div>
              </div>
              <div className="control-tip">
                <span className="control-key">{controls.forward}</span>
                <div><strong>Set the pace</strong><span>Right trigger to drive</span></div>
              </div>
              <div className="control-tip">
                <span className="control-key">{controls.brake}</span>
                <div><strong>Take a breather</strong><span>Left bumper to brake</span></div>
              </div>
            </section>
          </>
        ) : (
          <DiagnosticsView bridge={bridge} tab={debugTab} onTabChange={setDebugTab} />
        )}

        <footer className="app-footer">
          <span>An independent companion for LEGO® Technic.</span>
          <span className="footer-detail">Made for the joy of driving.</span>
        </footer>
      </main>

      {sheet === "settings" && (
        <SettingsDialog
          bridge={bridge}
          showDebug={showDebug}
          onDebugChange={setShowDebug}
          onOpenDiagnostics={() => {
            setSheet(null);
            setPage("diagnostics");
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "controls" && <ControlsDialog bridge={bridge} onClose={() => setSheet(null)} />}
    </div>
  );
}

export default App;
