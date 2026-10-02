"""Verify haptic priority across the actual session, runtime, and BLE command stack."""

from __future__ import annotations

import asyncio
from io import StringIO
from types import SimpleNamespace
from typing import Any

import pytest

from bridge import session
from bridge.cars.model_profiles import ModelProfile
from bridge.gamepads.profile_loader import GamepadProfile
from bridge.keyboard import TerminalExitPoller
from bridge.settings import (
    BOOST_RUMBLE_REFRESH_MS,
    BOOST_UNAVAILABLE_RUMBLE_MS,
    SESSION_EXIT,
    SPEED_RUMBLE_DURATION_MS,
    SPEED_RUMBLE_STRENGTH,
)
from bridge.transport import CHAR_UUID, TechnicMoveHub
from tests.fake_hub import FakeHub

PORT_MAP = {"roles": {"play_vm": "0x36", "drive_left": "0x32", "drive_right": "0x33"}}


class SessionClock:
    """Replace only the session's pacing clock; keep asyncio's scheduler real."""

    def __init__(self) -> None:
        self.now = 10.0

    def time(self) -> float:
        return self.now

    def get_running_loop(self) -> "SessionClock":
        return self

    async def sleep(self, _delay: float) -> None:
        pass

    def __getattr__(self, name: str) -> Any:
        return getattr(asyncio, name)


class FeedbackController:
    def __init__(self, pad: GamepadProfile, clock: SessionClock) -> None:
        self.pad = pad
        self.clock = clock
        self.buttons: set[str] = set()
        self.rumbles: list[tuple[float, float, float, int]] = []
        self.stops: list[float] = []

    def get_name(self) -> str:
        return "Feedback fixture"

    def get_numaxes(self) -> int:
        return 6

    def get_numbuttons(self) -> int:
        return 16

    def get_button(self, index: int) -> bool:
        return any(self.pad.button(action) == index for action in self.buttons)

    def get_axis(self, index: int) -> float:
        if index == self.pad.axis("throttle_forward"):
            return 1.0
        return -1.0 if index == self.pad.axis("throttle_reverse") else 0.0

    def rumble(self, low: float, high: float, duration_ms: int) -> bool:
        self.rumbles.append((self.clock.now, low, high, duration_ms))
        return True

    def stop_rumble(self) -> None:
        self.stops.append(self.clock.now)


class SimulatedBleClient:
    def __init__(self, hub: TechnicMoveHub) -> None:
        self.hub = hub
        self.program = FakeHub()
        self.is_connected = True
        self.disconnects = 0

    async def write_gatt_char(self, uuid: str, data: bytes | bytearray, response: bool) -> None:
        assert uuid == CHAR_UUID and not response
        await self.program.send(data)
        for reply in self.program.drain_notifications():
            self.hub._handle_notification(SimpleNamespace(uuid=uuid), bytearray(reply))

    async def disconnect(self) -> None:
        self.disconnects += 1
        self.is_connected = False


@pytest.mark.parametrize("warning", ["unavailable-boost", "speed-change"])
def test_live_session_preserves_short_warning_over_boost_tail_and_then_resumes_drive_feedback(
    monkeypatch: pytest.MonkeyPatch, warning: str
) -> None:
    model = ModelProfile.load("tumbler")
    # Exercise real PLAYVM calibration synchronously; the hardware simulator
    # does not need its capture's pacing or the optional viewer encoders.
    model._pace = dict.fromkeys(model._pace, 0.0)
    model.name = "Feedback fixture"
    pad = GamepadProfile.load("generic_sdl")
    clock = SessionClock()
    joystick = FeedbackController(pad, clock)
    hub = TechnicMoveHub()
    client = SimulatedBleClient(hub)
    hub.client = client
    quit_calls = []
    pygame = SimpleNamespace(quit=lambda: quit_calls.append(True))
    warning_ms = BOOST_UNAVAILABLE_RUMBLE_MS if warning == "unavailable-boost" else SPEED_RUMBLE_DURATION_MS
    warning_at = 12.1
    resumes_at = warning_at + warning_ms / 1000
    timeline = iter(
        [
            (10.0, {"boost"}),
            (10.7, set()),
            (12.0, set()),
            (warning_at, {"boost"} if warning == "unavailable-boost" else {"speed_up"}),
            (warning_at + 0.01, {"boost"} if warning == "unavailable-boost" else {"speed_up"}),
            (resumes_at - 0.001, set()),
            (resumes_at + 0.001, set()),
            (12.6, set()),
        ]
    )

    def poll(*_args: Any) -> tuple[bool, bool]:
        try:
            clock.now, joystick.buttons = next(timeline)
        except StopIteration:
            return False, True
        return False, False

    logs = []
    telemetry = []
    console = SimpleNamespace(log=logs.append, start=telemetry.append, update=telemetry.append, stop=lambda: None)
    monkeypatch.setattr(session, "asyncio", clock)
    monkeypatch.setattr(session, "poll_controller_events", poll)
    monkeypatch.setattr(session, "TerminalExitPoller", lambda: TerminalExitPoller(StringIO()))
    monkeypatch.setattr(session, "release_winrt_sta_for_pygame", lambda: None)
    monkeypatch.setenv("REVERSE_BEEP_OUTPUT", "off")
    result = asyncio.run(
        session.run_live_session(model, pad, PORT_MAP, session.ConnectedHardware(hub, pygame, joystick), console)
    )

    assert result == SESSION_EXIT
    assert "Ready." in logs
    expected_pulse = (
        (warning_at, 1.0, 1.0, BOOST_UNAVAILABLE_RUMBLE_MS)
        if warning == "unavailable-boost"
        else (warning_at, 0.0, SPEED_RUMBLE_STRENGTH, SPEED_RUMBLE_DURATION_MS)
    )
    assert [pulse for pulse in joystick.rumbles if warning_at <= pulse[0] < resumes_at] == [expected_pulse]
    assert (10.7, 1.0, 1.0, BOOST_RUMBLE_REFRESH_MS) in joystick.rumbles
    resumed = [pulse for pulse in joystick.rumbles if pulse[0] == resumes_at + 0.001]
    assert len(resumed) == 1 and 0 < resumed[0][1] < 1.0
    assert resumed[0][3] == BOOST_RUMBLE_REFRESH_MS
    normal_drive = [pulse for pulse in joystick.rumbles if pulse[0] == 12.6]
    assert len(normal_drive) == 1 and 0 < normal_drive[0][1] < 1.0
    assert len(telemetry) == 9
    expected_strength = 1.0 if warning == "unavailable-boost" else SPEED_RUMBLE_STRENGTH
    assert all(frame.rumble_strength == expected_strength for frame in telemetry[4:7])
    assert telemetry[-1].speed_mode == (1 if warning == "unavailable-boost" else 2)
    frames = [frame for frame in client.program.play_vm_frames() if frame[7] == 3]
    assert any(frame[9] == 25 and frame[11] == 4 for frame in frames), "Send a real boost command through fake BLE"
    assert frames[-1][9:] == bytes([0, 0, 0, 1]), "Session exit must still send neutral output"
    assert client.disconnects == 1 and quit_calls == [True]
    assert joystick.stops == [12.6]
