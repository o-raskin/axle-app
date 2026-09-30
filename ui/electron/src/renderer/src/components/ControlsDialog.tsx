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
    ["Speed mode", "D-pad ↑ / ↓"],
    ["Lights · while stopped", controls.lights],
    ["Flash lights", controls.signal],
    ["End the drive", controls.exit]
  ];
  const subtitle = selectedGamepad && bridge.selectedGamepad !== "auto"
    ? `Controls for ${selectedGamepad.name}.`
    : "Familiar controls for DualSense, Xbox-style controllers and Steam Deck.";

  return (
    <Dialog title="Your hands know the way." subtitle={subtitle} onClose={onClose}>
      <div className="controls-intro">
        <Icon name="controller" size={42} />
        <p>
          Pair your controller in your computer’s Bluetooth settings, or plug it in with USB.
          Then turn on the vehicle and select <strong>Connect vehicle</strong>.
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
        Leave room around your vehicle. Its steering moves briefly while it gets ready.
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
