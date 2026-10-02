"""PLAYVM startup matches only the intended ports and status register."""

from __future__ import annotations

import asyncio

import pytest

from bridge.cars.model_profiles import ModelProfile
from bridge.cars.tumbler.low_level_control import LowLevelControl, decode_vm_status_report
from bridge.safety import SafetyLimits
from tests.fake_hub import CALIBRATE_BIT, PLAY_VM_PORT, VIRTUAL_PORT, FakeHub

PORT_MAP = {"roles": {"play_vm": "0x36", "drive_left": "0x32", "drive_right": "0x33"}}


class NoisyStartupHub(FakeHub):
    async def send(self, data: bytes | bytearray) -> None:
        await super().send(data)
        if data[2] == 0x61:
            self.queue[:0] = [
                bytes([3, 0, 0x04]),
                bytes([9, 0, 0x04, 0x15, 2, 0x56, 0, 0x30, 0x31]),
            ]
        elif data[2] == 0x41:
            self.queue.insert(0, bytes([10, 0, 0x47, PLAY_VM_PORT, 1, 1, 0, 0, 0, 1]))
        elif data[2] == 0x81:
            self.queue.insert(0, bytes([3, 0, 0x82]))
            if data[7] == 3 and data[11] == CALIBRATE_BIT:
                self.queue.insert(0, bytes([10, 0, 0x45, PLAY_VM_PORT, 3, 0, 0, 1, 0, 0]))
                self.queue.insert(0, bytes([6, 0, 0x45, PLAY_VM_PORT, 3, 1]))


def test_startup_ignores_unrelated_virtual_ports_and_drive_register_notifications() -> None:
    hub = NoisyStartupHub()
    model = ModelProfile.load("tumbler")
    # This fake responds synchronously, so the capture's deliberate pacing can
    # be zero here without turning the test into a wall-clock timing test.
    model._pace = dict.fromkeys(model._pace, 0.0)
    control = LowLevelControl(hub, PORT_MAP, model, SafetyLimits(100, 100))
    assert asyncio.run(control.start_play_vm()) == (VIRTUAL_PORT, 0x100, ["success"])
    assert {frame[3] for frame in hub.sent if frame[2] in {0x21, 0x22}} == {VIRTUAL_PORT}


@pytest.mark.parametrize(
    "word, message",
    [(0, "did not report success"), (0x10000, "did not report success"), (0x500, "range too small")],
)
def test_calibration_requires_success_and_rejects_fatal_bits_even_with_success(word: int, message: str) -> None:
    hub = FakeHub(status_word=word)
    model = ModelProfile.load("tumbler")
    model._pace = dict.fromkeys(model._pace, 0.0)
    control = LowLevelControl(hub, PORT_MAP, model, SafetyLimits(100, 100))
    with pytest.raises(RuntimeError, match=message):
        asyncio.run(control.start_play_vm())
    assert hub.play_vm_frames()[-1][9:] == bytes(4), "Finish with neutral output before surfacing failure"


@pytest.mark.parametrize(
    "raw",
    [
        bytes(),
        bytes([3, 0, 0x45]),
        bytes([10, 0, 0x45, 0x35, 3, 1, 0, 1, 0, 0]),
        bytes([10, 0, 0x45, 0x36, 3, 0, 0, 1, 0, 0]),
    ],
)
def test_incomplete_or_unrelated_status_reports_do_not_enter_crash_state(raw: bytes) -> None:
    assert decode_vm_status_report(raw, PLAY_VM_PORT) is None


def test_future_status_bits_preserve_known_success_and_impact_flags() -> None:
    word = 0x8010100
    raw = bytes([10, 0, 0x45, PLAY_VM_PORT, 3, 1, *word.to_bytes(4, "little")])
    assert decode_vm_status_report(raw, PLAY_VM_PORT) == (word, ["success", "impact"])
