import os
import sys

os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"
if sys.platform == "win32":
    sys.coinit_flags = 0  # type: ignore[attr-defined]

import argparse
import asyncio
from typing import Any

from bleak.backends.winrt.util import allow_sta, uninitialize_sta

from bridge.low_level_control import LowLevelControl
from bridge.port_map import load_port_map, port_id
from bridge.profiles import PORT_MAP_PATH, GamepadProfile, ModelProfile
from bridge.safety import SafetyLimits, require_user_acknowledgement
from bridge.transport import TechnicMoveHub

LOOP_INTERVAL_S = 0.05
AXIS_REPORT_STEP = 0.05


def axis_to_percent(value: float, limit: int, deadzone: float) -> int:
    if abs(value) < deadzone:
        return 0
    return int(max(-1.0, min(1.0, value)) * limit)


def trigger_amount(value: float, rest_negative: bool, deadzone: float) -> float:
    amount = (value + 1.0) / 2.0 if rest_negative else value
    if amount < deadzone:
        return 0.0
    return max(0.0, min(1.0, amount))


def read_throttle(joystick: Any, pad: GamepadProfile, limit: int) -> int:
    """Forward trigger minus reverse trigger, scaled to the model's ceiling."""
    rest = pad.triggers_rest_negative
    forward = trigger_amount(joystick.get_axis(pad.axis("throttle_forward")), rest, pad.deadzone)
    reverse = trigger_amount(joystick.get_axis(pad.axis("throttle_reverse")), rest, pad.deadzone)
    return int((forward - reverse) * limit)


def button_held(joystick: Any, index: int) -> bool:
    return index < joystick.get_numbuttons() and bool(joystick.get_button(index))


def init_gamepad() -> tuple[Any, Any]:
    import pygame  # noqa: PLC0415  (kept out of import time: pygame and bleak fight over COM apartment)

    pygame.init()
    pygame.joystick.init()
    if pygame.joystick.get_count() == 0:
        raise RuntimeError("No gamepad detected")
    joystick = pygame.joystick.Joystick(0)
    joystick.init()
    return pygame, joystick


def snapshot(joystick: Any) -> dict[str, Any]:
    return {
        "axes": [round(joystick.get_axis(i), 3) for i in range(joystick.get_numaxes())],
        "buttons": [joystick.get_button(i) for i in range(joystick.get_numbuttons())],
        "hats": [joystick.get_hat(i) for i in range(joystick.get_numhats())],
    }


def run_probe(pygame: Any, joystick: Any) -> None:
    print(f"Gamepad: {joystick.get_name()}")
    print(f"axes={joystick.get_numaxes()} buttons={joystick.get_numbuttons()} hats={joystick.get_numhats()}")
    print("Press buttons / move sticks. Ctrl+C to stop.\n")

    prev = snapshot(joystick)
    print(f"start axes={prev['axes']}")
    print(f"start buttons={prev['buttons']}")
    if prev["hats"]:
        print(f"start hats={prev['hats']}")

    try:
        while True:
            pygame.event.pump()
            current = snapshot(joystick)

            for kind in ("axes", "buttons", "hats"):
                for index, (old, new) in enumerate(zip(prev[kind], current[kind], strict=False)):
                    moved = abs(old - new) >= AXIS_REPORT_STEP if kind == "axes" else old != new
                    if moved:
                        print(f"{kind[:-1]}[{index}] {old} -> {new}")

            prev = current
            pygame.time.delay(30)
    except KeyboardInterrupt:
        print("\nProbe stopped.")
    finally:
        pygame.quit()


async def safe_shutdown(control: LowLevelControl | None, hub: TechnicMoveHub, pygame_mod: Any) -> None:
    """Stop the car, drop the link and close pygame, from whatever state we are in."""
    print("Stopping motors...")
    try:
        if control is not None and hub.is_connected:
            await control.drive(0, 0)
    except Exception as exc:
        print(f"Stop command failed: {exc}")
    try:
        await hub.disconnect()
    except Exception as exc:
        print(f"Disconnect failed: {exc}")
    try:
        if pygame_mod is not None:
            pygame_mod.quit()
    except Exception:
        pass
    print("Safe exit.")


async def run_control(model_name: str, gamepad_name: str) -> None:
    model = ModelProfile.load(model_name)
    pad = GamepadProfile.load(gamepad_name)
    require_user_acknowledgement(
        f"About to start live gamepad control of the {model.name} with a {pad.name}.\n"
        "Keep the model safe and be ready to release the sticks."
    )

    port_map = load_port_map(PORT_MAP_PATH)
    limits = SafetyLimits(max_drive_power=model.max_drive, max_steering_power=model.max_steering)

    hub = TechnicMoveHub(
        hub_name=port_map["hub"]["name"],
        hub_address=port_map["hub"].get("address"),
    )
    control = None
    pygame_mod = None

    print("Connecting to hub...")
    await hub.connect()
    await hub.wait_for_topology()
    for role in ("steering", "drive_left", "drive_right", "play_vm"):
        port = port_id(port_map, role)
        if port not in hub.attached_devices:
            raise RuntimeError(f"{role} port {port:#04x} never attached — hub not ready")
    print(f"Hub ready: {len(hub.attached_devices)} ports attached")

    control = LowLevelControl(hub, port_map, model, limits)
    print("Starting PLAYVM (link rears, subscribe, calibrate)...")
    virtual_port, status, flags = await control.start_play_vm()
    print(f"  calibration status {status:#07x}: {', '.join(flags)}")
    print(f"  rears mixed on virtual port {virtual_port:#04x}")

    if sys.platform == "win32":
        uninitialize_sta()
        allow_sta()

    pygame_mod, joystick = init_gamepad()
    print(f"Gamepad: {joystick.get_name()} (axes={joystick.get_numaxes()}, buttons={joystick.get_numbuttons()})")
    print(f"Drive ±{model.max_drive}, steering ±{model.max_steering}")
    print(pad.controls)
    print("Ctrl+C: safe stop and exit")
    print("Ready.")

    # Resolved once: fixed for the session, and this loop runs at 20 Hz.
    brake_button = pad.button("brake")
    boost_button = pad.button("boost")
    lights_button = pad.button("lights")
    steer_axis = pad.axis("steer")
    boost_hold = model.boost["hold_s"]
    boost_cooldown = model.boost["cooldown_s"]

    headlights_on = True
    lights_prev = False
    boost_prev = False
    boost_until = 0.0
    boost_ready_at = 0.0
    last_cmd = None
    loop = asyncio.get_running_loop()

    try:
        while True:
            pygame_mod.event.pump()
            if not hub.is_connected:
                print("\nHub disconnected.")
                break

            brake = button_held(joystick, brake_button)
            throttle = 0 if brake else read_throttle(joystick, pad, model.max_drive)

            now = loop.time()
            boost_pressed = button_held(joystick, boost_button)
            if boost_pressed and not boost_prev and now >= boost_ready_at and not brake:
                boost_until = now + boost_hold
                boost_ready_at = boost_until + boost_cooldown
                print(f"boost fired, ready again in {boost_hold + boost_cooldown:.1f}s")
            elif boost_pressed and not boost_prev:
                print(f"boost not ready ({boost_ready_at - now:.1f}s left)")
            boost_prev = boost_pressed
            if brake:
                boost_until = 0.0  # braking cancels the boost, as DisableBoost does
            boost = now < boost_until

            lights_pressed = button_held(joystick, lights_button)
            if lights_pressed and not lights_prev:
                headlights_on = not headlights_on
            lights_prev = lights_pressed

            steering = axis_to_percent(joystick.get_axis(steer_axis), model.max_steering, pad.deadzone)

            # The app only emits a frame when something changed (every field is a Dirty<T>),
            # so a repeated command is never resent — the hub treats the bits as levels.
            cmd = (throttle, steering, brake, boost, headlights_on)
            if cmd != last_cmd:
                print(
                    f"cmd speed={throttle} steer={steering} brake={brake} "
                    f"boost={boost} lights={'on' if headlights_on else 'off'}"
                )
                await control.drive(throttle, steering, brake=brake, boost=boost, lights=headlights_on)
                last_cmd = cmd
            await asyncio.sleep(LOOP_INTERVAL_S)
    except (KeyboardInterrupt, asyncio.CancelledError):
        print("\nInterrupt — shutting down...")
    except (OSError, RuntimeError) as exc:
        # The link can drop between the check above and the write; that is not a crash.
        print(f"\nLink lost: {type(exc).__name__}: {exc}")
    finally:
        await safe_shutdown(control, hub, pygame_mod)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--arm", action="store_true", help="Live control with hub")
    parser.add_argument("--probe", action="store_true", help="Log all gamepad axes/buttons (no hub)")
    parser.add_argument("--model", default="tumbler", help="Model profile in config/models/")
    parser.add_argument("--gamepad", default="dualsense", help="Gamepad profile in config/gamepads/")
    args = parser.parse_args()

    if args.probe:
        pygame_mod, joystick = init_gamepad()
        run_probe(pygame_mod, joystick)
        return

    if not args.arm:
        raise RuntimeError("Pass --arm for live control, or --probe to map the gamepad")

    await run_control(args.model, args.gamepad)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nExited.")
