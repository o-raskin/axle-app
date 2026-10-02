"""Read-only hub scans parse real wire replies and persist physical wiring."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from bleak.exc import BleakError

from bridge import hub_probe, transport
from bridge.port_map import load_port_map, port_id
from bridge.transport import CHAR_UUID


class ImmediatePacing:
    async def sleep(self, _delay: float) -> None:
        pass

    def __getattr__(self, name: str) -> Any:
        return getattr(asyncio, name)


class ProbeBleClient:
    def __init__(self, *, empty: bool = False, failed_request: int | None = None) -> None:
        self.services = [SimpleNamespace(characteristics=[SimpleNamespace(properties=["notify"], uuid=CHAR_UUID)])]
        self.empty = empty
        self.failed_request = failed_request
        self.callback: Any = None
        self.is_connected = False
        self.disconnects = 0
        self.requests: list[bytes] = []

    async def connect(self) -> None:
        self.is_connected = True

    async def pair(self, **_kwargs: Any) -> None:
        pass

    async def start_notify(self, _characteristic: Any, callback: Any) -> None:
        self.callback = callback
        if self.empty:
            return
        # Include a virtual motor created by a previous control session. It must
        # be documented, while the persisted roles still identify physical I/O.
        self.reply([9, 0, 4, 0x14, 2, 0x56, 0, 0x32, 0x33])
        for port, io_type in ((0x32, 0x56), (0x33, 0x56), (0x34, 0x57), (0x35, 0x58), (0x36, 0x59), (0x40, 0x9999)):
            self.reply([15, 0, 4, port, 1, *io_type.to_bytes(2, "little"), *bytes(8)])

    def reply(self, frame: list[int]) -> None:
        self.callback(SimpleNamespace(uuid=CHAR_UUID), bytearray(frame))

    async def write_gatt_char(self, uuid: str, data: bytes | bytearray, response: bool) -> None:
        assert uuid == CHAR_UUID and not response
        self.requests.append(bytes(data))
        kind, port = data[2:4]
        if kind == self.failed_request:
            raise BleakError("Hub vanished during inspection")
        assert kind in {0x21, 0x22}, "A probe must never arm or move the motors"
        if port == 0x40:
            return  # Unknown peripherals can omit details without losing physical roles.
        if kind == 0x21:
            self.reply([11, 0, 0x43, port, 1, 15, 2, 3, 0, 1, 0])
        else:
            mode, field = data[4:6]
            payload = {
                0: b"POWER" if mode == 0 else b"POS",
                4: b"PCT" if mode == 0 else b"DEG",
                5: bytes([3 if mode == 0 else 2, 0]),
                0x80: bytes([1, 0 if mode == 0 else 2, 8, 0]),
            }[field]
            self.reply([6 + len(payload), 0, 0x44, port, mode, field, *payload])

    async def disconnect(self) -> None:
        self.disconnects += 1
        self.is_connected = False


def install_ble(monkeypatch: pytest.MonkeyPatch, client: ProbeBleClient) -> None:
    async def find(predicate: Any, **_kwargs: Any) -> SimpleNamespace:
        device = SimpleNamespace(address="AA:BB", name="Technic Move")
        assert predicate(device, SimpleNamespace(local_name="Technic Move"))
        return device

    monkeypatch.setattr(transport.BleakScanner, "find_device_by_filter", find)
    monkeypatch.setattr(transport, "BleakClient", lambda _device: client)
    monkeypatch.setattr(transport, "asyncio", ImmediatePacing())


@pytest.mark.parametrize("empty", [False, True], ids=["physical-and-virtual-topology", "no-announced-ports"])
def test_scan_to_report_and_saved_port_map_uses_actual_transport_parsing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, empty: bool
) -> None:
    client = ProbeBleClient(empty=empty)
    install_ble(monkeypatch, client)
    port_map, report = asyncio.run(hub_probe.scan_hub())
    map_path = tmp_path / "runtime" / "config" / "port_map.json"
    report_path = tmp_path / "reports" / "hub_scheme.txt"
    hub_probe.save_probe_outputs(port_map, report, map_path, report_path)
    assert load_port_map(map_path) == port_map
    assert port_map["hub"] == {"name": "Technic Move", "address": "aa:bb"}
    assert report_path.read_text() == report
    assert client.disconnects == 1 and not client.is_connected
    if empty:
        assert not port_map["roles"] and not client.requests
        assert "No attached devices were reported" in report
        assert "No detailed port information" in report and "No roles inferred" in report
    else:
        assert port_map["roles"] == {
            "drive_left": "0x32",
            "drive_right": "0x33",
            "steering": "0x34",
            "lights": "0x35",
            "play_vm": "0x36",
        }
        assert port_id(load_port_map(map_path), "drive_left") == 0x32
        assert "virtual from 0x32 + 0x33" in report
        assert "Unknown IO 0x9999" in report
        assert "output, input, logical-combinable, logical-synchronizable" in report
        assert "input modes: 0, 1" in report
        assert "mode 1: name=POS, symbol=DEG, mapping=0x0002, value_format=(1, 2, 8, 0)" in report
        assert {request[2] for request in client.requests} == {0x21, 0x22}


@pytest.mark.parametrize("failed_request", [0x21, 0x22], ids=["port-info", "mode-metadata"])
def test_failed_inspection_disconnects_the_real_transport_before_propagating_error(
    monkeypatch: pytest.MonkeyPatch, failed_request: int
) -> None:
    client = ProbeBleClient(failed_request=failed_request)
    install_ble(monkeypatch, client)
    with pytest.raises(BleakError, match="vanished during inspection"):
        asyncio.run(hub_probe.scan_hub())
    assert client.disconnects == 1 and not client.is_connected


def test_cancelled_metadata_scan_releases_the_ble_write_and_disconnects(monkeypatch: pytest.MonkeyPatch) -> None:
    async def run() -> None:
        blocked = asyncio.Event()
        released = []
        client = ProbeBleClient()
        write = client.write_gatt_char

        async def stall(uuid: str, data: bytes | bytearray, response: bool) -> None:
            if data[2] == 0x22:
                blocked.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    released.append(True)
            else:
                await write(uuid, data, response)

        monkeypatch.setattr(client, "write_gatt_char", stall)
        install_ble(monkeypatch, client)
        scan = asyncio.create_task(hub_probe.scan_hub())
        await asyncio.wait_for(blocked.wait(), timeout=1)
        scan.cancel()
        with pytest.raises(asyncio.CancelledError):
            await scan
        assert released == [True]
        assert client.disconnects == 1 and not client.is_connected
        assert len(asyncio.all_tasks()) == 1

    asyncio.run(run())
