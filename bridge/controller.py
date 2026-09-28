"""Gamepad discovery, probing, and input normalization."""

from __future__ import annotations

import os
import sys
from typing import Any

from .platform import STEAM_DECK_SDL_HINTS, configure_process_for_platform
from .profiles import GamepadProfile
from .settings import AXIS_REPORT_STEP, DUALSENSE_GAMEPAD_HINTS, NON_DUALSENSE_GAMEPAD_HINTS

SDL_CONTROLLER_AXIS_MAX = 32767.0
SDL_CONTROLLER_TRIGGER_AXES = {4, 5}
SDL_CONTROLLER_AXIS_COUNT = 6
SDL_CONTROLLER_BUTTON_COUNT = 21


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


class SdlGameControllerJoystick:
    """Expose pygame's SDL2 GameController handle through the joystick methods the bridge uses."""

    def __init__(self, controller: Any, name: str, index: int) -> None:
        """Keep the SDL controller handle plus its stable discovery name and index."""
        self._controller = controller
        self._name = name
        self._index = index
        try:
            self._joystick = controller.as_joystick()
        except Exception:
            self._joystick = None

    def get_name(self) -> str:
        """Return the SDL GameController name."""
        return self._name

    def get_axis(self, index: int) -> float:
        """Return axes as -1..1, including triggers as -1 at rest for existing profiles."""
        raw = float(self._controller.get_axis(index))
        if index in SDL_CONTROLLER_TRIGGER_AXES:
            return max(-1.0, min(1.0, (raw / SDL_CONTROLLER_AXIS_MAX * 2.0) - 1.0))
        return max(-1.0, min(1.0, raw / SDL_CONTROLLER_AXIS_MAX))

    def get_button(self, index: int) -> int:
        """Return a standardized SDL GameController button state."""
        return int(bool(self._controller.get_button(index)))

    def get_numaxes(self) -> int:
        """Return the SDL GameController axis count."""
        return SDL_CONTROLLER_AXIS_COUNT

    def get_numbuttons(self) -> int:
        """Return enough buttons for SDL's standard and extended controller buttons."""
        return SDL_CONTROLLER_BUTTON_COUNT

    def get_numhats(self) -> int:
        """SDL GameController exposes D-pad as buttons, not hats."""
        return 0

    def get_hat(self, _index: int) -> tuple[int, int]:
        """Return neutral hat state for joystick diagnostics compatibility."""
        return (0, 0)

    def get_init(self) -> bool:
        """Return whether the SDL controller remains attached."""
        try:
            attached = self._controller.attached()
        except Exception:
            attached = False
        try:
            initialized = self._controller.get_init()
        except Exception:
            initialized = attached
        return bool(attached and initialized)

    def get_instance_id(self) -> int:
        """Return the underlying joystick instance id when SDL exposes it."""
        if self._joystick is not None:
            try:
                return int(self._joystick.get_instance_id())
            except Exception:
                pass
        return self._index

    def get_guid(self) -> str:
        """Return the underlying joystick GUID when available."""
        if self._joystick is not None:
            try:
                return str(self._joystick.get_guid())
            except Exception:
                pass
        return "unknown"

    def get_power_level(self) -> str:
        """Return the underlying joystick power level when available."""
        if self._joystick is not None:
            try:
                return str(self._joystick.get_power_level())
            except Exception:
                pass
        return "unknown"

    def rumble(self, low_frequency: float, high_frequency: float, duration_ms: int) -> bool:
        """Use SDL GameController rumble when pygame exposes it."""
        try:
            return bool(self._controller.rumble(low_frequency, high_frequency, duration_ms))
        except Exception:
            return False

    def stop_rumble(self) -> bool:
        """Stop SDL GameController rumble when pygame exposes it."""
        try:
            return bool(self._controller.stop_rumble())
        except Exception:
            return False


def sdl2_controller_module(_pygame_mod: Any) -> Any | None:
    """Return pygame's SDL2 controller module when this pygame build ships it."""
    try:
        from pygame._sdl2 import controller as sdl2_controller  # noqa: PLC0415
    except Exception:
        return None
    return sdl2_controller


def refresh_joystick_subsystem(pygame_mod: Any, *, init_all: bool = True) -> None:
    """Force SDL/pygame to rescan gamepads before each discovery attempt."""
    if init_all:
        pygame_mod.init()
    sdl2_controller = sdl2_controller_module(pygame_mod)
    if sdl2_controller is not None:
        get_init = getattr(sdl2_controller, "get_init", None)
        try:
            if get_init is not None and get_init():
                sdl2_controller.quit()
        except Exception:
            pass
    joystick_module = pygame_mod.joystick
    get_init = getattr(joystick_module, "get_init", None)
    if get_init is not None and get_init():
        joystick_module.quit()
    joystick_module.init()
    if sdl2_controller is not None:
        try:
            sdl2_controller.init()
        except Exception:
            pass
    if not init_all:
        return
    event_module = getattr(pygame_mod, "event", None)
    pump = getattr(event_module, "pump", None)
    if pump is not None:
        pump()


def init_sdl_game_controller(profile: GamepadProfile | None, pygame_mod: Any) -> tuple[Any | None, list[str]]:
    """Open a matching SDL GameController, returning names seen for diagnostics."""
    sdl2_controller = sdl2_controller_module(pygame_mod)
    if sdl2_controller is None:
        return None, []

    names = []
    try:
        count = int(sdl2_controller.get_count())
    except Exception:
        return None, []

    fallback: tuple[int, str] | None = None
    for index in range(count):
        try:
            name = str(sdl2_controller.name_forindex(index) or f"SDL controller {index}")
        except Exception:
            name = f"SDL controller {index}"
        names.append(name)

        try:
            is_controller = bool(sdl2_controller.is_controller(index))
        except Exception:
            is_controller = False
        if not is_controller:
            continue

        if fallback is None:
            fallback = (index, name)
        if profile is not None and profile.matches_device_name(name):
            controller = sdl2_controller.Controller(index)
            return SdlGameControllerJoystick(controller, name, index), names
        if profile is None and gamepad_name_is_dualsense(name):
            controller = sdl2_controller.Controller(index)
            return SdlGameControllerJoystick(controller, name, index), names

    if profile is not None and not profile.name_hints and fallback is not None:
        index, name = fallback
        controller = sdl2_controller.Controller(index)
        return SdlGameControllerJoystick(controller, name, index), names

    return None, names


def init_gamepad(profile: GamepadProfile | None = None) -> tuple[Any, Any]:
    """Open a matching gamepad, defaulting to DualSense-compatible names."""
    configure_process_for_platform()

    import pygame  # noqa: PLC0415  (kept out of import time: pygame and bleak fight over COM apartment)

    refresh_joystick_subsystem(pygame)
    found_names = []

    controller, controller_names = init_sdl_game_controller(profile, pygame)
    found_names.extend(controller_names)
    if controller is not None:
        return pygame, controller

    joystick_count = pygame.joystick.get_count()
    if joystick_count == 0 and not found_names:
        pygame.quit()
        raise RuntimeError("No gamepad detected")

    fallback: Any | None = None
    for index in range(joystick_count):
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


def gamepad_diagnostics() -> str:
    """Return a plain-text SDL/Pygame controller discovery report."""
    configure_process_for_platform()

    import pygame  # noqa: PLC0415

    lines = [
        f"platform={sys.platform}",
        f"pygame={pygame.version.ver}",
        f"sdl={'.'.join(str(part) for part in pygame.get_sdl_version())}",
        f"pygame_file={getattr(pygame, '__file__', 'unknown')}",
    ]
    lines.extend(f"{name}={os.environ.get(name, '')}" for name in sorted(STEAM_DECK_SDL_HINTS))

    try:
        refresh_joystick_subsystem(pygame, init_all=False)
        sdl2_controller = sdl2_controller_module(pygame)
        if sdl2_controller is not None:
            try:
                controller_count = int(sdl2_controller.get_count())
            except Exception:
                controller_count = 0
            lines.append(f"controller_count={controller_count}")
            for index in range(controller_count):
                lines.extend(sdl_controller_diagnostic_lines(sdl2_controller, index))
        count = pygame.joystick.get_count()
        lines.append(f"joystick_count={count}")
        for index in range(count):
            joystick = pygame.joystick.Joystick(index)
            joystick.init()
            lines.extend(gamepad_diagnostic_lines(joystick, index))
    finally:
        pygame.quit()

    return "\n".join(lines)


def sdl_controller_diagnostic_lines(sdl2_controller: Any, index: int) -> list[str]:
    """Return diagnostic lines for one SDL GameController candidate."""
    try:
        name = str(sdl2_controller.name_forindex(index) or "unknown")
    except Exception as exc:
        name = f"error:{type(exc).__name__}:{exc}"
    try:
        is_controller = str(bool(sdl2_controller.is_controller(index)))
    except Exception as exc:
        is_controller = f"error:{type(exc).__name__}:{exc}"
    return [
        f"controller[{index}].name={name}",
        f"controller[{index}].is_controller={is_controller}",
    ]


def gamepad_diagnostic_lines(joystick: Any, index: int) -> list[str]:
    """Return diagnostic lines for one pygame joystick."""
    name = joystick.get_name()
    guid = call_or_unknown(joystick, "get_guid")
    instance_id = call_or_unknown(joystick, "get_instance_id")
    power = call_or_unknown(joystick, "get_power_level")
    axes = joystick.get_numaxes()
    buttons = joystick.get_numbuttons()
    hats = joystick.get_numhats()
    return [
        f"joystick[{index}].name={name}",
        f"joystick[{index}].guid={guid}",
        f"joystick[{index}].instance_id={instance_id}",
        f"joystick[{index}].power={power}",
        f"joystick[{index}].axes={axes}",
        f"joystick[{index}].buttons={buttons}",
        f"joystick[{index}].hats={hats}",
    ]


def call_or_unknown(owner: Any, method_name: str) -> str:
    """Call an optional zero-argument pygame method for diagnostics."""
    method = getattr(owner, method_name, None)
    if method is None:
        return "unknown"
    try:
        return str(method())
    except Exception as exc:
        return f"error:{type(exc).__name__}:{exc}"


def poll_controller_events(
    pygame_mod: Any,
    joystick: Any,
    exit_button_index: int | None = None,
) -> tuple[bool, bool]:
    """Return controller-disconnected and exit-requested states from one pygame event drain."""
    try:
        pygame_mod.event.pump()
        instance_id = joystick.get_instance_id() if hasattr(joystick, "get_instance_id") else None
        disconnected = False
        exit_requested = False
        for event in pygame_mod.event.get():
            event_type = getattr(event, "type", None)
            if event_type == getattr(pygame_mod, "JOYDEVICEREMOVED", object()):
                if instance_id is None or getattr(event, "instance_id", None) == instance_id:
                    disconnected = True
            elif event_type == getattr(pygame_mod, "CONTROLLERDEVICEREMOVED", object()):
                if instance_id is None or getattr(event, "instance_id", None) == instance_id:
                    disconnected = True
            elif event_type == getattr(pygame_mod, "JOYBUTTONDOWN", object()):
                if exit_button_index is not None and getattr(event, "button", None) == exit_button_index:
                    if instance_id is None or getattr(event, "instance_id", None) in {None, instance_id}:
                        exit_requested = True
            elif event_type == getattr(pygame_mod, "CONTROLLERBUTTONDOWN", object()):
                if exit_button_index is not None and getattr(event, "button", None) == exit_button_index:
                    if instance_id is None or getattr(event, "instance_id", None) in {None, instance_id}:
                        exit_requested = True
            elif event_type == getattr(pygame_mod, "KEYDOWN", object()):
                if getattr(event, "key", None) == getattr(pygame_mod, "K_ESCAPE", object()):
                    exit_requested = True
        joystick_count_empty = pygame_mod.joystick.get_count() == 0
        if isinstance(joystick, SdlGameControllerJoystick):
            joystick_count_empty = False
        disconnected = disconnected or not joystick.get_init() or joystick_count_empty
        return disconnected, exit_requested
    except Exception:
        return True, False


def gamepad_was_disconnected(pygame_mod: Any, joystick: Any) -> bool:
    """Detect a controller removal event before reading axes/buttons."""
    disconnected, _exit_requested = poll_controller_events(pygame_mod, joystick)
    return disconnected


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
