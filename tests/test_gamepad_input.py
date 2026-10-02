"""Controller normalization and discovery remain safe without real hardware."""

from __future__ import annotations

import math
import sys
from types import SimpleNamespace

import pytest

from bridge.gamepads import input as gamepad
from bridge.gamepads.profile_loader import GamepadProfile


class Joystick:
    def __init__(self, axes: dict[int, float] | None = None, buttons: set[int] | None = None) -> None:
        self.axes = axes or {}
        self.buttons = buttons or set()
        self.axis_reads: list[int] = []

    def get_axis(self, index: int) -> float:
        self.axis_reads.append(index)
        return self.axes.get(index, -1.0)

    def get_numbuttons(self) -> int:
        return 16

    def get_button(self, index: int) -> bool:
        assert 0 <= index < self.get_numbuttons(), "Do not query invalid hardware button indices"
        return index in self.buttons


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_invalid_axes_are_neutral_in_the_actual_drive_pipeline(value: float) -> None:
    pad = GamepadProfile.load("dualsense")
    joystick = Joystick({pad.axis("throttle_forward"): value, pad.axis("throttle_reverse"): -1.0})
    assert gamepad.read_drive_state(joystick, pad, 100, 3) == (0, 0.0, 0.0, 0.0)
    assert gamepad.axis_to_percent(value, 100, pad.deadzone) == 0
    assert gamepad.trigger_amount(value, False, pad.trigger_deadzone) == 0.0


@pytest.mark.parametrize("value, expected", [(-2.0, -100), (-0.14, 0), (0.0, 0), (0.15, 15), (2.0, 100)])
def test_steering_deadzone_and_finite_bounds(value: float, expected: int) -> None:
    assert gamepad.axis_to_percent(value, 100, 0.15) == expected


@pytest.mark.parametrize("rest_negative", [True, False])
def test_trigger_pressures_remain_independent_and_cancel_without_double_sampling(rest_negative: bool) -> None:
    pad = GamepadProfile.load("dualsense")
    pad.triggers_rest_negative = rest_negative
    forward, reverse = pad.axis("throttle_forward"), pad.axis("throttle_reverse")
    axis_value = 0.5 if rest_negative else 0.75
    joystick = Joystick({forward: axis_value, reverse: axis_value})
    assert gamepad.read_drive_state(joystick, pad, 100, 3) == (0, 0.0, 0.75, 0.75)
    assert joystick.axis_reads == [forward, reverse]
    joystick.axes[reverse] = -1.0 if rest_negative else 0.0
    assert gamepad.read_drive_input(joystick, pad, 100, 2) == (37, 0.75)


@pytest.mark.parametrize("index", [-1, 16, 99])
def test_nonexistent_buttons_are_not_read(index: int) -> None:
    assert not gamepad.button_held(Joystick(buttons={1}), index)


@pytest.mark.parametrize("index", [0, 4, 5])
@pytest.mark.parametrize("raw", [math.nan, math.inf, -math.inf])
def test_sdl_wrapper_neutralizes_invalid_axes_before_profile_normalization(index: int, raw: float) -> None:
    controller = SimpleNamespace(as_joystick=lambda: None, get_axis=lambda _index: raw)
    joystick = gamepad.SdlGameControllerJoystick(controller, "Fixture", 0)
    expected = -1.0 if index in {4, 5} else 0.0
    assert joystick.get_axis(index) == expected


@pytest.mark.parametrize("index, raw, expected", [(0, -32768, -1.0), (0, 32767, 1.0), (4, 0, -1.0), (5, 32767, 1.0)])
def test_sdl_wrapper_preserves_signed_sticks_and_resting_triggers(index: int, raw: int, expected: float) -> None:
    controller = SimpleNamespace(as_joystick=lambda: None, get_axis=lambda _index: raw)
    joystick = gamepad.SdlGameControllerJoystick(controller, "Fixture", 0)
    assert joystick.get_axis(index) == expected


def test_sdl_discovery_recovers_when_first_matching_device_disappears(monkeypatch: pytest.MonkeyPatch) -> None:
    opened = []
    handle = SimpleNamespace(as_joystick=lambda: None)

    def open_controller(index: int) -> SimpleNamespace:
        opened.append(index)
        if index == 0:
            raise RuntimeError("Controller disconnected")
        return handle

    controllers = SimpleNamespace(
        get_count=lambda: 2,
        name_forindex=lambda index: f"DualSense {index}",
        is_controller=lambda _index: True,
        Controller=open_controller,
    )
    monkeypatch.setattr(gamepad, "sdl2_controller_module", lambda _pygame: controllers)
    joystick, names = gamepad.init_sdl_game_controller(GamepadProfile.load("dualsense"), SimpleNamespace())
    assert joystick.get_name() == "DualSense 1"
    assert names == ["DualSense 0", "DualSense 1"]
    assert opened == [0, 1]


def test_generic_profile_exclusions_apply_to_sdl_and_joystick_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    pad = GamepadProfile.load("generic_sdl")
    pad.exclude_name_hints = ("flight stick",)
    controllers = SimpleNamespace(
        get_count=lambda: 1,
        name_forindex=lambda _index: "Flight Stick",
        is_controller=lambda _index: True,
        Controller=lambda _index: pytest.fail("An excluded controller must never be opened"),
    )
    monkeypatch.setattr(gamepad, "sdl2_controller_module", lambda _pygame: controllers)
    assert gamepad.init_sdl_game_controller(pad, SimpleNamespace()) == (None, ["Flight Stick"])

    closed = []
    device = SimpleNamespace(init=lambda: None, get_name=lambda: "Flight Stick", quit=lambda: closed.append(True))
    pygame = SimpleNamespace(
        joystick=SimpleNamespace(get_count=lambda: 1, Joystick=lambda _index: device),
        quit=lambda: closed.append("pygame"),
    )
    monkeypatch.setitem(sys.modules, "pygame", pygame)
    monkeypatch.setattr(gamepad, "configure_process_for_platform", lambda: None)
    monkeypatch.setattr(gamepad, "refresh_joystick_subsystem", lambda _pygame: None)
    with pytest.raises(RuntimeError, match="controller not found"):
        gamepad.init_gamepad(pad)
    assert closed == [True, "pygame"]


def test_failed_gamepad_initialization_unwinds_pygame(monkeypatch: pytest.MonkeyPatch) -> None:
    closed = []
    pygame = SimpleNamespace(quit=lambda: closed.append(True))
    monkeypatch.setitem(sys.modules, "pygame", pygame)
    monkeypatch.setattr(gamepad, "configure_process_for_platform", lambda: None)

    def fail(_pygame: SimpleNamespace) -> None:
        raise RuntimeError("SDL initialization failed")

    monkeypatch.setattr(gamepad, "refresh_joystick_subsystem", fail)
    assert gamepad.try_init_gamepad() == (None, None, "SDL initialization failed")
    assert closed == [True]


def test_joystick_discovery_continues_and_closes_a_device_that_disappears_during_init(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    closed = []

    def disconnected() -> None:
        raise RuntimeError("Device disconnected during initialization")

    vanished = SimpleNamespace(init=disconnected, quit=lambda: closed.append(0))
    available = SimpleNamespace(init=lambda: None, get_name=lambda: "DualSense", quit=lambda: closed.append(1))
    devices = [vanished, available]
    pygame = SimpleNamespace(
        joystick=SimpleNamespace(get_count=lambda: 2, Joystick=lambda index: devices[index]),
        quit=lambda: closed.append("pygame"),
    )
    monkeypatch.setitem(sys.modules, "pygame", pygame)
    monkeypatch.setattr(gamepad, "configure_process_for_platform", lambda: None)
    monkeypatch.setattr(gamepad, "refresh_joystick_subsystem", lambda _pygame: None)
    monkeypatch.setattr(gamepad, "sdl2_controller_module", lambda _pygame: None)
    assert gamepad.init_gamepad(GamepadProfile.load("dualsense")) == (pygame, available)
    assert closed == [0]
