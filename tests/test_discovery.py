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
        monkeypatch.setattr(discovery, "bluetooth_status", lambda: SimpleNamespace(ready=True, detail="Available"))
        monkeypatch.setattr(
            discovery, "detect_controller", lambda: {"name": "Steam Controller", "profile": "steamdeck"}
        )
        monkeypatch.setattr(discovery, "find_advertised_hub", scan)
        out = SimpleNamespace(emit=lambda kind, **payload: events.append((kind, payload)))
        task = asyncio.create_task(discovery.discover_hardware(out, "Technic Move", None))
        for _ in range(150):
            await asyncio.sleep(0.01)
            if any(payload.get("telemetry", {}).get("vehicle") for _, payload in events):
                break
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
