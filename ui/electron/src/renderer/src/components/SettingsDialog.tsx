import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import type { BridgeController } from "./types";

type SettingsDialogProps = {
  bridge: BridgeController;
  showDebug: boolean;
  onDebugChange: (enabled: boolean) => void;
  onOpenDiagnostics: () => void;
  onClose: () => void;
};

export function SettingsDialog({
  bridge,
  showDebug,
  onDebugChange,
  onOpenDiagnostics,
  onClose
}: SettingsDialogProps) {
  if (!bridge.settings || !bridge.bootstrapState) {
    return null;
  }

  return (
    <Dialog title="Make it yours" subtitle="A few preferences for your next drive." onClose={onClose}>
      <section className="settings-section">
        <h3>Controller</h3>
        <label className="field">
          <span>Controller profile</span>
          <select
            value={bridge.selectedGamepad}
            disabled={!bridge.profiles || bridge.bridgeActive || !!bridge.pendingAction}
            onChange={(event) => bridge.setSelectedGamepad(event.target.value)}
          >
            {bridge.profiles?.gamepads.map((gamepad) => (
              <option key={gamepad.id} value={gamepad.id}>
                {gamepad.id === "auto" ? "Automatic · recommended" : gamepad.name}
              </option>
            ))}
          </select>
          <small>
            {bridge.bridgeActive
              ? "Stop your session to change the controller."
              : "Automatic finds the right profile for your connected controller."}
          </small>
        </label>
      </section>

      <section className="settings-section">
        <h3>Desktop</h3>
        <label className="switch-row">
          <span>
            <strong>Fullscreen</strong>
            <small>Fill the screen now and on your next launch.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={bridge.settings.launchFullscreen}
            disabled={bridge.settingsSaving}
            onChange={(event) => bridge.updateFullscreen(event.target.checked)}
          />
          <span className="switch-control" aria-hidden="true" />
        </label>
        {bridge.settingsError && (
          <p className="inline-error" role="alert">{bridge.settingsError}</p>
        )}
      </section>

      <details className="disclosure">
        <summary>Advanced connection <Icon name="chevron" size={16} /></summary>
        <p className="section-description">Use these only if your hub needs a specific name or address.</p>
        <fieldset disabled={bridge.bridgeActive || !!bridge.pendingAction}>
          <label className="field">
            <span>Hub name</span>
            <input
              value={bridge.hubName}
              onChange={(event) => bridge.setHubName(event.target.value)}
              placeholder="Technic Move"
            />
          </label>
          <label className="field">
            <span>Bluetooth address <span className="optional">Optional</span></span>
            <input
              value={bridge.hubAddress}
              onChange={(event) => bridge.setHubAddress(event.target.value)}
              placeholder="Find automatically"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
            />
            <small>Leave empty to find the hub by name.</small>
          </label>
        </fieldset>
        {bridge.bridgeActive && (
          <p className="small-note">Stop your session to change connection settings.</p>
        )}
      </details>

      <section className="settings-section">
        <label className="switch-row">
          <span>
            <strong>Developer mode</strong>
            <small>Show device checks, event history and technical logs.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={showDebug}
            onChange={(event) => onDebugChange(event.target.checked)}
          />
          <span className="switch-control" aria-hidden="true" />
        </label>
        {showDebug && (
          <button type="button" className="text-button settings-link" onClick={onOpenDiagnostics}>
            Open diagnostics <Icon name="arrow" size={16} />
          </button>
        )}
      </section>

      <p className="about-note">
        Axle · {bridge.bootstrapState.appVersion}<br />
        An independent project. Not affiliated with, endorsed by, or sponsored by the LEGO Group.
        LEGO® is a trademark of the LEGO Group.
      </p>
      {bridge.bridgeActive && (
        <div className="dialog-safety">
          <button
            type="button"
            className="button button--stop"
            onClick={bridge.stopBridge}
            disabled={!bridge.canStop || bridge.pendingAction === "stop"}
          >
            <Icon name="pause" />
            {bridge.pendingAction === "stop" ? "Stopping…" : "Stop session"}
          </button>
        </div>
      )}
    </Dialog>
  );
}
