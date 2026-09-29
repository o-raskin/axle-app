from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, cast

from bridge import audio, session
from bridge.cars.model_profiles import available_model_choices
from bridge.gamepads import input as gamepad_input
from bridge.gamepads.profile_loader import GamepadProfile, gamepad_profile_candidates
from bridge.platforms import current as platform_current
from bridge.platforms import linux, macos, steamdeck_platform
from bridge.platforms.common import CommandStatus


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


class FakeSdlControllerBackingJoystick:
    def get_instance_id(self) -> int:
        return 77

    def get_guid(self) -> str:
        return "03000000de280000ff11000000007701"

    def get_power_level(self) -> str:
        return "wired"


class FakeSdlControllerHandle:
    def __init__(self) -> None:
        self.axes = {4: 0, 5: 32767}
        self.buttons = {10: True}
        self.rumbles: list[tuple[float, float, int]] = []

    def as_joystick(self) -> FakeSdlControllerBackingJoystick:
        return FakeSdlControllerBackingJoystick()

    def get_axis(self, index: int) -> int:
        return self.axes.get(index, 0)

    def get_button(self, index: int) -> bool:
        return self.buttons.get(index, False)

    def attached(self) -> bool:
        return True

    def get_init(self) -> bool:
        return True

    def rumble(self, low_frequency: float, high_frequency: float, duration_ms: int) -> bool:
        self.rumbles.append((low_frequency, high_frequency, duration_ms))
        return True

    def stop_rumble(self) -> bool:
        return True


class FakeSdlControllerModule:
    def __init__(self, name: str = "Steam Virtual Gamepad") -> None:
        self.name = name
        self.handle = FakeSdlControllerHandle()
        self.init_count = 0
        self.quit_count = 0
        self.opened_indices: list[int] = []

    def get_init(self) -> bool:
        return self.init_count > self.quit_count

    def init(self) -> None:
        self.init_count += 1

    def quit(self) -> None:
        self.quit_count += 1

    def get_count(self) -> int:
        return 1

    def name_forindex(self, index: int) -> str:
        assert index == 0
        return self.name

    def is_controller(self, index: int) -> bool:
        assert index == 0
        return True

    def Controller(self, index: int) -> FakeSdlControllerHandle:
        assert index == 0
        self.opened_indices.append(index)
        return self.handle


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


class FakePygameHandle:
    def __init__(self) -> None:
        self.quit_count = 0

    def quit(self) -> None:
        self.quit_count += 1


class FakeNamedJoystick:
    def __init__(self, name: str = "DualSense Wireless Controller") -> None:
        self.name = name

    def get_name(self) -> str:
        return self.name


class FakeDriveHub:
    events: list[str] = []
    instances: list["FakeDriveHub"] = []

    def __init__(self, hub_name: str = "Technic Move", hub_address: str | None = None) -> None:
        self.hub_name = hub_name
        self.hub_address = hub_address
        self.disconnect_count = 0
        FakeDriveHub.instances.append(self)

    async def connect(self) -> None:
        FakeDriveHub.events.append("hub-connect-start")
        await asyncio.sleep(0.02)
        FakeDriveHub.events.append("hub-connect-done")

    async def wait_for_topology(self) -> None:
        FakeDriveHub.events.append("hub-topology")

    async def disconnect(self) -> None:
        self.disconnect_count += 1
        FakeDriveHub.events.append("hub-disconnect")


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
    assert pad.button("confirm") == 0
    assert pad.optional_button("exit") == 6
    assert pad.supports_led


def test_platform_config_sets_steam_deck_sdl_hints(monkeypatch: Any) -> None:
    for name in steamdeck_platform.SDL_HINTS:
        monkeypatch.delenv(name, raising=False)

    platform_current.configure_process_for_platform()

    for name, value in steamdeck_platform.SDL_HINTS.items():
        assert os.environ[name] == value


def test_platform_config_preserves_explicit_sdl_hints(monkeypatch: Any) -> None:
    monkeypatch.setenv("SDL_JOYSTICK_HIDAPI_STEAMDECK", "0")

    platform_current.configure_process_for_platform()

    assert os.environ["SDL_JOYSTICK_HIDAPI_STEAMDECK"] == "0"


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
    assert pad.button("confirm") == 0
    assert pad.optional_button("exit") == 6
    assert not pad.supports_led


def test_model_profiles_are_listed_for_startup_selection() -> None:
    choices = available_model_choices()

    assert ("tumbler", "42239 Batmobile Tumbler") in [(choice.profile_id, choice.name) for choice in choices]


def test_model_selection_actions_wrap_and_confirm() -> None:
    assert session.apply_model_selection_action(0, 3, "up") == (2, False, False)
    assert session.apply_model_selection_action(2, 3, "down") == (0, False, False)
    assert session.apply_model_selection_action(1, 3, "confirm") == (1, True, False)
    assert session.apply_model_selection_action(1, 3, "cancel") == (1, False, True)


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

    pygame_mod, joystick, issue = gamepad_input.try_init_gamepad(pad)

    assert pygame_mod is fake_pygame
    assert joystick is fake_pygame.joystick.device
    assert issue is None


def test_steam_deck_opens_sdl_game_controller_when_raw_joystick_count_is_zero(monkeypatch: Any) -> None:
    fake_pygame = FakePygameForJoystick([0], "unused")
    fake_sdl_controller = FakeSdlControllerModule()
    monkeypatch.setitem(sys.modules, "pygame", fake_pygame)
    monkeypatch.setattr(gamepad_input, "sdl2_controller_module", lambda _pygame_mod: fake_sdl_controller)
    pad = GamepadProfile.load("steamdeck")

    pygame_mod, joystick, issue = gamepad_input.try_init_gamepad(pad)

    assert pygame_mod is fake_pygame
    assert issue is None
    assert joystick is not None
    assert joystick.get_name() == "Steam Virtual Gamepad"
    assert joystick.get_numaxes() == 6
    assert joystick.get_numbuttons() >= pad.button("speed_down") + 1
    assert joystick.get_axis(pad.axis("throttle_reverse")) == -1.0
    assert joystick.get_axis(pad.axis("throttle_forward")) == 1.0
    assert joystick.get_button(pad.button("boost")) == 1
    assert joystick.get_instance_id() == 77
    assert fake_sdl_controller.opened_indices == [0]


def test_start_button_requests_safe_exit() -> None:
    pygame = FakePygameForEvents([FakePygameEventItem(FakePygameForEvents.JOYBUTTONDOWN, button=6)])

    disconnected, exit_requested = gamepad_input.poll_controller_events(pygame, FakeJoystickForEvents(), 6)

    assert not disconnected
    assert exit_requested
    assert pygame.event.pump_count == 1


def test_escape_key_requests_safe_exit() -> None:
    pygame = FakePygameForEvents([FakePygameEventItem(FakePygameForEvents.KEYDOWN, key=FakePygameForEvents.K_ESCAPE)])

    disconnected, exit_requested = gamepad_input.poll_controller_events(pygame, FakeJoystickForEvents(), None)

    assert not disconnected
    assert exit_requested


def test_linux_bluetooth_status_reads_bluez_power(monkeypatch: Any) -> None:
    def fake_run(_command: list[str]) -> CommandStatus:
        return CommandStatus(0, stdout="Controller AA:BB\n    Powered: yes\n")

    monkeypatch.setattr(linux, "run_status_command", fake_run)

    status = linux.bluetooth_status()

    assert status.ready
    assert "powered on" in status.detail


def test_macos_bluetooth_status_reports_powered_off(monkeypatch: Any) -> None:
    def fake_run(command: list[str]) -> CommandStatus:
        if command[0] == "defaults":
            return CommandStatus(0, stdout="0\n")
        return CommandStatus(1, stderr="should not be called")

    monkeypatch.setattr(macos, "run_status_command", fake_run)

    status = macos.bluetooth_status()

    assert not status.ready
    assert "powered off" in status.detail


def test_gamepad_retry_refreshes_joystick_snapshot_after_initial_absence(monkeypatch: Any) -> None:
    fake_pygame = FakePygameForJoystick([0, 1])
    monkeypatch.setitem(sys.modules, "pygame", fake_pygame)
    pad = GamepadProfile.load("dualsense")

    pygame_mod, joystick, issue = gamepad_input.try_init_gamepad(pad)
    assert pygame_mod is None
    assert joystick is None
    assert issue == "No gamepad detected"

    pygame_mod, joystick, issue = gamepad_input.try_init_gamepad(pad)

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


def test_drive_hardware_wait_scans_hub_while_gamepad_is_missing(monkeypatch: Any) -> None:
    setup = SetupRecorder()
    pad = GamepadProfile.load("dualsense")
    pygame = FakePygameHandle()
    joystick = FakeNamedJoystick()
    gamepad_attempts = 0
    port_map = {"hub": {"name": "Technic Move", "address": None}, "roles": {}}
    FakeDriveHub.events = []
    FakeDriveHub.instances = []

    def fake_try_init_gamepad_candidates(
        profiles: list[GamepadProfile],
    ) -> tuple[session.GamepadConnection | None, str]:
        nonlocal gamepad_attempts
        gamepad_attempts += 1
        if gamepad_attempts == 1:
            FakeDriveHub.events.append("gamepad-missing")
            return None, "No gamepad detected"
        FakeDriveHub.events.append("gamepad-ready")
        return session.GamepadConnection(pygame, joystick, profiles[0]), ""

    monkeypatch.setattr(session, "STARTUP_RETRY_DELAY_S", 0.01)
    monkeypatch.setattr(session, "TechnicMoveHub", FakeDriveHub)
    monkeypatch.setattr(session, "required_hub_port_issue", lambda _hub, _port_map: None)
    monkeypatch.setattr(session, "try_init_gamepad_candidates", fake_try_init_gamepad_candidates)

    result = asyncio.run(session.wait_for_drive_hardware(cast(Any, setup), port_map, [pad]))

    assert result is not None
    connected_pad, hardware = result
    assert connected_pad is pad
    assert hardware.hub is FakeDriveHub.instances[0]
    assert FakeDriveHub.events.index("hub-connect-start") < FakeDriveHub.events.index("gamepad-ready")
    assert gamepad_attempts >= 2
    assert pygame.quit_count == 0


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
