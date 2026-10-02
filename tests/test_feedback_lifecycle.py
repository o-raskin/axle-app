"""Optional controller LEDs and haptics handle failures without poisoning later feedback."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from bridge import feedback


def test_led_failed_write_is_retried_and_close_releases_the_handle_once() -> None:
    writes = []
    closed = []

    def write(handle: int, red: int, green: int, blue: int) -> int:
        writes.append((handle, red, green, blue))
        return -1 if len(writes) == 1 else 0

    sdl = SimpleNamespace(SDL_GameControllerSetLED=write, SDL_GameControllerClose=closed.append)
    led = feedback.ControllerLed(sdl, 7)
    assert not led.set_color((50, 100, 150))
    assert led.set_color((50, 100, 150))
    assert led.set_color((50, 100, 150))
    led.close()
    led.close()
    assert writes == [(7, 50, 100, 150), (7, 50, 100, 150), (7, 0, 0, 0)]
    assert closed == [7]
    assert not led.set_color((50, 100, 150))


def test_led_close_failure_still_invalidates_the_closed_controller_handle() -> None:
    closes = []

    def close(handle: int) -> None:
        closes.append(handle)
        raise OSError("Device disappeared")

    led = feedback.ControllerLed(
        SimpleNamespace(SDL_GameControllerSetLED=lambda *_: -1, SDL_GameControllerClose=close), 7
    )
    led.close()
    led.close()
    assert closes == [7]
    assert not led.set_color((0, 255, 0))


def test_unavailable_sdl_led_backend_remains_a_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(feedback, "load_sdl", lambda _pygame: None)
    led = feedback.ControllerLed.open(SimpleNamespace())
    assert not led.set_color((255, 0, 0))
    led.close()


def test_haptic_backend_errors_do_not_prevent_future_feedback() -> None:
    calls = []

    def rumble(*values: object) -> bool:
        calls.append(values)
        if len(calls) == 1:
            raise RuntimeError("Temporary controller failure")
        return True

    joystick = SimpleNamespace(rumble=rumble)
    assert not feedback.rumble_once(joystick, 0.2, 0.5, 100)
    assert feedback.rumble_once(joystick, 0.2, 0.5, 100)
    assert len(calls) == 2


def test_speed_limits_do_not_fire_redundant_haptics() -> None:
    calls = []
    joystick = SimpleNamespace(rumble=lambda *values: calls.append(values))
    assert asyncio.run(feedback.change_speed_mode_with_feedback(joystick, 3, 1)) == 3
    assert asyncio.run(feedback.change_speed_mode_with_feedback(joystick, 1, -1)) == 1
    assert asyncio.run(feedback.change_speed_mode_with_feedback(joystick, 2, 0)) == 2
    assert calls == []
