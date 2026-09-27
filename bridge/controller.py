"""Gamepad discovery, probing, and input normalization."""

from __future__ import annotations

from typing import Any

from .platform import configure_process_for_platform
from .profiles import GamepadProfile
from .settings import AXIS_REPORT_STEP, DUALSENSE_GAMEPAD_HINTS, NON_DUALSENSE_GAMEPAD_HINTS


def axis_to_percent(value: float, limit: int, deadzone: float) -> int:
    """Scale a joystick axis to a signed integer with deadzone protection."""
    if abs(value) < deadzone:
        return 0
    return int(max(-1.0, min(1.0, value)) * limit)


def trigger_amount(value: float, rest_negative: bool, deadzone: float) -> float:
    """Normalize a trigger axis to 0..1."""
    amount = (value + 1.0) / 2.0 if rest_negative else value
    if amount < deadzone:
        return 0.0
    return max(0.0, min(1.0, amount))


def read_trigger_pressures(joystick: Any, pad: GamepadProfile) -> tuple[float, float]:
    """Return forward and reverse trigger pressure as independent 0..1 values."""
    rest = pad.triggers_rest_negative
    forward = trigger_amount(joystick.get_axis(pad.axis("throttle_forward")), rest, pad.trigger_deadzone)
    reverse = trigger_amount(joystick.get_axis(pad.axis("throttle_reverse")), rest, pad.trigger_deadzone)
    return forward, reverse


def read_drive_state(
    joystick: Any,
    pad: GamepadProfile,
    max_drive: int,
    speed_mode: int,
) -> tuple[int, float, float, float]:
    """Return throttle, net trigger pressure, forward pressure and reverse pressure."""
    from .feedback import drive_power_for_trigger  # noqa: PLC0415

    forward, reverse = read_trigger_pressures(joystick, pad)
    trigger_balance = forward - reverse
    throttle = drive_power_for_trigger(trigger_balance, max_drive, speed_mode)
    return throttle, abs(trigger_balance), forward, reverse


def read_drive_input(joystick: Any, pad: GamepadProfile, max_drive: int, speed_mode: int) -> tuple[int, float]:
    """Return throttle plus net trigger pressure from one trigger sample."""
    throttle, trigger_pressure, _, _ = read_drive_state(joystick, pad, max_drive, speed_mode)
    return throttle, trigger_pressure


def read_throttle(joystick: Any, pad: GamepadProfile, max_drive: int, speed_mode: int) -> int:
    """Forward trigger minus reverse trigger, scaled by the selected speed mode."""
    throttle, _ = read_drive_input(joystick, pad, max_drive, speed_mode)
    return throttle


def button_held(joystick: Any, index: int) -> bool:
    """Return whether a button index exists and is currently pressed."""
    return index < joystick.get_numbuttons() and bool(joystick.get_button(index))


def gamepad_name_is_dualsense(name: str) -> bool:
    """Return whether a pygame joystick name looks like a DualSense controller."""
    lowered = name.lower()
    if any(hint in lowered for hint in NON_DUALSENSE_GAMEPAD_HINTS):
        return False
    return any(hint in lowered for hint in DUALSENSE_GAMEPAD_HINTS)


def refresh_joystick_subsystem(pygame_mod: Any) -> None:
    """Force SDL/pygame to rescan gamepads before each discovery attempt."""
    pygame_mod.init()
    joystick_module = pygame_mod.joystick
    get_init = getattr(joystick_module, "get_init", None)
    if get_init is not None and get_init():
        joystick_module.quit()
    joystick_module.init()
    event_module = getattr(pygame_mod, "event", None)
    pump = getattr(event_module, "pump", None)
    if pump is not None:
        pump()


def init_gamepad(profile: GamepadProfile | None = None) -> tuple[Any, Any]:
    """Open a matching gamepad, defaulting to DualSense-compatible names."""
    configure_process_for_platform()

    import pygame  # noqa: PLC0415  (kept out of import time: pygame and bleak fight over COM apartment)

    refresh_joystick_subsystem(pygame)
    if pygame.joystick.get_count() == 0:
        pygame.quit()
        raise RuntimeError("No gamepad detected")

    found_names = []
    fallback: Any | None = None
    for index in range(pygame.joystick.get_count()):
        joystick = pygame.joystick.Joystick(index)
        joystick.init()
        name = joystick.get_name()
        found_names.append(name)
        if fallback is None:
            fallback = joystick
        if profile is not None and profile.matches_device_name(name):
            return pygame, joystick
        if profile is None and gamepad_name_is_dualsense(name):
            return pygame, joystick

    if profile is not None and not profile.name_hints and fallback is not None:
        return pygame, fallback

    pygame.quit()
    found = ", ".join(found_names) or "unknown controller"
    target = profile.name if profile is not None else "DualSense"
    raise RuntimeError(f"{target} controller not found (detected: {found})")


def try_init_gamepad(profile: GamepadProfile | None = None) -> tuple[Any | None, Any | None, str | None]:
    """Try to open a gamepad once, returning an actionable issue instead of raising."""
    try:
        pygame_mod, joystick = init_gamepad(profile)
        return pygame_mod, joystick, None
    except Exception as exc:
        return None, None, str(exc)


def gamepad_was_disconnected(pygame_mod: Any, joystick: Any) -> bool:
    """Detect a controller removal event before reading axes/buttons."""
    try:
        pygame_mod.event.pump()
        instance_id = joystick.get_instance_id() if hasattr(joystick, "get_instance_id") else None
        for event in pygame_mod.event.get():
            if event.type != getattr(pygame_mod, "JOYDEVICEREMOVED", object()):
                continue
            if instance_id is None or getattr(event, "instance_id", None) == instance_id:
                return True
        return not joystick.get_init() or pygame_mod.joystick.get_count() == 0
    except Exception:
        return True


def snapshot(joystick: Any) -> dict[str, Any]:
    """Return a compact snapshot of joystick axes, buttons and hats."""
    return {
        "axes": [round(joystick.get_axis(i), 3) for i in range(joystick.get_numaxes())],
        "buttons": [joystick.get_button(i) for i in range(joystick.get_numbuttons())],
        "hats": [joystick.get_hat(i) for i in range(joystick.get_numhats())],
    }


def run_probe(pygame: Any, joystick: Any) -> None:
    """Print changed joystick axes/buttons until interrupted."""
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
                for index, (old, new) in enumerate(zip(prev[kind], current[kind])):
                    moved = abs(old - new) >= AXIS_REPORT_STEP if kind == "axes" else old != new
                    if moved:
                        print(f"{kind[:-1]}[{index}] {old} -> {new}")

            prev = current
            pygame.time.delay(30)
    except KeyboardInterrupt:
        print("\nProbe stopped.")
    finally:
        pygame.quit()
