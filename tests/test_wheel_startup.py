"""Exercise cold encoder startup through real asynchronous LWP3 decoding."""

from __future__ import annotations

import asyncio
import json
import struct
import time
from contextlib import suppress
from io import StringIO
from types import SimpleNamespace

import pytest

from bridge import protocol, session
from bridge.cars.tumbler.wheel_feedback import WheelFeedback
from bridge.transport import CHAR_UUID, TechnicMoveHub
from tests.fake_hub import FakeHub

PORTS = (0x32, 0x33)


@pytest.fixture(autouse=True)
def python39_asyncio(monkeypatch: pytest.MonkeyPatch) -> None:
    """Exercise the supported Python 3.9 API even when CI uses newer Python."""
    monkeypatch.delattr(asyncio, "timeout", raising=False)


class AsyncEncoderHub(TechnicMoveHub):
    """Reply with the physical hub's POS layout, without populating caches directly."""

    def __init__(self, first_metadata_delay: float | None = 0.004, responsive: bool = True) -> None:
        super().__init__()
        self.first_metadata_delay = first_metadata_delay
        self.responsive = responsive
        self.metadata_attempts = 0
        self.positions = {port: 0 for port in PORTS}
        self.sent: list[bytes] = []
        self.replies: set[asyncio.Task[None]] = set()

    def _reply_later(self, frame: list[int], delay: float) -> None:
        async def deliver() -> None:
            await asyncio.sleep(delay)
            frame[0] = len(frame)
            self._handle_notification(SimpleNamespace(uuid=CHAR_UUID), bytearray(frame))
            # PLAYVM drains the queue during ordinary driving; decoder caches must survive.
            self.drain_notifications()

        task = asyncio.create_task(deliver())
        self.replies.add(task)
        task.add_done_callback(self.replies.discard)

    async def send(self, data: bytes | bytearray) -> None:
        frame = bytes(data)
        self.sent.append(frame)
        if not self.responsive:
            return
        kind, port = frame[2:4]
        if kind == 0x21:
            if frame[4] == 1:
                # Saved 88019 probe: POWER/POS/GOPOS readable, all five modes writable.
                self._reply_later([0, 0, 0x43, port, 1, 3, 5, 0b1101, 0, 0b11111, 0], 0.004)
            else:
                assert frame[4] == 0
                value = self.positions[port].to_bytes(4, "little", signed=True)
                # The two values arrive separately, as they do over BLE.
                self._reply_later([0, 0, 0x45, port, *value], 0.004 if port == PORTS[0] else 0.009)
        elif kind == 0x22:
            mode, information = frame[4:6]
            payload = {
                0: {0: b"POWER", 2: b"POS", 3: b"GOPOS"}[mode],
                4: b"DEG",
                0x80: bytes((1, 2, 4, 0)),
                1: struct.pack("<ff", -360, 360),
                3: struct.pack("<ff", -360, 360),
            }[information]
            delay = 0.004
            if port == PORTS[0] and mode == 0 and information == 0:
                self.metadata_attempts += 1
                if self.metadata_attempts == 1:
                    if self.first_metadata_delay is None:
                        return
                    delay = self.first_metadata_delay
            self._reply_later([0, 0, 0x44, port, mode, information, *payload], delay)
        else:
            assert kind == 0x41, "Encoder startup must never issue a motor output command"
            self._reply_later([0, 0, 0x47, *frame[3:]], 0.004)

    async def close_replies(self) -> None:
        for task in self.replies:
            task.cancel()
        await asyncio.gather(*self.replies, return_exceptions=True)


class CalibratedEncoderHub(AsyncEncoderHub):
    """Run the captured PLAYVM startup and asynchronous encoder replies together."""

    def __init__(self, first_metadata_delay: float | None, responsive: bool) -> None:
        super().__init__(first_metadata_delay=first_metadata_delay, responsive=responsive)
        self.playvm = FakeHub()
        self.playvm.port_infos = self.port_infos
        self.connected = True
        self.disconnects = 0
        self.hub_name = "Technic Move"

    @property
    def is_connected(self) -> bool:
        return self.connected

    async def disconnect(self) -> None:
        self.connected = False
        self.disconnects += 1

    async def send(self, data: bytes | bytearray) -> None:
        if data[2] not in (0x61, 0x81) and data[3] in PORTS:
            await super().send(data)
            return
        self.sent.append(bytes(data))
        await self.playvm.send(data)
        for frame in self.playvm.drain_notifications():
            self._handle_notification(SimpleNamespace(uuid=CHAR_UUID), bytearray(frame))


@pytest.mark.parametrize(
    "metadata_delay, responsive",
    [(0.004, True), (None, True), (0.004, False)],
    ids=["cold-encoders", "lost-metadata-reply", "unavailable-encoders"],
)
def test_python39_full_live_startup_reaches_ready_without_reconnecting(
    monkeypatch: pytest.MonkeyPatch, metadata_delay: float | None, responsive: bool
) -> None:
    """Do not stub wheel startup or calibration: this is the original preparation failure."""
    hub = CalibratedEncoderHub(metadata_delay, responsive)
    connections = []
    polls = 0
    quitting = []

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

    async def bluetooth(_setup):
        return None

    async def port_map(*_args):
        return {"roles": {"play_vm": "0x36", "drive_left": "0x32", "drive_right": "0x33"}}

    async def hardware(*_args, **_kwargs):
        connections.append(True)
        assert len(connections) == 1, "Preparation must not disconnect and reconnect healthy hardware"
        return (
            session.GamepadProfile.load("dualsense"),
            session.ConnectedHardware(hub, SimpleNamespace(quit=lambda: quitting.append(True)), Joystick()),
        )

    def poll(*_args):
        nonlocal polls
        polls += 1
        assert hub.is_connected, "Keep the hub connected until the explicit stop"
        hub.positions[PORTS[0]] = polls * 20
        hub.positions[PORTS[1]] = -polls * 20
        return False, polls > 65

    monkeypatch.setattr(protocol, "wait_for_bluetooth", bluetooth)
    monkeypatch.setattr(protocol, "prepare_port_map_for_drive", port_map)
    monkeypatch.setattr(protocol, "wait_for_drive_hardware", hardware)
    monkeypatch.setattr(session, "poll_controller_events", poll)
    monkeypatch.setattr(session, "release_winrt_sta_for_pygame", lambda: None)
    monkeypatch.setattr(session.ControllerLed, "open", lambda _: session.ControllerLed())
    monkeypatch.setattr(
        session.ReverseBeep,
        "open",
        lambda *_args, **_kwargs: SimpleNamespace(update=lambda *_: None, stop=lambda: None),
    )
    monkeypatch.setattr(session, "reverse_beep_status", lambda *_args: "off")
    stream = StringIO()

    async def run() -> None:
        try:
            await asyncio.wait_for(
                protocol.run_protocol_live_control(
                    protocol.JsonLineEmitter(stream), "tumbler", "auto", hub.hub_name, None
                ),
                timeout=7,
            )
        finally:
            await hub.close_replies()

    asyncio.run(run())
    events = [json.loads(line) for line in stream.getvalue().splitlines()]
    logs = [event["message"] for event in events if event["type"] == "log"]
    assert "  calibration status 0x00100: success" in logs
    assert "Ready." in logs
    assert not any("Controller input stopped" in line or "Link lost" in line for line in logs)
    assert len(connections) == 1
    assert hub.disconnects == 1, "Disconnect only after the explicit exit requested by the test"
    assert quitting == [True]
    telemetry = [event["telemetry"] for event in events if event["type"] == "telemetry"]
    assert len(telemetry) > 5, "Live control must continue beyond preparation"
    measured = [sample["wheel_motion"] for sample in telemetry if sample["wheel_motion"] is not None]
    if responsive:
        assert measured and measured[-1]["position_radians"] > 0
    else:
        assert not measured, "Missing optional feedback must leave driving available without invented wheel motion"


async def first_drive(hub: AsyncEncoderHub, wheels: WheelFeedback, throttle: int, boost: bool) -> list[dict]:
    """Hold the first control immediately, with no release or second drive to learn polarity."""
    direction = -1 if throttle < 0 else 1
    wheels.sample(throttle, boost)
    observed = []
    for index in range(1, 21):
        hub.positions[PORTS[0]] = direction * index * 20
        hub.positions[PORTS[1]] = -direction * index * 20
        await asyncio.sleep(0.06)
        value = wheels.sample(throttle, boost)
        if value is not None:
            observed.append(value)
    return observed


@pytest.mark.parametrize("throttle, boost", [(40, False), (-40, False), (0, True)])
def test_cold_start_first_held_forward_reverse_and_boost_produce_encoder_motion(throttle: int, boost: bool) -> None:
    async def run() -> None:
        hub = AsyncEncoderHub()
        wheels = WheelFeedback(hub, PORTS)
        try:
            await asyncio.wait_for(wheels.start(), timeout=2.5)
            measured = await first_drive(hub, wheels, throttle, boost)
            assert measured, "The very first held control must learn polarity after cold encoder startup"
            direction = -1 if throttle < 0 else 1
            assert measured[-1]["position_radians"] * direction > 0
            assert all(value["source"] == "encoder" for value in measured)
            assert all(value["session"] == wheels.session for value in measured)
            assert wheels.signs == (1, -1)
            assert wheels.modes == dict.fromkeys(PORTS, 2)
            assert wheels.scales == dict.fromkeys(PORTS, 1.0)
            assert all(frame[2] in (0x21, 0x22, 0x41) for frame in hub.sent)
        finally:
            await wheels.close()
            await hub.close_replies()

    asyncio.run(run())


@pytest.mark.parametrize("first_metadata_delay", [None, 0.45], ids=["lost-first-reply", "late-first-reply"])
def test_optional_metadata_reply_failure_retries_then_first_drive_works(first_metadata_delay: float | None) -> None:
    async def run() -> None:
        hub = AsyncEncoderHub(first_metadata_delay=first_metadata_delay)
        wheels = WheelFeedback(hub, PORTS)
        try:
            await asyncio.wait_for(wheels.start(), timeout=2.5)
            measured = await first_drive(hub, wheels, 40, False)
            assert measured, "A transient missing metadata response must not disable wheels for the session"
            assert measured[-1]["position_radians"] > 0
            # A lost reply is retried; a late reply may arrive during the
            # bounded retry window and satisfy the same request instead.
            if first_metadata_delay is None:
                assert hub.metadata_attempts >= 2
            else:
                assert hub.metadata_attempts >= 1
            # Successfully acknowledged POS subscriptions must not be repeatedly reset.
            assert [frame[3] for frame in hub.sent if frame[2] == 0x41] == list(PORTS)
            assert wheels.task is not None and not wheels.task.done()
        finally:
            await wheels.close()
            await hub.close_replies()

    asyncio.run(run())


def test_never_responding_encoder_startup_is_bounded_and_cancels_reads() -> None:
    async def run() -> None:
        hub = AsyncEncoderHub(responsive=False)
        wheels = WheelFeedback(hub, PORTS)
        started = time.monotonic()
        try:
            await asyncio.wait_for(wheels.start(), timeout=2.5)
            assert time.monotonic() - started < 2.5
            assert wheels.sample(100, True) is None
            assert len(hub.sent) >= 2, "Missing optional encoder information must be retried"
        finally:
            await asyncio.wait_for(wheels.close(), timeout=0.2)
            await hub.close_replies()
        assert wheels.task is not None and wheels.task.done()
        sent_at_close = len(hub.sent)
        await asyncio.sleep(0.12)
        assert len(hub.sent) == sent_at_close

    asyncio.run(run())


def test_cancelled_encoder_startup_leaves_no_polling_after_close() -> None:
    async def run() -> None:
        hub = AsyncEncoderHub(responsive=False)
        wheels = WheelFeedback(hub, PORTS)
        startup = asyncio.create_task(wheels.start())
        await asyncio.sleep(0.02)
        startup.cancel()
        with suppress(asyncio.CancelledError):
            await startup
        await asyncio.wait_for(wheels.close(), timeout=0.2)
        await hub.close_replies()
        assert wheels.task is not None and wheels.task.done()
        sent_at_close = len(hub.sent)
        await asyncio.sleep(0.12)
        assert len(hub.sent) == sent_at_close

    asyncio.run(run())


def test_motion_learning_recovers_when_encoder_discovery_finishes_after_first_drive() -> None:
    """Delayed encoder setup must not require releasing and pressing the trigger again."""
    hub = TechnicMoveHub()
    wheels = WheelFeedback(hub, PORTS)
    # The first held command arrives while the optional encoder discovery is
    # still in flight, so samples are intentionally ignored at this point.
    wheels.sample(40, False, 10.0)
    wheels.modes = dict.fromkeys(PORTS, 2)
    wheels.scales = dict.fromkeys(PORTS, 1.0)

    for index in range(3, 11):
        at = 10.0 + index * 0.1
        hub.port_values = {
            PORTS[0]: (2, (index * 20).to_bytes(4, "little", signed=True), at),
            PORTS[1]: (2, (-index * 20).to_bytes(4, "little", signed=True), at),
        }
        wheels.sample(40, False, at)

    assert wheels.signs == (1, -1)
    assert wheels.sample(40, False, 10.8)["position_radians"] > 0
