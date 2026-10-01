"""Exercise cold encoder startup through real asynchronous LWP3 decoding."""

from __future__ import annotations

import asyncio
import struct
import time
from contextlib import suppress
from types import SimpleNamespace

import pytest

from bridge.cars.tumbler.wheel_feedback import WheelFeedback
from bridge.transport import CHAR_UUID, TechnicMoveHub

PORTS = (0x32, 0x33)


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
            assert hub.metadata_attempts >= 2
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
