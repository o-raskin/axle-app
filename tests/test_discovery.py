"""Startup detection must not arm hardware and must release scanners on Stop."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from bridge import discovery, transport
from bridge.cli import build_parser
from bridge.protocol import operation_from_args


def test_controller_recognition_releases_sdl_handles(monkeypatch: pytest.MonkeyPatch) -> None:
    closed = []
    connection = SimpleNamespace(
        joystick=SimpleNamespace(get_name=lambda: "Wireless Controller"),
        profile=SimpleNamespace(profile_id="dualsense"),
        pygame_mod=SimpleNamespace(quit=lambda: closed.append(True)),
    )
    monkeypatch.setattr(discovery, "try_init_gamepad_candidates", lambda _profiles: (connection, ""))
    assert discovery.detect_controller() == {"name": "Wireless Controller", "profile": "dualsense"}
    assert closed == [True]


def test_discovery_scans_passively_publishes_both_devices_and_cancels_scanner(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str, dict[str, Any]]] = []
    scanner_stopped = []

    async def scan(name: str, address: str | None) -> Any:
        assert name == "Technic Move" and address is None
        return SimpleNamespace(name="Technic Move", address="AA:BB")

    async def scenario() -> None:
        observed = asyncio.Event()
        monkeypatch.setattr(discovery, "bluetooth_status", lambda: SimpleNamespace(ready=True, detail="Available"))
        monkeypatch.setattr(
            discovery, "detect_controller", lambda: {"name": "Steam Controller", "profile": "steamdeck"}
        )
        monkeypatch.setattr(discovery, "find_advertised_hub", scan)

        def publish(kind: str, **payload: Any) -> None:
            events.append((kind, payload))
            if payload.get("telemetry", {}).get("vehicle"):
                observed.set()

        out = SimpleNamespace(emit=publish)
        task = asyncio.create_task(discovery.discover_hardware(out, "Technic Move", None))
        try:
            await asyncio.wait_for(observed.wait(), timeout=3)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        scanner_stopped.extend(t.get_coro().__name__ for t in asyncio.all_tasks() if t is not asyncio.current_task())

    asyncio.run(scenario())
    frames = [payload["telemetry"] for kind, payload in events if kind == "telemetry"]
    assert any(frame["controller"] and frame["vehicle"] for frame in frames)
    assert all(frame["kind"] == "hardwareDiscovery" for frame in frames)
    assert scanner_stopped == []


def test_discovery_dispatch_is_separate_from_live_control() -> None:
    args = build_parser().parse_args(["--frontend", "jsonl", "--discover"])
    assert operation_from_args(args) == "discover"


def test_passive_scan_matches_advertised_name_or_explicit_address_without_connecting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scan(predicate: Any, timeout: float) -> Any:
        assert timeout == 3.0
        assert predicate(SimpleNamespace(name=None, address="AA:BB"), SimpleNamespace(local_name="Technic Move"))
        assert not predicate(SimpleNamespace(name="Other hub", address="CC:DD"), SimpleNamespace(local_name=None))
        return SimpleNamespace(address="AA:BB")

    monkeypatch.setattr(transport.BleakScanner, "find_device_by_filter", scan)
    monkeypatch.setattr(transport, "BleakClient", lambda *_a, **_kw: pytest.fail("Passive scanning must not connect"))
    assert asyncio.run(transport.find_advertised_hub("Technic Move", None)).address == "AA:BB"
    assert asyncio.run(transport.find_advertised_hub("Ignored name", "aa:bb")).address == "AA:BB"


def test_live_reconnect_matches_local_advertised_name_when_device_name_is_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeClient:
        services: list[Any] = []
        is_connected = True

        async def connect(self) -> None:
            return None

        async def pair(self, **_kwargs: Any) -> None:
            return None

    async def scan(predicate: Any, timeout: float) -> Any:
        assert timeout == transport.SCAN_TIMEOUT_S
        device = SimpleNamespace(name=None, address="AA:BB")
        advertisement = SimpleNamespace(local_name="Technic Move")
        assert predicate(device, advertisement)
        return device

    monkeypatch.setattr(transport.BleakScanner, "find_device_by_filter", scan)
    monkeypatch.setattr(transport, "BleakClient", lambda _device: FakeClient())

    hub = transport.TechnicMoveHub()
    asyncio.run(hub.connect())
    assert hub.is_connected


def test_hub_serializes_concurrent_playvm_and_encoder_writes() -> None:
    # A hub can be constructed before asyncio.run, including on Python 3.9.
    hub = transport.TechnicMoveHub()

    class FakeClient:
        is_connected = True

        def __init__(self) -> None:
            self.active_writes = 0
            self.overlapping_write = False
            self.frames: list[bytes] = []

        async def write_gatt_char(self, _uuid: str, data: bytes | bytearray, response: bool) -> None:
            assert response is False
            self.active_writes += 1
            self.overlapping_write |= self.active_writes > 1
            await asyncio.sleep(0)
            self.frames.append(bytes(data))
            self.active_writes -= 1

    async def run() -> FakeClient:
        client = FakeClient()
        hub.client = client
        await asyncio.gather(hub.send(b"playvm"), hub.send(b"encoder"))
        return client

    client = asyncio.run(run())
    assert not client.overlapping_write
    assert client.frames == [b"playvm", b"encoder"]
