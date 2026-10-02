"""Exercise BLE lifecycle and decoding against the actual transport boundary."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from bridge import transport
from bridge.transport import CHAR_UUID, TechnicMoveHub


class BleClient:
    def __init__(self, fail_at=None):
        self.fail_at = fail_at
        self.is_connected = False
        self.disconnects = 0
        self.callbacks = []
        self.services = [SimpleNamespace(characteristics=[SimpleNamespace(properties=["notify"], uuid=CHAR_UUID)])]

    async def connect(self):
        self.is_connected = True
        if self.fail_at == "connect":
            raise RuntimeError("connect failed halfway")

    async def pair(self, **_kwargs):
        if self.fail_at == "pair":
            raise asyncio.CancelledError

    async def start_notify(self, _characteristic, callback):
        self.callbacks.append(callback)
        if self.fail_at == "notify":
            raise RuntimeError("subscribe failed")

    async def disconnect(self):
        self.disconnects += 1
        self.is_connected = False


def install_ble(monkeypatch, clients):
    async def find(*_args, **_kwargs):
        return SimpleNamespace(address="AA:BB", name="Technic Move")

    monkeypatch.setattr(transport.BleakScanner, "find_device_by_filter", find)
    monkeypatch.setattr(transport, "BleakClient", lambda _target: clients.pop(0))


def test_hub_matching_checks_both_names_and_address_override_stays_authoritative():
    device = SimpleNamespace(name="Technic Move", address="AA:BB")
    advertisement = SimpleNamespace(local_name="Shortened advert")
    assert transport.hub_advertisement_matches("Technic Move", None, device, advertisement)
    assert not transport.hub_advertisement_matches("Technic Move", "CC:DD", device, advertisement)


@pytest.mark.parametrize("failure", ["connect", "notify", "pair"])
def test_partial_connect_and_cancellation_release_ble_client(monkeypatch, failure):
    client = BleClient(failure)
    install_ble(monkeypatch, [client])
    hub = TechnicMoveHub()

    async def run():
        with pytest.raises(asyncio.CancelledError if failure == "pair" else RuntimeError):
            await hub.connect()

    asyncio.run(run())
    assert client.disconnects == 1
    assert not hub.is_connected
    assert hub.client is None


def test_reconnect_drops_old_topology_and_ignores_old_client_callbacks(monkeypatch):
    first, second = BleClient(), BleClient()
    install_ble(monkeypatch, [first, second])
    hub = TechnicMoveHub()
    frame = bytearray([15, 0, 4, 0x32, 1, 0x56, 0, *([0] * 8)])
    sender = SimpleNamespace(uuid=CHAR_UUID)

    async def run():
        await hub.connect()
        first.callbacks[0](sender, frame)
        assert 0x32 in hub.attached_devices
        await hub.disconnect()
        await hub.connect()
        assert hub.attached_devices == {}
        first.callbacks[0](sender, frame)
        assert hub.attached_devices == {}
        second.callbacks[0](sender, frame)
        assert 0x32 in hub.attached_devices
        await hub.disconnect()
        second.callbacks[0](sender, frame)
        assert hub.attached_devices == {}

    asyncio.run(run())
    assert hub.hub_address == "aa:bb"
    assert first.disconnects == second.disconnects == 1


def test_connected_hub_is_not_replaced_by_duplicate_connect(monkeypatch):
    client = BleClient()
    install_ble(monkeypatch, [client])
    hub = TechnicMoveHub()

    async def run():
        await hub.connect()
        await hub.connect()
        await hub.disconnect()

    asyncio.run(run())
    assert len(client.callbacks) == 1


@pytest.mark.parametrize(
    "frame",
    [
        [15, 0, 4, 0x32, 1, 0x56, 0],
        [5, 0, 4, 0x32],
        [11, 0, 0x43, 0x32, 1],
        [10, 0, 0x47, 0x32, 2],
        [3, 0, 0x45, 0x32, 1],
        [5, 1, 4, 0x32, 0],
    ],
)
def test_malformed_notifications_cannot_enter_queue_or_mutate_state(frame):
    hub = TechnicMoveHub()
    hub._handle_notification(SimpleNamespace(uuid=CHAR_UUID), bytearray(frame))
    assert hub.drain_notifications() == []
    assert hub.attached_devices == hub.port_infos == hub.input_modes == hub.port_values == {}


def test_detach_invalidates_port_modes_metadata_and_encoder_sample():
    hub = TechnicMoveHub()
    sender = SimpleNamespace(uuid=CHAR_UUID)
    for frame in (
        [11, 0, 0x43, 0x32, 1, 3, 1, 1, 0, 1, 0],
        [10, 0, 0x47, 0x32, 2, 1, 0, 0, 0, 1],
        [8, 0, 0x45, 0x32, 1, 0, 0, 0],
    ):
        hub._handle_notification(sender, bytearray(frame))
    assert hub.port_values
    hub._handle_notification(sender, bytearray([5, 0, 4, 0x32, 0]))
    assert hub.port_infos == hub.input_modes == hub.port_values == {}


def test_all_truncated_notifications_are_safe_and_do_not_pollute_state():
    complete = bytearray([15, 0, 4, 0x32, 1, 0x56, 0, *([0] * 8)])
    for length in range(len(complete)):
        hub = TechnicMoveHub()
        hub._handle_notification(SimpleNamespace(uuid=CHAR_UUID), complete[:length])
        assert not hub.attached_devices
        assert not hub.notifications


def test_command_queued_before_disconnect_cannot_reach_replacement_connection():
    async def run():
        writing, release = asyncio.Event(), asyncio.Event()

        class Client(BleClient):
            def __init__(self, blocked):
                super().__init__()
                self.is_connected = True
                self.blocked = blocked
                self.sent = []

            async def write_gatt_char(self, _uuid, data, response):
                assert response is False
                if self.blocked:
                    writing.set()
                    await release.wait()
                self.sent.append(bytes(data))

        hub = TechnicMoveHub()
        first, second = Client(True), Client(False)
        hub.client = first
        active = asyncio.create_task(hub.send(b"active"))
        await writing.wait()
        queued = asyncio.create_task(hub.send(b"old session"))
        await asyncio.sleep(0)
        await hub.disconnect()
        hub.client = second
        release.set()
        await active
        with pytest.raises(RuntimeError, match="not connected"):
            await queued
        assert second.sent == []
        await hub.send(b"new session")
        assert second.sent == [b"new session"]

    asyncio.run(run())
