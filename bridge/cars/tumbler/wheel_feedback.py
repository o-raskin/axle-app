"""Read-only, session-scoped drivetrain position feedback for the viewer."""

from __future__ import annotations

import asyncio
import math
import time
import uuid
from contextlib import suppress
from functools import partial
from typing import Any, Callable

POSITION_BYTES = 4
MAX_AGE_S = 0.3
PAIR_SKEW_S = 0.05
REST_S = 0.1
DIRECTION_S = 0.25
SIGN_SAMPLES = 2
READ_TIMEOUT_S = 0.4
READ_RETRY_S = 0.1
STARTUP_WARMUP_S = 2.0


class WheelFeedback:
    """Observe POS encoders without estimating velocity from motor power."""

    def __init__(self, hub: Any, ports: tuple[int, int], log: Callable[[str], None] | None = None) -> None:
        """Bind one hub session and its physical drive ports."""
        self.log = log or (lambda _message: None)
        self.hub = hub
        self.ports = ports
        self.modes: dict[int, int] = {}
        self.scales: dict[int, float] = {}
        self.session = uuid.uuid4().hex
        self.task: asyncio.Task[None] | None = None
        self.previous: tuple[int, ...] | None = None
        self.previous_time = 0.0
        self.rest_since: float | None = None
        self.direction = 0
        self.direction_since = 0.0
        self.can_learn = False
        self.signs: tuple[int, ...] | None = None
        self.evidence: list[tuple[int, ...]] = []
        self.position = 0.0

    async def start(self) -> None:
        """Observe the calibrated, neutral drivetrain before accepting drive input."""
        self.task = asyncio.create_task(self._read())
        try:
            async with asyncio.timeout(STARTUP_WARMUP_S):
                while not self.task.done():
                    now = time.monotonic()
                    self.sample(0, False, now)
                    if self.rest_since is not None and now - self.rest_since >= REST_S:
                        return
                    await asyncio.sleep(0.01)
        except TimeoutError:
            # Driving remains usable when encoder reads are unavailable. The
            # reader keeps retrying; a later standstill can establish polarity.
            self.log("Wheel feedback is still starting; encoder reads will retry in the background.")

    async def close(self) -> None:
        """Cancel optional reads before the hub is shut down."""
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task

    def _has_info(self, port: int) -> bool:
        return bool(port in self.hub.port_infos and self.hub.port_infos[port].input_modes is not None)

    def _has_mode_field(self, port: int, mode: int, field: str) -> bool:
        info = self.hub.port_infos[port]
        return mode in info.mode_infos and getattr(info.mode_infos[mode], field) is not None

    def _subscribed(self, port: int, mode: int) -> bool:
        return bool(self.hub.input_modes.get(port) == mode)

    async def _until(self, predicate: Callable[[], bool]) -> None:
        async with asyncio.timeout(READ_TIMEOUT_S):
            while not predicate():
                await asyncio.sleep(0.01)

    async def _mode_field(self, port: int, mode: int, field: str, kind: int) -> None:
        if not self._has_mode_field(port, mode, field):
            await asyncio.wait_for(self.hub.request_mode_info(port, mode, kind), timeout=READ_TIMEOUT_S)
            await self._until(partial(self._has_mode_field, port, mode, field))

    async def _configure_port(self, port: int) -> bool:
        if port in self.modes and self._subscribed(port, self.modes[port]):
            return True
        if not self._has_info(port):
            await asyncio.wait_for(self.hub.request_port_info(port), timeout=READ_TIMEOUT_S)
            await self._until(partial(self._has_info, port))
        info = self.hub.port_infos[port]
        for mode in range(16):
            if not (info.input_modes or 0) & (1 << mode):
                continue
            await self._mode_field(port, mode, "name", 0)
            if info.mode_infos[mode].name != "POS":
                continue
            for field, kind in (("symbol", 4), ("value_format", 0x80), ("raw_range", 1), ("si_range", 3)):
                await self._mode_field(port, mode, field, kind)
            metadata = info.mode_infos[mode]
            if metadata.symbol != "DEG" or metadata.value_format is None or metadata.value_format[:2] != (1, 2):
                continue
            raw, si = metadata.raw_range, metadata.si_range
            if not raw or not si or raw[1] == raw[0]:
                continue
            scale = (si[1] - si[0]) / (raw[1] - raw[0])
            if not math.isfinite(scale) or scale <= 0:
                continue
            self.scales[port] = scale
            if not self._subscribed(port, mode):
                await asyncio.wait_for(
                    self.hub.subscribe_port_value(port, mode, delta_interval=10), timeout=READ_TIMEOUT_S
                )
                await self._until(partial(self._subscribed, port, mode))
            self.modes[port] = mode
            return True
        self.log(f"Wheel feedback unavailable: port {port:#04x} has no supported position input mode.")
        return False

    async def _read(self) -> None:
        retry_announced = False
        while True:
            try:
                for port in self.ports:
                    if not await self._configure_port(port):
                        return
                if retry_announced:
                    self.log("Wheel encoder reads recovered.")
                    retry_announced = False
                for port in self.ports:
                    # Information type 0 requests the current value, including
                    # stationary positions. Never send motor output commands.
                    await asyncio.wait_for(self.hub.request_port_info(port, 0), timeout=READ_TIMEOUT_S)
                await asyncio.sleep(READ_RETRY_S)
            except (OSError, RuntimeError, TimeoutError) as exc:
                if not retry_announced:
                    self.log(f"Wheel encoder read delayed; retrying ({type(exc).__name__}: {exc}).")
                    retry_announced = True
                await asyncio.sleep(READ_RETRY_S)
            except (AttributeError, TypeError, KeyError, ValueError) as exc:
                self.log(f"Wheel feedback unavailable: {type(exc).__name__}: {exc}")
                return

    def sample(self, throttle: int, boost: bool, now: float | None = None) -> dict[str, Any] | None:
        """Convert paired measured motor degrees to mean rear-wheel radians."""
        now = time.monotonic() if now is None else now
        values = getattr(self.hub, "port_values", {})
        samples = [values[port] for port in self.ports if port in values]
        if len(self.modes) != len(self.ports) or len(samples) != len(self.ports):
            return None
        if any(
            sample[0] != self.modes[port] or len(sample[1]) != POSITION_BYTES
            for port, sample in zip(self.ports, samples)
        ):
            return None
        timestamps = [sample[2] for sample in samples]
        at = min(timestamps)
        if now - at > MAX_AGE_S:
            self.previous = None
            self.rest_since = None
            self.can_learn = False
            return None
        if max(timestamps) - at > PAIR_SKEW_S:
            # BLE delivers the two port replies separately. A brief incomplete
            # pair must not erase the standstill/direction evidence or reset the
            # viewer's origin; keep only the last confirmed, still-fresh pair.
            return self._snapshot(now)
        positions = tuple(int.from_bytes(sample[1], "little", signed=True) for sample in samples)
        direction = 1 if throttle > 0 or (boost and throttle == 0) else -1 if throttle < 0 else 0
        if direction != self.direction:
            self.can_learn = direction != 0 and self.rest_since is not None and now - self.rest_since >= REST_S
            self.direction = direction
            self.direction_since = now
            self.evidence.clear()
        if at > self.previous_time:
            if self.previous is not None:
                deltas = tuple((new - old + 2**31) % 2**32 - 2**31 for new, old in zip(positions, self.previous))
                if all(delta == 0 for delta in deltas):
                    if self.rest_since is None:
                        self.rest_since = at
                else:
                    self.rest_since = None
                    if (
                        self.signs is None
                        and self.can_learn
                        and direction
                        and now - self.direction_since >= DIRECTION_S
                    ):
                        if all(delta != 0 for delta in deltas):
                            signs = tuple(direction * (1 if delta > 0 else -1) for delta in deltas)
                            self.evidence.append(signs)
                            if len(self.evidence) >= SIGN_SAMPLES and self.evidence[-1] == self.evidence[-2]:
                                self.signs = signs
                    if self.signs is not None:
                        self.position += (
                            sum(
                                delta * sign * self.scales[port]
                                for port, delta, sign in zip(self.ports, deltas, self.signs)
                            )
                            / 2
                            * math.pi
                            / 180
                            * 7
                            / 11
                        )
            self.previous = positions
            self.previous_time = at
        return self._snapshot(now)

    def _snapshot(self, now: float) -> dict[str, Any] | None:
        if self.signs is None or self.previous is None or now - self.previous_time > MAX_AGE_S:
            return None
        return {
            "source": "encoder",
            "session": self.session,
            "position_radians": self.position,
            "sample_time": self.previous_time,
            "sample_age_ms": max(0, (now - self.previous_time) * 1000),
        }
