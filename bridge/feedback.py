"""Controller LED and rumble feedback."""

from __future__ import annotations

import ctypes
import ctypes.util
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .settings import (
    BOOST_FEEDBACK_DELAY_S,
    BOOST_LED_COLOR,
    BOOST_LED_DIM_COLOR,
    BOOST_LED_TAIL_S,
    BOOST_RUMBLE_FEEDBACK_DELAY_S,
    BOOST_RUMBLE_REFRESH_MS,
    BOOST_RUMBLE_STRENGTH,
    BOOST_UNAVAILABLE_LED_COLOR,
    BOOST_UNAVAILABLE_LED_FLASH_INTERVAL_S,
    BOOST_UNAVAILABLE_LED_FLASH_S,
    BOOST_UNAVAILABLE_RUMBLE_MS,
    CRASH_LED_COLOR,
    CRASH_LOCKOUT_S,
    CRASH_SPEED_THRESHOLD_RATIO,
    DEFAULT_SPEED_MODE,
    DRIVE_RUMBLE_MAX_STRENGTH,
    DRIVE_RUMBLE_PRESSURE_EXPONENT,
    LED_OFF_COLOR,
    REVERSE_LED_PHASE_S,
    RGB,
    SDL_INIT_GAMECONTROLLER,
    SPEED_MODE_LED_COLORS,
    SPEED_MODE_RATIOS,
    SPEED_MODE_SEQUENCE,
    SPEED_RUMBLE_DURATION_MS,
    SPEED_RUMBLE_STRENGTH,
)


class ControllerLed:
    """Optional SDL game-controller LED support."""

    def __init__(self, sdl: Any | None = None, controller: Any | None = None) -> None:
        """Keep the SDL controller handle and cache the current color."""
        self._sdl = sdl
        self._controller = controller
        self._color: RGB | None = None

    @classmethod
    def open(cls, pygame_mod: Any, controller_index: int = 0) -> "ControllerLed":
        """Open one SDL controller for LED writes, returning a no-op wrapper if unavailable."""
        try:
            sdl = load_sdl(pygame_mod)
            if sdl is None:
                return cls()
            configure_sdl_controller_led(sdl)
            if sdl.SDL_InitSubSystem(SDL_INIT_GAMECONTROLLER) != 0:
                return cls()
            if not sdl.SDL_IsGameController(controller_index):
                return cls()
            controller = sdl.SDL_GameControllerOpen(controller_index)
            if not controller:
                return cls()
            return cls(sdl, controller)
        except Exception:
            return cls()

    def set_color(self, color: RGB) -> bool:
        """Set the gamepad LED color if supported."""
        if self._sdl is None or self._controller is None:
            return False
        if color == self._color:
            return True
        try:
            red, green, blue = color
            if self._sdl.SDL_GameControllerSetLED(self._controller, red, green, blue) != 0:
                return False
        except Exception:
            return False
        self._color = color
        return True

    def close(self) -> None:
        """Turn the LED off and close the SDL controller handle."""
        if self._sdl is None or self._controller is None:
            return
        try:
            self.set_color(LED_OFF_COLOR)
            self._sdl.SDL_GameControllerClose(self._controller)
        except Exception:
            pass
        finally:
            self._controller = None


@dataclass
class BoostRumble:
    """Keep the gamepad rumbling while boost feedback is active."""

    active: bool = False

    def update(self, joystick: Any, strength: float) -> None:
        """Refresh boost rumble at the requested strength, stopping at zero."""
        strength = max(0.0, min(BOOST_RUMBLE_STRENGTH, strength))
        if strength > 0:
            rumble_once(joystick, strength, strength, BOOST_RUMBLE_REFRESH_MS)
            self.active = True
        elif self.active:
            stop_rumble(joystick)
            self.active = False

    def stop(self, joystick: Any) -> None:
        """Stop boost rumble if it was active."""
        if self.active:
            stop_rumble(joystick)
            self.active = False


@dataclass
class BoostUnavailableFeedback:
    """Short warning feedback for a boost press during cooldown or braking."""

    started_at: float | None = None

    def trigger(self, joystick: Any, now: float) -> None:
        """Start red LED flicker and fire one short strong rumble."""
        self.started_at = now
        rumble_once(joystick, BOOST_RUMBLE_STRENGTH, BOOST_RUMBLE_STRENGTH, BOOST_UNAVAILABLE_RUMBLE_MS)

    def color_override(self, now: float) -> RGB | None:
        """Return a temporary red/off flicker color, or no override after it expires."""
        if self.started_at is None:
            return None
        elapsed = now - self.started_at
        if elapsed >= BOOST_UNAVAILABLE_LED_FLASH_S:
            self.started_at = None
            return None
        phase = int(elapsed // BOOST_UNAVAILABLE_LED_FLASH_INTERVAL_S)
        return BOOST_UNAVAILABLE_LED_COLOR if phase % 2 == 0 else LED_OFF_COLOR


@dataclass
class CrashLockout:
    """Hold a temporary control lockout for hub-reported impacts."""

    previous_throttle: int = 0
    active_until: float = 0.0
    impact_reported: bool = False

    def active(self, now: float) -> bool:
        """Return whether controls should remain blocked."""
        return now < self.active_until

    def remaining(self, now: float) -> float:
        """Return lockout time left in seconds."""
        return max(0.0, self.active_until - now)

    def update(
        self,
        throttle: int,
        max_drive: int,
        now: float,
        *,
        impact: bool | None = None,
        enabled: bool = True,
    ) -> bool:
        """Start a lockout for a new impact while current or recent power is >=30%."""
        new_impact = False
        if impact is not None:
            new_impact = impact and not self.impact_reported
            self.impact_reported = impact

        if self.active(now):
            return False
        threshold = max(0.0, max_drive * CRASH_SPEED_THRESHOLD_RATIO)
        fast_enough = abs(throttle) >= threshold or abs(self.previous_throttle) >= threshold
        crashed = enabled and threshold > 0 and new_impact and fast_enough
        self.previous_throttle = throttle
        if crashed:
            self.active_until = now + CRASH_LOCKOUT_S
            self.previous_throttle = 0
            return True
        return False


def sdl_library_candidates(pygame_mod: Any) -> list[str]:
    """Return plausible SDL2 shared library names for the current platform."""
    pygame_file = getattr(pygame_mod, "__file__", None)
    base = Path(pygame_file).resolve().parent if pygame_file else None
    candidates: list[str | None] = []

    if base is not None and sys.platform == "darwin":
        candidates.extend(
            [
                str(base / ".dylibs" / "libSDL2-2.0.0.dylib"),
                str(base / "libSDL2-2.0.0.dylib"),
            ]
        )
    elif base is not None and sys.platform == "win32":
        candidates.extend(
            [
                str(base / "SDL2.dll"),
                str(base / "libSDL2-2.0-0.dll"),
            ]
        )
    elif base is not None:
        candidates.extend(
            [
                str(base / "libSDL2-2.0.so.0"),
                str(base / "libSDL2.so"),
            ]
        )

    candidates.extend(
        [
            ctypes.util.find_library("SDL2"),
            ctypes.util.find_library("SDL2-2.0"),
            ctypes.util.find_library("SDL2.dll"),
        ]
    )
    return [candidate for candidate in candidates if candidate]


def load_sdl(pygame_mod: Any) -> Any | None:
    """Load the SDL2 library used for game-controller LED writes."""
    for candidate in sdl_library_candidates(pygame_mod):
        try:
            return ctypes.CDLL(str(candidate))
        except OSError:
            continue
    return None


def configure_sdl_controller_led(sdl: Any) -> None:
    """Configure ctypes signatures for the small SDL game-controller API subset."""
    sdl.SDL_InitSubSystem.argtypes = [ctypes.c_uint32]
    sdl.SDL_InitSubSystem.restype = ctypes.c_int
    sdl.SDL_IsGameController.argtypes = [ctypes.c_int]
    sdl.SDL_IsGameController.restype = ctypes.c_int
    sdl.SDL_GameControllerOpen.argtypes = [ctypes.c_int]
    sdl.SDL_GameControllerOpen.restype = ctypes.c_void_p
    sdl.SDL_GameControllerSetLED.argtypes = [ctypes.c_void_p, ctypes.c_uint8, ctypes.c_uint8, ctypes.c_uint8]
    sdl.SDL_GameControllerSetLED.restype = ctypes.c_int
    sdl.SDL_GameControllerClose.argtypes = [ctypes.c_void_p]
    sdl.SDL_GameControllerClose.restype = None


def increase_speed_mode(speed_mode: int) -> int:
    """Return the next speed mode, clamped at the highest configured mode."""
    index = SPEED_MODE_SEQUENCE.index(speed_mode)
    return SPEED_MODE_SEQUENCE[min(index + 1, len(SPEED_MODE_SEQUENCE) - 1)]


def decrease_speed_mode(speed_mode: int) -> int:
    """Return the previous speed mode, clamped at the lowest configured mode."""
    index = SPEED_MODE_SEQUENCE.index(speed_mode)
    return SPEED_MODE_SEQUENCE[max(index - 1, 0)]


def drive_power_for_trigger(trigger_balance: float, max_drive: int, speed_mode: int) -> int:
    """Scale a -1..1 trigger balance by model drive limit and selected speed mode."""
    return int(trigger_balance * max_drive * SPEED_MODE_RATIOS[speed_mode])


def drive_rumble_strength(trigger_pressure: float, speed_mode: int) -> float:
    """Return proportional drive rumble for the current trigger pressure and speed mode."""
    pressure = max(0.0, min(1.0, trigger_pressure))
    strength = DRIVE_RUMBLE_MAX_STRENGTH * SPEED_MODE_RATIOS[speed_mode] * (pressure**DRIVE_RUMBLE_PRESSURE_EXPONENT)
    return float(strength)


def boost_feedback_active(boost: bool, boost_feedback_at: float, now: float) -> bool:
    """Return whether delayed boost feedback should be visible/audible now."""
    return boost and now >= boost_feedback_at


def boost_led_feedback_active(boost_feedback_at: float, boost_until: float, now: float) -> bool:
    """Return whether boost LED feedback is in its active or tail phase."""
    return boost_feedback_at > 0.0 and boost_feedback_at <= now < boost_until + BOOST_LED_TAIL_S


def boost_rumble_feedback_at(boost_feedback_at: float) -> float:
    """Return the delayed rumble start time associated with boost LED feedback."""
    if boost_feedback_at <= 0.0:
        return 0.0
    return boost_feedback_at + max(0.0, BOOST_RUMBLE_FEEDBACK_DELAY_S - BOOST_FEEDBACK_DELAY_S)


def boost_rumble_strength(boost_feedback_at: float, boost_until: float, now: float) -> float:
    """Return strong boost rumble while active and fade it through the tail."""
    rumble_at = boost_rumble_feedback_at(boost_feedback_at)
    if rumble_at <= 0.0 or rumble_at >= boost_until or now < rumble_at or now >= boost_until + BOOST_LED_TAIL_S:
        return 0.0
    if now < boost_until:
        return BOOST_RUMBLE_STRENGTH
    tail_progress = (now - boost_until) / BOOST_LED_TAIL_S
    return BOOST_RUMBLE_STRENGTH * max(0.0, 1.0 - tail_progress)


def boost_led_color(boost_feedback_at: float, boost_until: float, now: float) -> RGB:
    """Return the orange boost LED ramp and fade color for a timestamp."""
    if boost_until <= boost_feedback_at:
        return BOOST_LED_COLOR
    if now >= boost_until:
        tail_progress = max(0.0, min(1.0, (now - boost_until) / BOOST_LED_TAIL_S))
        return scale_rgb(BOOST_LED_COLOR, 1.0 - tail_progress)
    ramp_duration = min(BOOST_FEEDBACK_DELAY_S, boost_until - boost_feedback_at)
    if now >= boost_feedback_at + ramp_duration:
        return BOOST_LED_COLOR
    progress = (now - boost_feedback_at) / ramp_duration
    progress = max(0.0, min(1.0, progress))
    return interpolate_rgb(BOOST_LED_DIM_COLOR, BOOST_LED_COLOR, progress)


def scale_rgb(color: RGB, factor: float) -> RGB:
    """Scale an RGB tuple by a brightness factor."""
    red, green, blue = color
    return int(red * factor), int(green * factor), int(blue * factor)


def interpolate_rgb(start: RGB, end: RGB, progress: float) -> RGB:
    """Linearly interpolate between two RGB tuples."""
    start_red, start_green, start_blue = start
    end_red, end_green, end_blue = end
    return (
        int(start_red + ((end_red - start_red) * progress)),
        int(start_green + ((end_green - start_green) * progress)),
        int(start_blue + ((end_blue - start_blue) * progress)),
    )


def reverse_led_color(speed_mode: int, reverse_started_at: float | None, now: float) -> RGB | None:
    """Return the reverse white/green blink color, or no override when not reversing."""
    if reverse_started_at is None:
        return None
    elapsed = max(0.0, now - reverse_started_at)
    phase = int(elapsed // REVERSE_LED_PHASE_S)
    if phase % 2 == 0:
        return SPEED_MODE_LED_COLORS[speed_mode]
    brightness = SPEED_MODE_LED_COLORS[speed_mode][1]
    return 0, brightness, 0


def gamepad_led_color(
    speed_mode: int,
    boost_feedback: bool,
    *,
    boost_color: RGB = BOOST_LED_COLOR,
    boost_unavailable_feedback: BoostUnavailableFeedback | None = None,
    crash_feedback: bool = False,
    reverse_started_at: float | None = None,
    now: float = 0.0,
) -> RGB:
    """Resolve the visible controller LED color from all active feedback sources."""
    override = None if boost_unavailable_feedback is None else boost_unavailable_feedback.color_override(now)
    reverse_color = reverse_led_color(speed_mode, reverse_started_at, now)
    if crash_feedback:
        color = CRASH_LED_COLOR
    elif override is not None:
        color = override
    elif boost_feedback:
        color = boost_color
    else:
        color = reverse_color or SPEED_MODE_LED_COLORS[speed_mode]
    return color


def update_gamepad_led(
    gamepad_led: Any,
    speed_mode: int,
    boost_feedback: bool,
    *,
    boost_color: RGB = BOOST_LED_COLOR,
    boost_unavailable_feedback: BoostUnavailableFeedback | None = None,
    crash_feedback: bool = False,
    reverse_started_at: float | None = None,
    now: float = 0.0,
) -> RGB:
    """Write the resolved controller LED color and return it."""
    color = gamepad_led_color(
        speed_mode,
        boost_feedback,
        boost_color=boost_color,
        boost_unavailable_feedback=boost_unavailable_feedback,
        crash_feedback=crash_feedback,
        reverse_started_at=reverse_started_at,
        now=now,
    )
    gamepad_led.set_color(color)
    return color


def rumble_once(joystick: Any, low_frequency: float, high_frequency: float, duration_ms: int) -> bool:
    """Run one pygame rumble command if the controller supports it."""
    rumble = getattr(joystick, "rumble", None)
    if rumble is None:
        return False
    try:
        return bool(rumble(low_frequency, high_frequency, duration_ms))
    except Exception:
        return False


def stop_rumble(joystick: Any) -> bool:
    """Stop pygame rumble if the controller supports it."""
    stop = getattr(joystick, "stop_rumble", None)
    if stop is None:
        return False
    try:
        stop()
    except Exception:
        return False
    return True


async def rumble_speed_change(joystick: Any, direction: int) -> None:
    """Send directional haptic feedback for speed mode changes."""
    if direction > 0:
        rumble_once(joystick, 0.0, SPEED_RUMBLE_STRENGTH, SPEED_RUMBLE_DURATION_MS)
    elif direction < 0:
        rumble_once(joystick, SPEED_RUMBLE_STRENGTH, 0.0, SPEED_RUMBLE_DURATION_MS)


async def change_speed_mode_with_feedback(joystick: Any, speed_mode: int, direction: int) -> int:
    """Change speed mode and rumble only when the mode actually changed."""
    if direction > 0:
        next_speed_mode = increase_speed_mode(speed_mode)
    elif direction < 0:
        next_speed_mode = decrease_speed_mode(speed_mode)
    else:
        next_speed_mode = speed_mode

    if next_speed_mode != speed_mode:
        await rumble_speed_change(joystick, direction)
    return next_speed_mode


def led_color_label(color: RGB) -> str:
    """Return a compact human-readable LED color label."""
    red, green, blue = color
    if color == LED_OFF_COLOR:
        return "off"
    if red == green == blue:
        return f"white {round((red / 255) * 100):d}%"
    if red > 0 and green == 0 and blue == 0:
        return "red"
    if red == 0 and green > 0 and blue == 0:
        return f"green {round((green / 255) * 100):d}%"
    if red > 0 and green > 0 and blue == 0:
        return "orange"
    return f"rgb({red},{green},{blue})"


def default_led_color() -> RGB:
    """Return the LED color for the default speed mode."""
    return SPEED_MODE_LED_COLORS[DEFAULT_SPEED_MODE]
