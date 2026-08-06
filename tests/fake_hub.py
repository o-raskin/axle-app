"""A hub that answers like the real one, so the startup sequence can be tested without hardware."""

from bridge.transport import (
    ATTACHED_IO_VIRTUAL,
    MSG_ATTACHED_IO,
    MSG_INPUT_FORMAT_ACK,
    MSG_MODE_INFO,
    MSG_PORT_INFO,
    MSG_PORT_OUTPUT_FEEDBACK,
    MSG_PORT_VALUE,
    PortInfo,
    TechnicMoveHub,
)

VIRTUAL_PORT = 0x14
PLAY_VM_PORT = 0x36
MODE_COUNT = 5
CALIBRATE_BIT = 0x08


class FakeHub:
    """Replays the answers a Technic Move hub gives during startup and calibration."""

    def __init__(self, status_word: int = 0x100) -> None:
        """Record every message sent, and queue the reply the hub would make."""
        self.sent: list[bytes] = []
        self.queue: list[bytes] = []
        self.port_infos: dict[int, PortInfo] = {}
        self.status_word = status_word

    def clear_notifications(self) -> None:
        self.queue.clear()

    def drain_notifications(self) -> list[bytes]:
        drained, self.queue = list(self.queue), []
        return drained

    async def send(self, data: bytes | bytearray) -> None:
        frame = bytes(data)
        self.sent.append(frame)
        kind = frame[2]
        if kind == 0x61:  # VirtualPortSetup
            self.queue.append(bytes([9, 0, MSG_ATTACHED_IO, VIRTUAL_PORT, ATTACHED_IO_VIRTUAL, 0x56, 0, 0x32, 0x33]))
        elif kind == 0x41:  # PortInputFormatSetup
            self.queue.append(bytes([10, 0, MSG_INPUT_FORMAT_ACK, frame[3], 0, 1, 0, 0, 0, 1]))
        elif kind == 0x21:  # PortInfoRequest
            self.port_infos[frame[3]] = PortInfo(port_id=frame[3], total_mode_count=MODE_COUNT)
            self.queue.append(bytes([11, 0, MSG_PORT_INFO, frame[3], 1, 3, MODE_COUNT, 15, 0, 31, 0]))
        elif kind == 0x22:  # PortModeInfoRequest
            self.queue.append(bytes([10, 0, MSG_MODE_INFO, frame[3], frame[4], frame[5], 0, 0, 0, 0]))
        elif kind == 0x81:  # PortOutput -> feedback, and an echo for the commands that answer
            opcode = frame[7]
            self.queue.append(bytes([5, 0, MSG_PORT_OUTPUT_FEEDBACK, frame[3], 0x0A]))
            if opcode in (0x07, 0x00, 0x01):
                self.queue.append(bytes([12, 0, MSG_PORT_VALUE, PLAY_VM_PORT, opcode, 1, 0, 0, 0, 0, 0, 0]))
            elif opcode == 0x03 and frame[11] == CALIBRATE_BIT:
                status = self.status_word.to_bytes(4, "little")
                self.queue.append(bytes([12, 0, MSG_PORT_VALUE, PLAY_VM_PORT, 0x03, 0x01, *status, 0, 0]))

    async def subscribe_port_value(
        self, port_id: int, mode: int, delta_interval: int = 1, notify_enabled: int = 1
    ) -> None:
        await self.send(bytes([10, 0, 0x41, port_id, mode, delta_interval, 0, 0, 0, notify_enabled]))

    async def request_port_info(self, port_id: int, information_type: int = 0x01) -> None:
        await self.send(bytes([5, 0, 0x21, port_id, information_type]))

    async def request_mode_info(self, port_id: int, mode: int, information_type: int) -> None:
        await self.send(bytes([6, 0, 0x22, port_id, mode, information_type]))

    async def wait_for(self, what, predicate, timeout: float = 3.0):  # type: ignore[no-untyped-def]
        return await TechnicMoveHub.wait_for(self, what, predicate, timeout)  # type: ignore[arg-type]

    async def wait_for_message(self, what: str, msg_type: int, port: int, *tail: int):  # type: ignore[no-untyped-def]
        return await TechnicMoveHub.wait_for_message(self, what, msg_type, port, *tail)  # type: ignore[arg-type]

    def play_vm_frames(self) -> list[bytes]:
        """Just the PLAYVM messages, in order."""
        return [frame for frame in self.sent if frame[2] == 0x81 and frame[3] == PLAY_VM_PORT]
