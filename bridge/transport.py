from __future__ import annotations

import asyncio
import struct
import sys
import time
from collections import deque
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Callable

from .platforms.current import configure_process_for_platform

configure_process_for_platform()

from bleak import BleakClient, BleakScanner  # noqa: E402

CHAR_UUID = "00001624-1212-efde-1623-785feabcd123"


def hub_advertisement_matches(name: str, address: str | None, device: Any, advertisement: Any) -> bool:
    """Match a hub using the stable address or either BLE name representation."""
    if address:
        device_address = getattr(device, "address", "")
        return bool(isinstance(device_address, str) and device_address.lower() == address.lower())
    local_name = getattr(advertisement, "local_name", None)
    device_name = getattr(device, "name", None)
    return any(isinstance(candidate, str) and name in candidate for candidate in (local_name, device_name))


async def find_advertised_hub(name: str, address: str | None, timeout: float = 3.0) -> Any:
    """Find a BLE advertisement without opening a connection or writing to the hub."""
    return await BleakScanner.find_device_by_filter(
        lambda device, advertisement: hub_advertisement_matches(name, address, device, advertisement),
        timeout=timeout,
    )


# LWP3 message types we care about (byte 2 of every message).
MSG_ATTACHED_IO = 0x04
MSG_PORT_INFO = 0x43
MSG_MODE_INFO = 0x44
MSG_PORT_VALUE = 0x45
MSG_INPUT_FORMAT_ACK = 0x47
MSG_PORT_OUTPUT_FEEDBACK = 0x82
ATTACHED_IO_VIRTUAL = 0x02  # AttachedIO event byte meaning "virtual port created"
FEEDBACK_IDLE = 0x08  # PortOutputFeedback bit meaning "command completed"
DEFAULT_HUB_NAME = "Technic Move"

SCAN_TIMEOUT_S = 8.0
POLL_INTERVAL_S = 0.01
NOTIFICATION_BUFFER = 256
MODE_BITS = 16

IO_DRIVE_MOTOR = 0x0056
IO_STEERING_MOTOR = 0x0057
IO_LIGHTS = 0x0058
IO_PLAY_VM = 0x0059

IO_TYPE_NAMES = {
    0x0001: "Motor",
    0x0008: "LED Light",
    0x0014: "Voltage",
    0x0017: "RGB Light",
    0x0026: "External Motor with Tacho",
    0x0027: "Internal Motor with Tacho",
    0x0039: "Hub Gravity Sensor",
    0x003A: "Hub Rotation Sensor",
    0x003B: "Hub Position Sensor",
    0x003C: "Hub Temperature Sensor",
    IO_DRIVE_MOTOR: "Built-in Drive Motor",
    IO_STEERING_MOTOR: "Built-in Steering Motor",
    IO_LIGHTS: "Built-in Lights (6)",
    IO_PLAY_VM: "Built-in Play VM",
    0x005C: "Hub Activity Stats",
    0x005D: "Hub Orientation Sensor",
    0x005E: "Hub Gesture Bitmap",
    0x005F: "Hub Generated Gesture",
}


def mask_to_modes(mask: int | None) -> list[int]:
    """Mode indices set in an LWP3 16-bit mode mask."""
    if mask is None:
        return []
    return [index for index in range(MODE_BITS) if mask & (1 << index)]


@dataclass
class AttachedDevice:
    """A device the hub reported on one of its ports."""

    port_id: int
    event: int
    io_type_id: int
    io_type_name: str
    virtual_ports: tuple[int, int] | None = None


@dataclass
class ModeInfo:
    """One mode of a port: its name, unit and value layout."""

    name: str | None = None
    symbol: str | None = None
    value_format: tuple[int, int, int, int] | None = None
    mapping: int | None = None
    raw_range: tuple[float, float] | None = None
    si_range: tuple[float, float] | None = None


@dataclass
class PortInfo:
    """What a port can do — capabilities, mode count, per-mode details."""

    port_id: int
    capabilities: int | None = None
    total_mode_count: int | None = None
    input_modes: int | None = None
    output_modes: int | None = None
    mode_infos: dict[int, ModeInfo] = field(default_factory=dict)


class TechnicMoveHub:
    """BLE link to the hub: connect, send LWP3 messages, collect what comes back."""

    def __init__(self, hub_name: str = DEFAULT_HUB_NAME, hub_address: str | None = None) -> None:
        """Prepare a hub handle; nothing is contacted until connect()."""
        self.hub_name = hub_name
        self.hub_address = hub_address.lower() if hub_address else None
        self.client: BleakClient | None = None
        self.attached_devices: dict[int, AttachedDevice] = {}
        self.port_infos: dict[int, PortInfo] = {}
        self.notifications: deque[bytes] = deque(maxlen=NOTIFICATION_BUFFER)
        self.input_modes: dict[int, int] = {}
        self.port_values: dict[int, tuple[int, bytes, float]] = {}
        # PLAYVM commands and optional encoder polling share one GATT
        # characteristic. Bleak does not guarantee ordering for concurrent
        # write-without-response calls, so serialize every downstream frame.
        self._write_lock: asyncio.Lock | None = None

    async def connect(self) -> None:
        """Scan, connect, pair and arm every notifying characteristic."""
        if self.is_connected:
            return
        if self.client is not None:
            await self.disconnect()
        self._clear_connection_state()
        # discover() collects for the whole timeout; this returns on the first matching advert.
        target = await BleakScanner.find_device_by_filter(
            lambda device, advertisement: hub_advertisement_matches(
                self.hub_name, self.hub_address, device, advertisement
            ),
            timeout=SCAN_TIMEOUT_S,
        )
        if target is None:
            raise RuntimeError("Technic Move hub not found")

        client = BleakClient(target)
        self.client = client
        try:
            await client.connect()
            if not client.is_connected:
                raise RuntimeError("Failed to connect to hub")
            self.hub_address = target.address.lower()
            try:
                await client.pair(protection_level=2)
            except Exception:
                # Pairing is optional on platforms which do not expose it.
                pass

            await self._request_fast_connection()

            def notification(sender: Any, data: bytearray) -> None:
                # Old callbacks can arrive after a disconnect or replacement.
                if self.client is client:
                    self._handle_notification(sender, data)

            # Control+ subscribes to all notifying characteristics before writing.
            for service in client.services:
                for char in service.characteristics:
                    if "notify" in char.properties:
                        await client.start_notify(char, notification)
        except BaseException:
            with suppress(Exception):
                await self.disconnect()
            raise

    async def _request_fast_connection(self) -> None:
        """Ask Windows for a fast connection interval.

        Control+ runs this link at 8.75 ms; Windows defaults far slower and ignores the hub's
        own request. ThroughputOptimized asks for 7.5-15 ms.
        """
        if sys.platform != "win32":
            return
        try:
            from winrt.windows.devices.bluetooth import (  # noqa: PLC0415
                BluetoothLEPreferredConnectionParameters as Params,
            )

            # Reaching into bleak internals; keep it Any so the type check does not depend on
            # whether bleak's own types are installed in whatever environment mypy runs in.
            client: Any = self.client
            device = client._backend._requester
            self._conn_request = device.request_preferred_connection_parameters(Params.throughput_optimized)
        except Exception as exc:
            print(f"Could not request a fast connection interval: {type(exc).__name__}: {exc}")

    @property
    def is_connected(self) -> bool:
        """Whether the BLE link is up."""
        return bool(self.client and self.client.is_connected)

    async def disconnect(self) -> None:
        """Release the BLE client and invalidate all state from that connection."""
        client, self.client = self.client, None
        self._clear_connection_state()
        if client is not None:
            await client.disconnect()

    def _clear_connection_state(self) -> None:
        self.attached_devices.clear()
        self.port_infos.clear()
        self.notifications.clear()
        self.input_modes.clear()
        self.port_values.clear()

    async def wait_for_topology(self, seconds: float = 2.0) -> None:
        """Give the hub time to announce its ports."""
        await asyncio.sleep(seconds)

    async def wait_for(
        self, what: str, predicate: Callable[[bytes], bool], timeout: float = 3.0
    ) -> tuple[bytes, float]:
        """Block until a matching message arrives. Raises on timeout, listing what did arrive."""
        loop = asyncio.get_running_loop()
        started = loop.time()
        seen: list[bytes] = []
        while loop.time() - started < timeout:
            for raw in self.drain_notifications():
                seen.append(raw)
                if len(raw) >= 4 and predicate(raw):
                    return raw, loop.time() - started
            await asyncio.sleep(POLL_INTERVAL_S)
        heard = "; ".join(raw.hex(" ") for raw in seen) or "silence"
        raise RuntimeError(f"Hub never sent {what} within {timeout}s. Heard: {heard}")

    async def wait_for_message(self, what: str, msg_type: int, port: int, *tail: int) -> tuple[bytes, float]:
        """Wait for one message by type, port and however many following bytes matter."""

        def matches(raw: bytes) -> bool:
            if raw[2] != msg_type or raw[3] != port or len(raw) < 4 + len(tail):
                return False
            return all(raw[4 + offset] == value for offset, value in enumerate(tail))

        return await self.wait_for(what, matches)

    async def send(self, data: bytes | bytearray) -> None:
        """Write one LWP3 message, without response, as the app does."""
        client = self.client
        # Python 3.9 binds locks at creation; initialize on the running loop.
        if self._write_lock is None:
            self._write_lock = asyncio.Lock()
        async with self._write_lock:
            if client is None or client is not self.client or not client.is_connected:
                raise RuntimeError("Hub is not connected")
            # Control+ sends every message write-without-response; bleak would otherwise pick
            # write-with-response and each command would wait on its own ATT transaction.
            await client.write_gatt_char(CHAR_UUID, data, response=False)

    async def request_port_info(self, port_id: int, information_type: int = 0x01) -> None:
        """Ask a port to describe itself."""
        await self.send(bytearray([0x05, 0x00, 0x21, port_id & 0xFF, information_type & 0xFF]))

    async def request_mode_info(self, port_id: int, mode: int, information_type: int) -> None:
        """Ask a port about one of its modes."""
        await self.send(bytearray([0x06, 0x00, 0x22, port_id & 0xFF, mode & 0xFF, information_type & 0xFF]))

    async def inspect_ports(self) -> None:
        """Walk every attached port and read all of its mode metadata."""
        await self.wait_for_topology()
        for port_id in sorted(self.attached_devices):
            await self.request_port_info(port_id, 0x01)
            await asyncio.sleep(0.05)

        await asyncio.sleep(0.3)

        for port_id, port_info in sorted(self.port_infos.items()):
            for mode in self._iter_known_modes(port_info):
                for info_type in (0x00, 0x04, 0x05, 0x80):
                    await self.request_mode_info(port_id, mode, info_type)
                    await asyncio.sleep(0.05)

        await asyncio.sleep(0.5)

    async def subscribe_port_value(
        self, port_id: int, mode: int, delta_interval: int = 1, notify_enabled: int = 1
    ) -> None:
        """Ask the hub to push updates for one port mode."""
        delta = int(delta_interval).to_bytes(4, byteorder="little", signed=False)
        payload = bytearray([0x0A, 0x00, 0x41, port_id & 0xFF, mode & 0xFF, *delta, notify_enabled & 0xFF])
        await self.send(payload)

    def clear_notifications(self) -> None:
        """Drop buffered messages so the next wait sees only fresh ones."""
        self.notifications.clear()

    def drain_notifications(self) -> list[bytes]:
        """Take and clear the buffered raw messages."""
        items = list(self.notifications)
        self.notifications.clear()
        return items

    def _handle_notification(self, sender: Any, data: bytearray) -> None:
        # Other characteristics are armed only to mirror Control+; their frames are not LWP3.
        if getattr(sender, "uuid", CHAR_UUID).lower() != CHAR_UUID:
            return
        if len(data) < 3:
            return

        # This characteristic sends one short LWP3 frame per notification.
        # Reject incomplete frames before they can satisfy a startup wait.
        if data[0] != len(data) or data[1] != 0:
            return

        message_type = data[2]
        minimum = {
            MSG_ATTACHED_IO: 5,
            MSG_PORT_INFO: 11,
            MSG_MODE_INFO: 6,
            MSG_PORT_VALUE: 5,
            MSG_INPUT_FORMAT_ACK: 10,
            MSG_PORT_OUTPUT_FEEDBACK: 5,
        }
        if len(data) < minimum.get(message_type, 3):
            return
        if message_type == MSG_ATTACHED_IO:
            event = data[4]
            if event not in (0, 1, 2) or len(data) < {0: 5, 1: 15, 2: 9}[event]:
                return
        self.notifications.append(bytes(data))
        if message_type == MSG_ATTACHED_IO:
            self._parse_attached_io(data)
        elif message_type == MSG_PORT_INFO:
            self._parse_port_info(data)
        elif message_type == MSG_MODE_INFO:
            self._parse_mode_info(data)
        elif message_type == MSG_INPUT_FORMAT_ACK and len(data) >= 10:
            self.input_modes[data[3]] = data[4]
            self.port_values.pop(data[3], None)
        elif message_type == MSG_PORT_VALUE and len(data) >= 5:
            mode = self.input_modes.get(data[3])
            if mode is not None:
                self.port_values[data[3]] = (mode, bytes(data[4:]), time.monotonic())

    def _parse_attached_io(self, data: bytearray) -> None:
        if len(data) < 5:
            return

        port_id = data[3]
        event = data[4]
        if event == 0x00:
            self.attached_devices.pop(port_id, None)
            self.port_infos.pop(port_id, None)
            self.input_modes.pop(port_id, None)
            self.port_values.pop(port_id, None)
            return

        if event == 0x01 and len(data) >= 15:
            io_type_id = data[5] | (data[6] << 8)
            self.attached_devices[port_id] = AttachedDevice(
                port_id=port_id,
                event=event,
                io_type_id=io_type_id,
                io_type_name=IO_TYPE_NAMES.get(io_type_id, f"Unknown IO 0x{io_type_id:04X}"),
            )
            return

        if event == 0x02 and len(data) >= 9:
            io_type_id = data[5] | (data[6] << 8)
            self.attached_devices[port_id] = AttachedDevice(
                port_id=port_id,
                event=event,
                io_type_id=io_type_id,
                io_type_name=IO_TYPE_NAMES.get(io_type_id, f"Unknown IO 0x{io_type_id:04X}"),
                virtual_ports=(data[7], data[8]),
            )

    def _parse_port_info(self, data: bytearray) -> None:
        if len(data) < 11:
            return

        port_id = data[3]
        if data[4] != 0x01:
            return

        previous = self.port_infos.get(port_id)
        self.port_infos[port_id] = PortInfo(
            port_id=port_id,
            capabilities=data[5],
            total_mode_count=data[6],
            input_modes=data[7] | (data[8] << 8),
            output_modes=data[9] | (data[10] << 8),
            mode_infos=previous.mode_infos if previous else {},
        )

    def _parse_mode_info(self, data: bytearray) -> None:
        if len(data) < 6:
            return

        port_id = data[3]
        mode = data[4]
        info_type = data[5]
        port_info = self.port_infos.setdefault(port_id, PortInfo(port_id))
        mode_info = port_info.mode_infos.setdefault(mode, ModeInfo())

        if info_type == 0x00:
            mode_info.name = bytes(data[6:]).decode("ascii", errors="ignore").strip("\x00 ")
        elif info_type in (0x01, 0x03) and len(data) >= 14:
            limits = struct.unpack("<ff", bytes(data[6:14]))
            if info_type == 0x01:
                mode_info.raw_range = limits
            else:
                mode_info.si_range = limits
        elif info_type == 0x04:
            mode_info.symbol = bytes(data[6:]).decode("ascii", errors="ignore").strip("\x00 ")
        elif info_type == 0x05 and len(data) >= 8:
            mode_info.mapping = data[6] | (data[7] << 8)
        elif info_type == 0x80 and len(data) >= 10:
            mode_info.value_format = (data[6], data[7], data[8], data[9])

    def _iter_known_modes(self, port_info: PortInfo) -> list[int]:
        return sorted(set(mask_to_modes(port_info.input_modes)) | set(mask_to_modes(port_info.output_modes)))
