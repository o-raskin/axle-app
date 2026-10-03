import { useEffect, useState } from "react";
import type { FormEvent } from "react";
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
  const [hubName, setHubName] = useState(bridge.hubName);
  const [hubAddress, setHubAddress] = useState(bridge.hubAddress);
  const [connectionSettingsApplied, setConnectionSettingsApplied] = useState(false);

  useEffect(() => {
    setHubName(bridge.hubName);
    setHubAddress(bridge.hubAddress);
  }, [bridge.hubName, bridge.hubAddress]);

  const connectionSettingsChanged = hubName !== bridge.hubName || hubAddress !== bridge.hubAddress;

  function applyConnectionSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (bridge.loading || !connectionSettingsChanged) return;
    bridge.setHubName(hubName);
    bridge.setHubAddress(hubAddress);
    setConnectionSettingsApplied(true);
  }

  if (!bridge.settings || !bridge.bootstrapState) {
    return null;
  }

  return (
    <Dialog title="Settings" subtitle="Preferences for your vehicle and desktop." onClose={onClose}>
      <section className="settings-section">
        <h3>Vehicle</h3>
        {bridge.profiles?.models.length === 1 ? (
          <div className="field">
            <p className="settings-value">{bridge.profiles.models[0].name}</p>
            <small>Axle manages the connection automatically.</small>
          </div>
        ) : <label className="field">
          <span>Vehicle model</span>
          <select aria-label="Vehicle model" value={bridge.selectedModel} disabled={!bridge.profiles || bridge.loading}
            onChange={(event) => bridge.setSelectedModel(event.target.value)}>
            {bridge.profiles?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
          <small>Tumbler is currently supported. Axle manages the connection automatically.</small>
        </label>}
      </section>
      <section className="settings-section">
        <h3>Controller</h3>
        <label className="field">
          <span>Controller profile</span>
          <select
            value={bridge.selectedGamepad}
            disabled={!bridge.profiles || bridge.loading}
            onChange={(event) => bridge.setSelectedGamepad(event.target.value)}
          >
            {bridge.profiles?.gamepads.map((gamepad) => (
              <option key={gamepad.id} value={gamepad.id}>
                {gamepad.id === "auto" ? "Automatic · recommended" : gamepad.name}
              </option>
            ))}
          </select>
          <small>
            {bridge.connectionPaused ? "Changes take effect when you resume the connection."
              : bridge.bridgeActive && !bridge.discoveryActive
              ? "Axle reconnects automatically when you change the controller."
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
        <form onSubmit={applyConnectionSettings}>
          <fieldset disabled={bridge.loading}>
            <label className="field">
              <span>Hub name</span>
              <input
                value={hubName}
                onChange={(event) => {
                  setHubName(event.target.value);
                  setConnectionSettingsApplied(false);
                }}
                placeholder="Technic Move"
              />
            </label>
            <label className="field">
              <span>Bluetooth address <span className="optional">Optional</span></span>
              <input
                value={hubAddress}
                onChange={(event) => {
                  setHubAddress(event.target.value);
                  setConnectionSettingsApplied(false);
                }}
                placeholder="Find automatically"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
              />
              <small>Leave empty to find the hub by name.</small>
            </label>
          </fieldset>
          <div className="connection-preferences__actions">
            <button type="submit" className="button" disabled={bridge.loading || !connectionSettingsChanged}>
              Apply changes
            </button>
            {connectionSettingsApplied && <p className="small-note" role="status">Connection settings applied.</p>}
          </div>
        </form>
        <p className="small-note">{bridge.connectionPaused
          ? "Changes take effect when you resume the connection."
          : "Applying changes reconnects your vehicle automatically."}</p>
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
    </Dialog>
  );
}
