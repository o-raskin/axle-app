from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, cast

from bridge import audio, controller, session
from bridge.profiles import GamepadProfile


class SetupRecorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, list[tuple[str, bool]], str]] = []

    def show(self, title: str, message: str, steps: list[tuple[str, bool]], detail: str = "") -> None:
        self.calls.append((title, message, steps, detail))


class FakeSound:
    pass


class FakeMixer:
    def __init__(self) -> None:
        self.init_calls: list[dict[str, Any]] = []
        self.loaded_paths: list[str] = []

    def get_init(self) -> bool:
        return False

    def quit(self) -> None:
        raise AssertionError("quit should not be called when the mixer is not initialized")

    def init(self, **kwargs: Any) -> None:
        self.init_calls.append(kwargs)

    def Sound(self, path: str) -> FakeSound:
        self.loaded_paths.append(path)
        return FakeSound()


class FakePygame:
    def __init__(self) -> None:
        self.mixer = FakeMixer()


class FakePygameEvent:
    def __init__(self) -> None:
        self.pump_count = 0

    def pump(self) -> None:
        self.pump_count += 1


class FakeJoystickDevice:
    def __init__(self, name: str) -> None:
        self.name = name
        self.init_count = 0

    def init(self) -> None:
        self.init_count += 1

    def get_name(self) -> str:
        return self.name


class FakeJoystickModule:
    def __init__(self, counts: list[int], device: FakeJoystickDevice) -> None:
        self.counts = counts
        self.device = device
        self.initialized = False
        self.init_count = 0
        self.quit_count = 0
        self.get_count_calls = 0

    def get_init(self) -> bool:
        return self.initialized

    def init(self) -> None:
        self.initialized = True
        self.init_count += 1

    def quit(self) -> None:
        self.initialized = False
        self.quit_count += 1

    def get_count(self) -> int:
        index = min(self.get_count_calls, len(self.counts) - 1)
        self.get_count_calls += 1
        return self.counts[index]

    def Joystick(self, index: int) -> FakeJoystickDevice:
        assert index == 0
        return self.device


class FakePygameForJoystick:
    def __init__(self, counts: list[int], device_name: str = "DualSense Wireless Controller") -> None:
        self.event = FakePygameEvent()
        self.joystick = FakeJoystickModule(counts, FakeJoystickDevice(device_name))
        self.init_count = 0
        self.quit_count = 0

    def init(self) -> None:
        self.init_count += 1

    def quit(self) -> None:
        self.quit_count += 1


def test_gamepad_profile_matches_controller_names_from_data() -> None:
    pad = GamepadProfile.load("dualsense")

    assert pad.matches_device_name("DualSense Wireless Controller")
    assert pad.matches_device_name("Wireless Controller")
    assert pad.matches_device_name("PS5 Controller")
    assert not pad.matches_device_name("Xbox Wireless Controller")


def test_gamepad_retry_refreshes_joystick_snapshot_after_initial_absence(monkeypatch: Any) -> None:
    fake_pygame = FakePygameForJoystick([0, 1])
    monkeypatch.setitem(sys.modules, "pygame", fake_pygame)
    pad = GamepadProfile.load("dualsense")

    pygame_mod, joystick, issue = controller.try_init_gamepad(pad)
    assert pygame_mod is None
    assert joystick is None
    assert issue == "No gamepad detected"

    pygame_mod, joystick, issue = controller.try_init_gamepad(pad)

    assert pygame_mod is fake_pygame
    assert joystick is fake_pygame.joystick.device
    assert issue is None
    assert fake_pygame.quit_count == 1
    assert fake_pygame.joystick.quit_count == 1
    assert fake_pygame.event.pump_count == 2


def test_missing_port_map_returns_none_and_explains_next_step(monkeypatch: Any, tmp_path: Path) -> None:
    setup = SetupRecorder()
    monkeypatch.setattr(session, "PORT_MAP_PATH", tmp_path / "missing-port-map.json")

    assert session.load_port_map_for_drive(cast(Any, setup)) is None

    assert setup.calls
    assert setup.calls[-1][0] == "Hub scan required"
    assert "probe_hub.py" in setup.calls[-1][3]


def test_coreaudio_helpers_are_noops_off_macos(monkeypatch: Any) -> None:
    monkeypatch.setattr(audio.sys, "platform", "win32")

    assert audio.coreaudio_output_devices() == []
    assert audio.coreaudio_default_output_device() is None
    assert not audio.coreaudio_set_default_output_device(10)


def test_default_reverse_beep_uses_pygame_system_output_off_macos(monkeypatch: Any, tmp_path: Path) -> None:
    sound_path = tmp_path / "beep.mp3"
    sound_path.write_bytes(b"fake")
    pygame = FakePygame()
    monkeypatch.setattr(audio.sys, "platform", "win32")
    monkeypatch.setenv("REVERSE_BEEP_OUTPUT", "default")

    beep = audio.ReverseBeep.open(pygame, sound_path)

    assert isinstance(beep.sound, FakeSound)
    assert pygame.mixer.init_calls == [{}]
    assert pygame.mixer.loaded_paths == [str(sound_path)]
