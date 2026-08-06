"""Tests for the parts where a wrong byte moves the car and nothing complains."""

import asyncio
from pathlib import Path

import pytest

from bridge.low_level_control import LowLevelControl, decode_vm_status
from bridge.port_map import load_port_map, port_id, save_port_map
from bridge.profiles import GamepadProfile, ModelProfile
from bridge.safety import SafetyLimits
from tests.fake_hub import CALIBRATE_BIT, VIRTUAL_PORT, FakeHub

PORT_MAP = {
    "hub": {"name": "Technic Move", "address": None},
    "roles": {"drive_left": "0x32", "drive_right": "0x33", "steering": "0x34", "lights": "0x35", "play_vm": "0x36"},
}


@pytest.fixture
def model() -> ModelProfile:
    return ModelProfile.load("tumbler")


@pytest.fixture
def control(model: ModelProfile) -> tuple[LowLevelControl, FakeHub]:
    hub = FakeHub()
    return LowLevelControl(hub, PORT_MAP, model, SafetyLimits(100, 100)), hub


# --- status decoding: this was off by one byte, and "success" read as "impact" ---


def test_status_is_read_from_byte_two() -> None:
    raw, flags = decode_vm_status([3, 1, 0, 1, 0, 0, 0, 0])
    assert raw == 0x100
    assert flags == ["success"]


@pytest.mark.parametrize(("word", "flag"), [(0x200, "timeout"), (0x400, "range too small"), (0x800, "range too large")])
def test_failure_words_decode(word: int, flag: str) -> None:
    raw, flags = decode_vm_status([3, 1, *word.to_bytes(4, "little")])
    assert raw == word
    assert flags == [flag]


def test_a_frame_for_another_variable_is_rejected() -> None:
    with pytest.raises(RuntimeError, match="Not a status report"):
        decode_vm_status([3, 9, 0, 1, 0, 0, 0, 0])


# --- the bit that cost us an evening ---


def test_boost_bit_is_never_set_during_startup(control: tuple[LowLevelControl, FakeHub], model: ModelProfile) -> None:
    ctl, hub = control
    asyncio.run(ctl.start_play_vm())
    boost = model.bit("boost")
    assert not any(len(f) > 11 and f[11] & boost for f in hub.play_vm_frames())


def test_idle_frame_is_all_zero(control: tuple[LowLevelControl, FakeHub]) -> None:
    ctl, hub = control
    asyncio.run(ctl.drive(0, 0))
    assert hub.sent[-1] == bytes.fromhex("0d 00 81 36 11 51 00 03 00 00 00 00 00".replace(" ", ""))


def test_lights_off_goes_in_the_second_control_byte(control: tuple[LowLevelControl, FakeHub]) -> None:
    ctl, hub = control
    asyncio.run(ctl.drive(0, 0, lights=False))
    frame = hub.sent[-1]
    assert frame[11] == 0x00, "lights must not touch the control byte"
    assert frame[12] == 0x01


def test_brake_and_boost_are_separate_bits(control: tuple[LowLevelControl, FakeHub]) -> None:
    ctl, hub = control
    asyncio.run(ctl.drive(50, -20, brake=True))
    assert hub.sent[-1][11] == 0x01
    asyncio.run(ctl.drive(50, -20, boost=True))
    assert hub.sent[-1][11] == 0x04


# --- the startup sequence itself ---


def test_startup_sends_the_captured_sequence(control: tuple[LowLevelControl, FakeHub]) -> None:
    ctl, hub = control
    virtual_port, status, flags = asyncio.run(ctl.start_play_vm())
    assert virtual_port == VIRTUAL_PORT
    assert status == 0x100
    assert flags == ["success"]
    opcodes = [f[7] for f in hub.play_vm_frames()]
    assert opcodes == [0x07, 0x00, 0x01, 0x04, 0x03, 0x03, 0x03]
    controls = [f[11] for f in hub.play_vm_frames() if f[7] == 0x03]
    assert controls == [0x10, CALIBRATE_BIT, 0x00]


def test_startup_reads_the_virtual_port_between_commands(control: tuple[LowLevelControl, FakeHub]) -> None:
    ctl, hub = control
    asyncio.run(ctl.start_play_vm())
    mode_reads = [f for f in hub.sent if f[2] == 0x22 and f[3] == VIRTUAL_PORT]
    assert len(mode_reads) == 35, "the VM will not calibrate without this enumeration"


def test_failed_calibration_aborts() -> None:
    hub = FakeHub(status_word=0x200)  # timeout
    ctl = LowLevelControl(hub, PORT_MAP, ModelProfile.load("tumbler"), SafetyLimits(100, 100))
    with pytest.raises(RuntimeError, match="timeout"):
        asyncio.run(ctl.start_play_vm())


# --- profiles ---


def test_model_bits_match_the_decoded_binary(model: ModelProfile) -> None:
    assert model.bit("brake") == 0x01
    assert model.bit("boost") == 0x04
    assert model.bit("calibrate") == 0x08
    assert model.bit("good_to_go") == 0x10
    assert model.bit2("lights_off") == 0x01


def test_missing_keys_name_the_alternatives(model: ModelProfile) -> None:
    with pytest.raises(RuntimeError, match="has no control bit 'turbo'"):
        model.bit("turbo")
    with pytest.raises(RuntimeError, match="No models profile"):
        ModelProfile.load("batmobile")
    pad = GamepadProfile.load("dualsense")
    with pytest.raises(RuntimeError, match="has no button 'handbrake'"):
        pad.button("handbrake")


def test_port_lookup_names_what_the_hub_has() -> None:
    assert port_id(PORT_MAP, "play_vm") == 0x36
    with pytest.raises(RuntimeError, match="has no 'winch' port"):
        port_id(PORT_MAP, "winch")


def test_port_map_round_trips(tmp_path: Path) -> None:
    # The real port_map.json is a generated artefact and gitignored, so exercise the writer.
    path = tmp_path / "port_map.json"
    save_port_map(path, PORT_MAP)
    loaded = load_port_map(path)
    assert set(loaded) == {"hub", "roles"}
    assert port_id(loaded, "play_vm") == 0x36
