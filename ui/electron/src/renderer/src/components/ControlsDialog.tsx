import { controllerControls } from "./controllerControls";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import type { BridgeController } from "./types";

type ControlsDialogProps = {
  bridge: BridgeController;
  onClose: () => void;
};

export function ControlsDialog({ bridge, onClose }: ControlsDialogProps) {
  const selectedGamepad = bridge.profiles?.gamepads.find((gamepad) => gamepad.id === bridge.selectedGamepad);
  const controls = controllerControls(bridge.selectedGamepad);
  const mappings = [
    ["Steer", "Left stick"],
    ["Drive forward", controls.forward],
    ["Reverse", controls.reverse],
    ["Brake", controls.brake],
    ["Boost", controls.boost],
    ["Drive power", "D-pad ↑ / ↓"],
    ["Lights · while stopped", controls.lights],
    ["Flash lights", controls.signal],
    ["Restart connection", controls.exit]
  ];
  const subtitle = selectedGamepad && bridge.selectedGamepad !== "auto"
    ? `Controls for ${selectedGamepad.name}.`
    : "Familiar controls for DualSense, Xbox-style controllers and Steam Deck.";

  return (
    <Dialog title="How to drive" subtitle={subtitle} onClose={onClose}>
      <div className="controls-intro">
        <Icon name="controller" size={42} />
        <p>
          Pair your controller in your computer’s Bluetooth settings, or plug it in with USB.
          Turn on your vehicle’s hub. Axle finds your devices and gets the vehicle ready automatically.
        </p>
      </div>
      <dl className="control-mapping">
        {mappings.map(([action, key]) => (
          <div key={action}>
            <dt>{action}</dt>
            <dd><span className="keycap">{key}</span></dd>
          </div>
        ))}
      </dl>
      <p className="guide-note">
        <Icon name="help" size={18} />
        Keep the vehicle still with its wheels off the ground during setup. Steering moves briefly;
        control starts automatically when it’s ready.
      </p>
      {bridge.bridgeActive && (
        <div className="dialog-safety">
          {bridge.actionError && <p className="notice notice--error" role="alert">{bridge.actionError}</p>}
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
      {bridge.connectionPaused && !bridge.bridgeActive && (
        <p className="guide-note" role="status">Connection paused. Close this guide to resume from Drive.</p>
      )}
    </Dialog>
  );
}
