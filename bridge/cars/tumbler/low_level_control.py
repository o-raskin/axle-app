"""PLAYVM: the hub's own control program, and the startup sequence that hands it the motors."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Protocol

from ...port_map import port_id
from ...safety import SafetyLimits, clamp_signed
from ...transport import (
    ATTACHED_IO_VIRTUAL,
    FEEDBACK_IDLE,
    MSG_ATTACHED_IO,
    MSG_INPUT_FORMAT_ACK,
    MSG_MODE_INFO,
    MSG_PORT_INFO,
    MSG_PORT_OUTPUT_FEEDBACK,
    MSG_PORT_VALUE,
)
from ..model_profiles import ModelProfile

# VmCommands: 0=LoadProgram 1=StartLoadedProgram 2=StopLoadedProgram 3=SetGlobalRegisterVariable
# 4=SubscribeToRegisterVariable 5=Unsubscribe 6=SetProgramToAutoStartOnBoot 7=VmProgramCrcCheck
VM_LOAD = 0x00
VM_START = 0x01
VM_DRIVE = 0x03
VM_SUBSCRIBE = 0x04
VM_CRC_CHECK = 0x07

# Status arrives in PLAYVM global variable 1, which we subscribe to with VM_SUBSCRIBE. The hub then
# pushes it; there is nothing to poll. These masks live on the base adapter, common to every model.
STATUS_VARIABLE = 0x01
STATUS_MASKS = {
    0x00100: ("success", False),
    0x00200: ("timeout", True),
    0x00400: ("range too small", True),
    0x00800: ("range too large", True),
    0x10000: ("impact", False),
}
STATUS_SUCCESS = 0x00100


class PlayVmHub(Protocol):
    """Transport contract required by the PLAYVM controller."""

    port_infos: dict[int, Any]

    async def send(self, data: bytes | bytearray) -> None:
        """Send one raw LWP3 message."""

    async def subscribe_port_value(
        self, port_id: int, mode: int, delta_interval: int = 1, notify_enabled: int = 1
    ) -> None:
        """Subscribe to one port value mode."""

    async def request_port_info(self, port_id: int, information_type: int = 0x01) -> None:
        """Request port metadata."""

    async def request_mode_info(self, port_id: int, mode: int, information_type: int) -> None:
        """Request mode metadata."""

    async def wait_for(
        self, what: str, predicate: Callable[[bytes], bool], timeout: float = 3.0
    ) -> tuple[bytes, float]:
        """Wait for a matching raw notification."""

    async def wait_for_message(self, what: str, msg_type: int, port: int, *tail: int) -> tuple[bytes, float]:
        """Wait for one matching LWP3 message."""

    def clear_notifications(self) -> None:
        """Clear any buffered notifications."""

    def drain_notifications(self) -> list[bytes]:
        """Take and clear buffered raw notifications."""


def decode_vm_status(values: list[int]) -> tuple[int, list[str]]:
    """An inbound PLAYVM frame: [0] VmCommands opcode, [1] variable index, [2:6] int32 LE value."""
    if len(values) < 6 or values[0] != VM_DRIVE or values[1] != STATUS_VARIABLE:
        raise RuntimeError(f"Not a status report for variable {STATUS_VARIABLE}: {values}")
    raw = int.from_bytes(bytes(v & 0xFF for v in values[2:6]), "little")
    return raw, [name for bit, (name, _fatal) in STATUS_MASKS.items() if raw & bit]


def decode_vm_status_report(raw: bytes, play_vm_port: int) -> tuple[int, list[str]] | None:
    """Decode a subscribed PLAYVM status notification, or ignore unrelated frames."""
    if len(raw) < 10 or raw[2] != MSG_PORT_VALUE or raw[3] != play_vm_port:
        return None
    if raw[4] != VM_DRIVE or raw[5] != STATUS_VARIABLE:
        return None
    return decode_vm_status(list(raw[4:10]))


class LowLevelControl:
    """Speaks PLAYVM: startup, calibration and drive frames for one model."""

    def __init__(
        self,
        hub: PlayVmHub,
        port_map: dict[str, Any],
        model: ModelProfile,
        limits: SafetyLimits,
    ) -> None:
        """Bind a hub, its ports and the model whose bit meanings apply."""
        self.hub = hub
        self.model = model
        self.limits = limits
        self.play_vm = port_id(port_map, "play_vm")
        self.drive_left = port_id(port_map, "drive_left")
        self.drive_right = port_id(port_map, "drive_right")

    async def send_play_vm_raw(self, *data: int) -> bytes:
        """PLAYVM command: the first data byte is the opcode, the length varies."""
        payload = bytearray([0x00, 0x00, 0x81, self.play_vm, 0x11, 0x51, 0x00, *(b & 0xFF for b in data)])
        payload[0] = len(payload)
        await self.hub.send(payload)
        return bytes(payload)

    async def drive(
        self,
        speed: int = 0,
        steering: int = 0,
        *,
        brake: bool = False,
        boost: bool = False,
        lights: bool = True,
        rocket_lights: bool = False,
        flicker: bool = False,
    ) -> bytes:
        """One drive frame. Callers say what they want; the model decides which bits that is."""
        control = 0
        if brake:
            control |= self.model.bit("brake")
        if boost:
            control |= self.model.bit("boost")
        control2 = 0
        if rocket_lights:
            control2 |= self.model.bit2("attack_lights")
        if flicker:
            control2 |= self.model.bit2("flicker")
        if not lights:
            control2 |= self.model.bit2("lights_off")
        return await self._drive_raw(speed, steering, control, control2)

    async def _drive_raw(self, speed: int, steering: int, control: int, control2: int) -> bytes:
        return await self.send_play_vm_raw(
            VM_DRIVE,
            0x00,
            clamp_signed(speed, self.limits.max_drive_power),
            clamp_signed(steering, self.limits.max_steering_power),
            control & 0xFF,
            control2 & 0xFF,
        )

    def drain_status_reports(self) -> list[tuple[int, list[str]]]:
        """Return subscribed PLAYVM status reports accumulated since the last read."""
        reports: list[tuple[int, list[str]]] = []
        for raw in self.hub.drain_notifications():
            status = decode_vm_status_report(raw, self.play_vm)
            if status is not None:
                reports.append(status)
        return reports

    async def start_play_vm(self) -> tuple[int, int, list[str]]:
        """Link the rears, subscribe to status and calibrate.

        Returns the virtual drive port plus the calibration status word and its flags.
        """
        virtual_port = await self._link_drive_ports()
        self.hub.clear_notifications()
        await self.hub.subscribe_port_value(self.play_vm, 0)
        await self.hub.wait_for(
            "input-format ack",
            lambda r: len(r) >= 5 and r[2] == MSG_INPUT_FORMAT_ACK and r[3] == self.play_vm and r[4] == 0,
        )
        raw, flags = await self._calibrate(virtual_port)
        return virtual_port, raw, flags

    async def _link_drive_ports(self) -> int:
        """VirtualPortSetup: bind both rears into one port, as Control+ does before calibrating."""
        self.hub.clear_notifications()
        await self.hub.send(bytearray([0x06, 0x00, 0x61, 0x01, self.drive_left, self.drive_right]))
        attached, _ = await self.hub.wait_for(
            "AttachedIO for the virtual port",
            lambda r: (
                len(r) >= 9
                and r[2] == MSG_ATTACHED_IO
                and r[4] == ATTACHED_IO_VIRTUAL
                and set(r[7:9]) == {self.drive_left, self.drive_right}
            ),
        )
        return attached[3]

    async def _calibrate(self, virtual_port: int) -> tuple[int, list[str]]:
        """The Control+ startup, decoded from its binary and verified against a BLE capture.

        The pacing is not cosmetic: rush it and the hub reads the calibrate bit as a drive command.
        """
        program = self.model.program_id
        steps = [
            ((VM_CRC_CHECK, program, 0x00), True, 0.0),  # reply carries the program's CRC32
            ((VM_LOAD, program, 0x00), True, 0.0),
            ((VM_START,), True, self.model.pace("after_start")),
            ((VM_SUBSCRIBE, STATUS_VARIABLE), False, self.model.pace("after_subscribe")),
            (self._frame(self.model.bit("good_to_go")), False, self.model.pace("after_good_to_go")),
            (self._frame(self.model.bit("calibrate")), True, self.model.pace("after_calibrate")),
            (self._frame(0x00), False, 0.0),
        ]
        loop = asyncio.get_running_loop()
        status: tuple[int, list[str]] = (0, [])
        for data, expect_echo, pace in steps:
            self.hub.clear_notifications()
            sent_at = loop.time()
            await self.send_play_vm_raw(*data)
            if expect_echo:
                reply = await self._await_echo(data[0])
                if data[0] == VM_DRIVE:  # the calibrating write answers with the status word
                    status = decode_vm_status(list(reply[4:12]))
            else:
                await self._await_feedback(data[0])
            # The app reads the freshly created virtual port right here; that enumeration is what
            # fills the long gaps in the capture, and the VM will not calibrate without it.
            if data[0] == VM_CRC_CHECK:
                await self._read_port_info(virtual_port)
            elif data[0] == VM_LOAD:
                await self._read_mode_info(virtual_port)
            left = pace - (loop.time() - sent_at)
            if left > 0:
                await asyncio.sleep(left)

        raw = status[0]
        broken = [name for bit, (name, fatal) in STATUS_MASKS.items() if fatal and raw & bit]
        if broken:
            raise RuntimeError(f"Steering calibration failed: {', '.join(broken)} (status {raw:#07x})")
        if not raw & STATUS_SUCCESS:
            raise RuntimeError(f"Steering calibration did not report success (status {raw:#07x})")
        return status

    def _frame(self, control: int) -> tuple[int, ...]:
        return (VM_DRIVE, 0x00, 0x00, 0x00, control, 0x00)

    async def _await_echo(self, opcode: int) -> bytes:
        if opcode == VM_DRIVE:
            reply, _ = await self.hub.wait_for(
                f"PLAYVM echo of {opcode:#04x}",
                lambda raw: decode_vm_status_report(raw, self.play_vm) is not None,
            )
        else:
            reply, _ = await self.hub.wait_for_message(
                f"PLAYVM echo of {opcode:#04x}", MSG_PORT_VALUE, self.play_vm, opcode
            )
        return reply

    async def _await_feedback(self, opcode: int) -> None:
        await self.hub.wait_for(
            f"feedback for {opcode:#04x}",
            lambda r: (
                len(r) >= 5 and r[2] == MSG_PORT_OUTPUT_FEEDBACK and r[3] == self.play_vm and bool(r[4] & FEEDBACK_IDLE)
            ),
        )

    async def _read_port_info(self, port: int) -> None:
        self.hub.clear_notifications()
        await self.hub.request_port_info(port)
        await self.hub.wait_for_message(f"PortInfo {port:#04x}", MSG_PORT_INFO, port)

    async def _read_mode_info(self, port: int) -> None:
        info = self.hub.port_infos.get(port)
        if info is None or info.total_mode_count is None:
            raise RuntimeError(f"Port {port:#04x} never reported its mode count")
        for mode in range(info.total_mode_count):
            for info_type in (0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x80):
                self.hub.clear_notifications()
                await self.hub.request_mode_info(port, mode, info_type)
                await self.hub.wait_for_message(
                    f"ModeInfo {port:#04x}.{mode}.{info_type:#04x}", MSG_MODE_INFO, port, mode, info_type
                )
