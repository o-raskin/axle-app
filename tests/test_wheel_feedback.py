from __future__ import annotations

import asyncio
import json
import math
import struct
from io import StringIO
from types import SimpleNamespace

import pytest

from bridge import session
from bridge.cars.model_profiles import ModelProfile
from bridge.cars.tumbler.low_level_control import LowLevelControl
from bridge.cars.tumbler.wheel_feedback import WheelFeedback
from bridge.dashboard import CarTelemetry
from bridge.gamepads.profile_loader import GamepadProfile
from bridge.protocol import JsonLineEmitter, ProtocolLiveConsole
from bridge.transport import CHAR_UUID, TechnicMoveHub


def pair(hub: TechnicMoveHub, at: float, left: int, right: int) -> None:
    hub.port_values = {
        port: (2, value.to_bytes(4, "little", signed=True), at) for port, value in zip((50, 51), (left, right))
    }


def feedback() -> tuple[TechnicMoveHub, WheelFeedback]:
    hub = TechnicMoveHub()
    wheels = WheelFeedback(hub, (50, 51))
    wheels.modes = {50: 2, 51: 2}
    wheels.scales = {50: 1, 51: 1}
    return hub, wheels


@pytest.mark.parametrize("direction", [1, -1])
def test_forward_reverse_boost_and_stall_emit_measured_positions(direction: int) -> None:
    hub, wheels = feedback()
    for at in (1.0, 1.1, 1.2):
        pair(hub, at, 0, 0)
        assert wheels.sample(0, False, at) is None
    for index in range(1, 9):
        at = 1.2 + index * 0.1
        pair(hub, at, direction * index * 20, -direction * index * 20)
        result = wheels.sample(direction * 30, False, at)
    assert result is not None
    first = result["position_radians"]
    pair(hub, 2.1, direction * 200, -direction * 200)
    boosted = wheels.sample(direction * 30, True, 2.1)
    assert boosted is not None
    assert boosted["position_radians"] - first == pytest.approx(direction * 40 * math.pi / 180 * 7 / 11)
    pair(hub, 2.2, direction * 200, -direction * 200)
    stalled = wheels.sample(direction * 100, True, 2.2)
    assert stalled["position_radians"] == boosted["position_radians"]
    # Brake/coasting must retain measured travel rather than forcing zero speed.
    pair(hub, 2.3, direction * 210, -direction * 210)
    coasting = wheels.sample(0, False, 2.3)
    assert coasting["position_radians"] != stalled["position_radians"]
    stream = StringIO()
    console = ProtocolLiveConsole(JsonLineEmitter(stream), min_telemetry_interval_s=0)
    console.update(CarTelemetry("42239 Batmobile Tumbler", "Technic Move", 100, 100, wheel_motion=coasting))
    assert json.loads(stream.getvalue())["telemetry"]["wheel_motion"] == coasting
    assert wheels.sample(100, True, 3.0) is None


def test_encoder_cache_survives_playvm_notification_drain(monkeypatch: pytest.MonkeyPatch) -> None:
    hub = TechnicMoveHub()
    sender = SimpleNamespace(uuid=CHAR_UUID)
    monkeypatch.setattr("bridge.transport.time.monotonic", lambda: 12.0)
    hub._handle_notification(sender, bytearray([10, 0, 0x47, 50, 2, 10, 0, 0, 0, 1]))
    hub._handle_notification(sender, bytearray([8, 0, 0x45, 50, *(-360).to_bytes(4, "little", signed=True)]))
    hub.drain_notifications()
    hub.clear_notifications()
    assert hub.port_values[50] == (2, (-360).to_bytes(4, "little", signed=True), 12.0)
    hub._handle_notification(sender, bytearray([10, 0, 0x47, 50, 1, 10, 0, 0, 0, 1]))
    assert 50 not in hub.port_values


def test_position_wrap_skew_and_session_reset() -> None:
    hub, wheels = feedback()
    wheels.signs = (1, 1)
    pair(hub, 1.0, 2**31 - 2, 2**31 - 2)
    wheels.sample(0, False, 1.0)
    pair(hub, 1.1, -(2**31) + 8, -(2**31) + 8)
    value = wheels.sample(0, False, 1.1)
    assert value["position_radians"] == pytest.approx(10 * math.pi / 180 * 7 / 11)
    hub.port_values[51] = (2, bytes(4), 1.2)
    assert wheels.sample(100, True, 1.2)["sample_time"] == 1.1
    assert wheels.sample(100, True, 1.5) is None
    assert WheelFeedback(hub, (50, 51)).session != wheels.session


def test_optional_read_failure_does_not_escape_or_leave_task() -> None:
    async def run() -> None:
        wheels = WheelFeedback(SimpleNamespace(), (50, 51))
        await wheels.start()
        await asyncio.sleep(0)
        await wheels.close()
        assert wheels.sample(100, True) is None

    asyncio.run(run())


def test_encoder_setup_and_polling_use_readonly_messages_even_when_status_drains_queue() -> None:
    class EncoderHub(TechnicMoveHub):
        def __init__(self) -> None:
            super().__init__()
            self.sent: list[bytes] = []

        async def send(self, data: bytes | bytearray) -> None:
            self.sent.append(bytes(data))
            port = data[3]
            if data[2] == 0x21:
                reply = (
                    [0, 0, 0x43, port, 1, 1, 3, 5, 0, 0, 0]
                    if data[4]
                    else [0, 0, 0x45, port, *(100).to_bytes(4, "little", signed=True)]
                )
            elif data[2] == 0x22:
                mode, kind = data[4:6]
                payload = {
                    0: b"POS" if mode == 2 else b"POWER",
                    4: b"DEG",
                    0x80: bytes([1, 2, 8, 0]),
                    1: struct.pack("<ff", -10000, 10000),
                    3: struct.pack("<ff", -1000, 1000),
                }[kind]
                reply = [0, 0, 0x44, port, mode, kind, *payload]
            else:
                assert data[2] == 0x41
                reply = [0, 0, 0x47, *data[3:]]
            reply[0] = len(reply)
            self._handle_notification(SimpleNamespace(uuid=CHAR_UUID), bytearray(reply))
            self.drain_notifications()

    async def run() -> None:
        hub = EncoderHub()
        wheels = WheelFeedback(hub, (50, 51))
        await wheels.start()
        async with asyncio.timeout(1):
            while len(hub.port_values) < 2:
                await asyncio.sleep(0.01)
        await wheels.close()
        assert wheels.modes == {50: 2, 51: 2}
        assert wheels.scales == {50: 0.1, 51: 0.1}
        assert all(frame[2] in (0x21, 0x22, 0x41) for frame in hub.sent)
        assert any(frame[2] == 0x21 and frame[4] == 0 for frame in hub.sent)

    asyncio.run(run())


def test_live_session_publishes_encoder_travel_to_real_json_protocol(monkeypatch: pytest.MonkeyPatch) -> None:
    hub = SimpleNamespace(hub_name="Technic Move", attached_devices={}, is_connected=True, port_values={})
    calls = 0
    cancelled = []

    class Joystick:
        def get_name(self):
            return "Fixture controller"

        def get_numaxes(self):
            return 6

        def get_numbuttons(self):
            return 16

        def get_button(self, _index):
            return False

        def get_axis(self, index):
            return 1.0 if index == 5 else -1.0 if index == 4 else 0.0

    async def start(_self):
        return 60, 0x100, ["success"]

    async def send(_self, *args, **kwargs):
        return bytes()

    async def wheel_start(self):
        self.modes = {50: 2, 51: 2}
        self.scales = {50: 1, 51: 1}
        self.signs = (1, -1)

    async def shutdown(*_args, **_kwargs):
        cancelled.append(True)

    def poll(*_args):
        nonlocal calls
        calls += 1
        pair(hub, asyncio.get_running_loop().time(), calls * 10, -calls * 10)
        return False, calls > 8

    monkeypatch.setattr(LowLevelControl, "start_play_vm", start)
    monkeypatch.setattr(LowLevelControl, "drive", send)
    monkeypatch.setattr(LowLevelControl, "drain_status_reports", lambda _: [])
    monkeypatch.setattr(WheelFeedback, "start", wheel_start)
    monkeypatch.setattr(session, "poll_controller_events", poll)
    monkeypatch.setattr(session, "safe_shutdown", shutdown)
    monkeypatch.setattr(session, "release_winrt_sta_for_pygame", lambda: None)
    monkeypatch.setattr(session, "update_gamepad_led", lambda *_args, **_kwargs: (0, 0, 0))
    monkeypatch.setattr(session.ControllerLed, "open", lambda _: SimpleNamespace())
    monkeypatch.setattr(
        session.ReverseBeep,
        "open",
        lambda *_args, **_kwargs: SimpleNamespace(update=lambda *_: None, stop=lambda: None),
    )
    monkeypatch.setattr(session, "reverse_beep_status", lambda *_args: "off")
    stream = StringIO()
    console = ProtocolLiveConsole(JsonLineEmitter(stream), min_telemetry_interval_s=0)
    asyncio.run(
        session.run_live_session(
            ModelProfile.load("tumbler"),
            GamepadProfile.load("dualsense"),
            {"roles": {"play_vm": "0x36", "drive_left": "0x32", "drive_right": "0x33"}},
            session.ConnectedHardware(hub, SimpleNamespace(), Joystick()),
            live_console=console,
        )
    )
    positions = [
        event["telemetry"]["wheel_motion"]["position_radians"]
        for event in map(json.loads, stream.getvalue().splitlines())
        if event["type"] == "telemetry" and event["telemetry"]["wheel_motion"]
    ]
    assert len(positions) == 8
    assert positions[-1] > positions[0]
    assert cancelled == [True]


def test_incomplete_ble_pairs_preserve_rest_and_direction_learning() -> None:
    hub, wheels = feedback()
    for at in (1.0, 1.1, 1.2):
        pair(hub, at, 0, 0)
        wheels.sample(0, False, at)
    wheels.sample(30, False, 1.3)
    # The first motor reply arrives before the second, in every poll cycle.
    for index in range(1, 7):
        at = 1.3 + index * 0.1
        hub.port_values[50] = (2, (index * 20).to_bytes(4, "little", signed=True), at)
        wheels.sample(30, False, at)
        pair(hub, at, index * 20, -index * 20)
        value = wheels.sample(30, False, at)
    assert value is not None
    assert value["position_radians"] > 0
