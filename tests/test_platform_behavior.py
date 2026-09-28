from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, cast

from bridge import audio, bluetooth, controller, session
from bridge.profiles import GamepadProfile, gamepad_profile_candidates


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


class FakePygameEventItem:
    def __init__(self, event_type: int, button: int | None = None, key: int | None = None) -> None:
        self.type = event_type
        self.button = button
        self.key = key
        self.instance_id = 42


class FakePygameEventQueue:
    def __init__(self, events: list[FakePygameEventItem]) -> None:
        self.events = events
        self.pump_count = 0

    def pump(self) -> None:
        self.pump_count += 1

    def get(self) -> list[FakePygameEventItem]:
        events = self.events
        self.events = []
        return events


class FakeJoystickForEvents:
    def get_instance_id(self) -> int:
        return 42

    def get_init(self) -> bool:
        return True


class FakeJoystickModuleForEvents:
    def get_count(self) -> int:
        return 1


class FakePygameForEvents:
    JOYDEVICEREMOVED = 1
    JOYBUTTONDOWN = 2
    KEYDOWN = 3
    K_ESCAPE = 27

    def __init__(self, events: list[FakePygameEventItem]) -> None:
        self.event = FakePygameEventQueue(events)
        self.joystick = FakeJoystickModuleForEvents()


def test_gamepad_profile_matches_controller_names_from_data() -> None:
    pad = GamepadProfile.load("dualsense")

    assert pad.matches_device_name("DualSense Wireless Controller")
    assert pad.matches_device_name("Wireless Controller")
    assert pad.matches_device_name("PS5 Controller")
    assert not pad.matches_device_name("Xbox Wireless Controller")
    assert pad.axis("steer") == 0
    assert pad.axis("throttle_reverse") == 4
    assert pad.axis("throttle_forward") == 5
    assert pad.button("brake") == 9
    assert pad.button("boost") == 10
    assert pad.optional_button("exit") == 6
    assert pad.supports_led


def test_steam_deck_profile_matches_steam_input_names() -> None:
    pad = GamepadProfile.load("steamdeck")

    assert pad.matches_device_name("Steam Deck")
    assert pad.matches_device_name("Steam Virtual Gamepad")
    assert pad.matches_device_name("Xbox 360 Controller")
    assert pad.axis("steer") == 0
    assert pad.axis("throttle_reverse") == 4
    assert pad.axis("throttle_forward") == 5
    assert pad.button("brake") == 9
    assert pad.button("boost") == 10
    assert pad.optional_button("exit") == 6
    assert not pad.supports_led


def test_auto_gamepad_candidates_end_with_generic_sdl_fallback() -> None:
    candidates = gamepad_profile_candidates("auto")

    assert [candidate.name for candidate in candidates] == [
        "Sony DualSense",
        "Steam Deck / SDL Gamepad",
        "Generic SDL/XInput Gamepad",
    ]
    assert candidates[-1].matches_device_name("Unexpected SDL Controller Name")
    assert not candidates[-1].supports_led


def test_generic_sdl_profile_opens_unknown_single_controller(monkeypatch: Any) -> None:
    fake_pygame = FakePygameForJoystick([1], "Valve Software Steam Controller")
    monkeypatch.setitem(sys.modules, "pygame", fake_pygame)
    pad = GamepadProfile.load("generic_sdl")

    pygame_mod, joystick, issue = controller.try_init_gamepad(pad)

    assert pygame_mod is fake_pygame
    assert joystick is fake_pygame.joystick.device
    assert issue is None


def test_start_button_requests_safe_exit() -> None:
    pygame = FakePygameForEvents([FakePygameEventItem(FakePygameForEvents.JOYBUTTONDOWN, button=6)])

    disconnected, exit_requested = controller.poll_controller_events(pygame, FakeJoystickForEvents(), 6)

    assert not disconnected
    assert exit_requested
    assert pygame.event.pump_count == 1


def test_escape_key_requests_safe_exit() -> None:
    pygame = FakePygameForEvents([FakePygameEventItem(FakePygameForEvents.KEYDOWN, key=FakePygameForEvents.K_ESCAPE)])

    disconnected, exit_requested = controller.poll_controller_events(pygame, FakeJoystickForEvents(), None)

    assert not disconnected
    assert exit_requested


def test_linux_bluetooth_status_reads_bluez_power(monkeypatch: Any) -> None:
    def fake_run(_command: list[str]) -> bluetooth.CommandStatus:
        return bluetooth.CommandStatus(0, stdout="Controller AA:BB\n    Powered: yes\n")

    monkeypatch.setattr(bluetooth.sys, "platform", "linux")
    monkeypatch.setattr(bluetooth, "run_status_command", fake_run)

    status = bluetooth.bluetooth_status()

    assert status.ready
    assert "powered on" in status.detail


def test_macos_bluetooth_status_reports_powered_off(monkeypatch: Any) -> None:
    def fake_run(command: list[str]) -> bluetooth.CommandStatus:
        if command[0] == "defaults":
            return bluetooth.CommandStatus(0, stdout="0\n")
        return bluetooth.CommandStatus(1, stderr="should not be called")

    monkeypatch.setattr(bluetooth.sys, "platform", "darwin")
    monkeypatch.setattr(bluetooth, "run_status_command", fake_run)

    status = bluetooth.bluetooth_status()

    assert not status.ready
    assert "powered off" in status.detail


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
    assert "hub scan" in setup.calls[-1][3]


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
