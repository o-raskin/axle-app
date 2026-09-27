"""Tests for the parts where a wrong byte moves the car and nothing complains."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from bridge.low_level_control import LowLevelControl, decode_vm_status, decode_vm_status_report
from bridge.port_map import load_port_map, port_id, save_port_map
from bridge.profiles import GamepadProfile, ModelProfile
from bridge.safety import SafetyLimits
from gamepad_bridge import (
    ATTACK_SIGNAL_DURATION_S,
    BOOST_FEEDBACK_DELAY_S,
    BOOST_LED_COLOR,
    BOOST_LED_DIM_COLOR,
    BOOST_LED_TAIL_S,
    BOOST_RUMBLE_FEEDBACK_DELAY_S,
    BOOST_RUMBLE_REFRESH_MS,
    BOOST_RUMBLE_STRENGTH,
    BOOST_UNAVAILABLE_LED_COLOR,
    BOOST_UNAVAILABLE_LED_FLASH_INTERVAL_S,
    BOOST_UNAVAILABLE_LED_FLASH_S,
    BOOST_UNAVAILABLE_RUMBLE_MS,
    CRASH_LED_COLOR,
    CRASH_LOCKOUT_S,
    CRASH_SPEED_THRESHOLD_RATIO,
    DEFAULT_SPEED_MODE,
    DRIVE_RUMBLE_MAX_STRENGTH,
    DRIVE_RUMBLE_PRESSURE_EXPONENT,
    FRONT_LIGHTS_OFF_DELAY_S,
    LED_OFF_COLOR,
    REVERSE_BEEP_START_DELAY_S,
    REVERSE_LED_PHASE_S,
    ROCKET_LIGHTS_BLINK_INTERVAL_S,
    SPEED_MODE_1,
    SPEED_MODE_2,
    SPEED_MODE_3,
    SPEED_MODE_LED_COLORS,
    SPEED_RUMBLE_DURATION_MS,
    SPEED_RUMBLE_STRENGTH,
    AttackSignal,
    AutomaticLights,
    BoostRumble,
    BoostUnavailableFeedback,
    CarTelemetry,
    CoreAudioOutputDevice,
    CrashLockout,
    ReverseBeep,
    boost_feedback_active,
    boost_led_color,
    boost_led_feedback_active,
    boost_rumble_feedback_at,
    boost_rumble_strength,
    change_speed_mode_with_feedback,
    decrease_speed_mode,
    drive_power_for_trigger,
    drive_rumble_strength,
    gamepad_led_color,
    gamepad_name_is_dualsense,
    increase_speed_mode,
    led_color_label,
    read_drive_input,
    read_drive_state,
    read_trigger_pressures,
    render_car_dashboard,
    render_setup_panel,
    reverse_beep_status,
    reverse_led_color,
    rumble_speed_change,
    select_dualsense_audio_device,
    select_dualsense_coreaudio_device,
    select_forced_coreaudio_device,
    trigger_amount,
    update_gamepad_led,
)
from probe_hub import build_report
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


def test_subscribed_status_report_decodes_impact_flag() -> None:
    play_vm = port_id(PORT_MAP, "play_vm")
    status = 0x10100
    raw = bytes([12, 0, 0x45, play_vm, 0x03, 0x01, *status.to_bytes(4, "little"), 0, 0])

    assert decode_vm_status_report(raw, play_vm) == (status, ["success", "impact"])
    assert decode_vm_status_report(bytes([5, 0, 0x82, play_vm, 0x0A]), play_vm) is None


def test_live_status_reports_are_drained_from_hub(control: tuple[LowLevelControl, FakeHub]) -> None:
    ctl, hub = control
    play_vm = port_id(PORT_MAP, "play_vm")
    status = 0x10100
    hub.queue.append(bytes([5, 0, 0x82, play_vm, 0x0A]))
    hub.queue.append(bytes([12, 0, 0x45, play_vm, 0x03, 0x01, *status.to_bytes(4, "little"), 0, 0]))

    assert ctl.drain_status_reports() == [(status, ["success", "impact"])]
    assert hub.queue == []


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


def test_rocket_lights_use_the_configured_second_control_bit(control: tuple[LowLevelControl, FakeHub]) -> None:
    ctl, hub = control
    asyncio.run(ctl.drive(0, 0, rocket_lights=True))
    frame = hub.sent[-1]
    assert frame[11] == 0x00
    assert frame[12] == 0x04


def test_flicker_uses_the_configured_second_control_bit(control: tuple[LowLevelControl, FakeHub]) -> None:
    ctl, hub = control
    asyncio.run(ctl.drive(0, 0, flicker=True))
    frame = hub.sent[-1]
    assert frame[11] == 0x00
    assert frame[12] == 0x02


def test_front_rocket_and_flicker_lights_are_independent(control: tuple[LowLevelControl, FakeHub]) -> None:
    ctl, hub = control
    asyncio.run(ctl.drive(0, 0, lights=False, rocket_lights=True, flicker=True))
    frame = hub.sent[-1]
    assert frame[11] == 0x00
    assert frame[12] == 0x07


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
    assert model.bit("drive_mode") == 0x02
    assert model.bit("boost") == 0x04
    assert model.bit("calibrate") == 0x08
    assert model.bit("good_to_go") == 0x10
    assert model.bit("reverse") == 0x20
    assert model.bit("attack") == 0x80
    assert model.bit2("lights_off") == 0x01
    assert model.bit2("flicker") == 0x02
    assert model.bit2("attack_lights") == 0x04


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


def test_dualsense_triggers_wake_before_stick_deadzone() -> None:
    pad = GamepadProfile.load("dualsense")

    assert pad.deadzone == 0.15
    assert pad.trigger_deadzone == 0.01
    assert trigger_amount(-0.88, pad.triggers_rest_negative, pad.trigger_deadzone) == pytest.approx(0.06)
    assert trigger_amount(-0.88, pad.triggers_rest_negative, pad.deadzone) == 0.0


def test_speed_modes_scale_trigger_to_drive_power() -> None:
    assert DEFAULT_SPEED_MODE == SPEED_MODE_1
    assert drive_power_for_trigger(1.0, 100, SPEED_MODE_1) == 25
    assert drive_power_for_trigger(1.0, 100, SPEED_MODE_2) == 50
    assert drive_power_for_trigger(1.0, 100, SPEED_MODE_3) == 100
    assert drive_power_for_trigger(0.5, 100, SPEED_MODE_2) == 25
    assert drive_power_for_trigger(-0.5, 100, SPEED_MODE_3) == -50


def test_drive_rumble_scales_with_actual_drive_power() -> None:
    assert DRIVE_RUMBLE_MAX_STRENGTH == 0.7
    assert DRIVE_RUMBLE_PRESSURE_EXPONENT == 1.4
    assert drive_rumble_strength(0.0, SPEED_MODE_3) == 0.0
    assert drive_rumble_strength(0.25, SPEED_MODE_3) == pytest.approx(0.1, abs=0.01)
    assert drive_rumble_strength(0.50, SPEED_MODE_3) == pytest.approx(0.27, abs=0.01)
    assert drive_rumble_strength(0.75, SPEED_MODE_3) == pytest.approx(0.47, abs=0.01)
    assert drive_rumble_strength(1.0, SPEED_MODE_3) == pytest.approx(DRIVE_RUMBLE_MAX_STRENGTH)
    assert drive_rumble_strength(1.0, SPEED_MODE_2) == pytest.approx(0.35)
    assert drive_rumble_strength(1.0, SPEED_MODE_1) == pytest.approx(0.175)
    assert drive_rumble_strength(1.5, SPEED_MODE_3) == pytest.approx(DRIVE_RUMBLE_MAX_STRENGTH)


def test_crash_lockout_ignores_normal_trigger_release() -> None:
    crash = CrashLockout()

    assert CRASH_SPEED_THRESHOLD_RATIO == 0.30
    assert not crash.update(60, 100, 10.0)
    assert not crash.update(0, 100, 10.1)
    assert not crash.active(10.1)


def test_crash_lockout_detects_new_impact_above_30_percent() -> None:
    crash = CrashLockout()

    assert not crash.update(30, 100, 10.0)
    assert crash.update(30, 100, 10.1, impact=True)
    assert crash.active(10.2)
    assert crash.remaining(10.1) == pytest.approx(CRASH_LOCKOUT_S)
    assert not crash.active(10.2 + CRASH_LOCKOUT_S)


def test_crash_lockout_can_track_intentional_braking_without_triggering() -> None:
    crash = CrashLockout()

    assert not crash.update(60, 100, 20.0)
    assert not crash.update(0, 100, 20.1, impact=True, enabled=False)

    assert crash.previous_throttle == 0
    assert not crash.active(20.1)


class AxisJoystick:
    def __init__(self, axes: dict[int, float]) -> None:
        self.axes = axes

    def get_axis(self, index: int) -> float:
        return self.axes.get(index, -1.0)


def test_drive_input_uses_forward_or_reverse_trigger_pressure() -> None:
    pad = GamepadProfile.load("dualsense")

    forward = AxisJoystick({pad.axis("throttle_forward"): 0.0})
    reverse = AxisJoystick({pad.axis("throttle_reverse"): 0.0})

    assert read_drive_input(forward, pad, 100, SPEED_MODE_2) == (25, 0.5)
    assert read_drive_input(reverse, pad, 100, SPEED_MODE_2) == (-25, 0.5)


def test_drive_state_reports_forward_and_reverse_pressure_independently() -> None:
    pad = GamepadProfile.load("dualsense")
    joystick = AxisJoystick(
        {
            pad.axis("throttle_forward"): 0.0,
            pad.axis("throttle_reverse"): -0.5,
        }
    )

    assert read_trigger_pressures(joystick, pad) == (0.5, 0.25)
    assert read_drive_state(joystick, pad, 100, SPEED_MODE_2) == (12, 0.25, 0.5, 0.25)


def test_speed_mode_buttons_clamp_modes() -> None:
    assert increase_speed_mode(SPEED_MODE_1) == SPEED_MODE_2
    assert increase_speed_mode(SPEED_MODE_2) == SPEED_MODE_3
    assert increase_speed_mode(SPEED_MODE_3) == SPEED_MODE_3
    assert decrease_speed_mode(SPEED_MODE_3) == SPEED_MODE_2
    assert decrease_speed_mode(SPEED_MODE_2) == SPEED_MODE_1
    assert decrease_speed_mode(SPEED_MODE_1) == SPEED_MODE_1


class RumbleJoystick:
    def __init__(self) -> None:
        self.rumbles: list[tuple[float, float, int]] = []
        self.stop_count = 0

    def rumble(self, low_frequency: float, high_frequency: float, duration_ms: int) -> bool:
        self.rumbles.append((low_frequency, high_frequency, duration_ms))
        return True

    def stop_rumble(self) -> None:
        self.stop_count += 1


class SoundChannel:
    def __init__(self) -> None:
        self.stop_count = 0
        self.busy = True

    def get_busy(self) -> bool:
        return self.busy

    def stop(self) -> None:
        self.stop_count += 1
        self.busy = False


class SoundRecorder:
    def __init__(self) -> None:
        self.channels: list[SoundChannel] = []

    def play(self) -> SoundChannel:
        channel = SoundChannel()
        self.channels.append(channel)
        return channel


def test_speed_mode_rumble_distinguishes_increase_and_decrease() -> None:
    joystick = RumbleJoystick()

    asyncio.run(rumble_speed_change(joystick, 1))
    asyncio.run(rumble_speed_change(joystick, -1))

    assert joystick.rumbles == [
        (0.0, SPEED_RUMBLE_STRENGTH, SPEED_RUMBLE_DURATION_MS),
        (SPEED_RUMBLE_STRENGTH, 0.0, SPEED_RUMBLE_DURATION_MS),
    ]


def test_speed_mode_rumble_ignores_zero_direction() -> None:
    joystick = RumbleJoystick()

    asyncio.run(rumble_speed_change(joystick, 0))

    assert joystick.rumbles == []


def test_speed_mode_feedback_does_not_rumble_at_limits() -> None:
    joystick = RumbleJoystick()

    assert asyncio.run(change_speed_mode_with_feedback(joystick, SPEED_MODE_3, 1)) == SPEED_MODE_3
    assert asyncio.run(change_speed_mode_with_feedback(joystick, SPEED_MODE_1, -1)) == SPEED_MODE_1

    assert joystick.rumbles == []


def test_speed_mode_rumble_ignores_missing_haptics() -> None:
    asyncio.run(rumble_speed_change(object(), 1))


def test_boost_rumble_is_strong_while_boosting_and_stops_afterward() -> None:
    joystick = RumbleJoystick()
    boost_rumble = BoostRumble()

    boost_rumble.update(joystick, BOOST_RUMBLE_STRENGTH)
    boost_rumble.update(joystick, BOOST_RUMBLE_STRENGTH / 2)
    boost_rumble.update(joystick, 0.0)

    assert joystick.rumbles == [
        (BOOST_RUMBLE_STRENGTH, BOOST_RUMBLE_STRENGTH, BOOST_RUMBLE_REFRESH_MS),
        (BOOST_RUMBLE_STRENGTH / 2, BOOST_RUMBLE_STRENGTH / 2, BOOST_RUMBLE_REFRESH_MS),
    ]
    assert joystick.stop_count == 1


def test_boost_feedback_waits_for_delay() -> None:
    started_at = 20.0
    feedback_at = started_at + BOOST_FEEDBACK_DELAY_S

    assert not boost_feedback_active(boost=True, boost_feedback_at=feedback_at, now=feedback_at - 0.01)
    assert boost_feedback_active(boost=True, boost_feedback_at=feedback_at, now=feedback_at)
    assert not boost_feedback_active(boost=False, boost_feedback_at=feedback_at, now=feedback_at)


def test_boost_rumble_ignores_missing_haptics() -> None:
    boost_rumble = BoostRumble()

    boost_rumble.update(object(), BOOST_RUMBLE_STRENGTH)
    boost_rumble.update(object(), 0.0)


def test_reverse_beep_repeats_when_previous_playback_finishes() -> None:
    sound = SoundRecorder()
    beep = ReverseBeep(sound)

    beep.update(reverse_active=True, now=10.0)
    beep.update(reverse_active=True, now=10.0 + REVERSE_BEEP_START_DELAY_S - 0.01)
    assert sound.channels == []

    beep.update(reverse_active=True, now=10.0 + REVERSE_BEEP_START_DELAY_S)
    beep.update(reverse_active=True, now=11.1)
    sound.channels[-1].busy = False
    beep.update(reverse_active=True, now=11.2)

    assert len(sound.channels) == 2


def test_reverse_beep_stops_and_restarts_with_reverse_state() -> None:
    sound = SoundRecorder()
    beep = ReverseBeep(sound)

    beep.update(reverse_active=True, now=20.0)
    beep.update(reverse_active=True, now=20.0 + REVERSE_BEEP_START_DELAY_S)
    first_channel = sound.channels[-1]
    beep.update(reverse_active=False, now=20.5)
    beep.update(reverse_active=True, now=30.0)
    beep.update(reverse_active=True, now=30.0 + REVERSE_BEEP_START_DELAY_S)

    assert first_channel.stop_count == 1
    assert len(sound.channels) == 2


def test_reverse_beep_ignores_missing_sound() -> None:
    beep = ReverseBeep()

    beep.update(reverse_active=True, now=40.0)
    beep.update(reverse_active=False, now=40.5)


def test_dualsense_audio_device_selection_prefers_controller_outputs() -> None:
    assert (
        select_dualsense_audio_device(["MacBook Pro Speakers", "DualSense Wireless Controller"])
        == "DualSense Wireless Controller"
    )
    assert select_dualsense_audio_device(["External Display", "Wireless Controller"]) == "Wireless Controller"
    assert select_dualsense_audio_device(["MacBook Pro Speakers"]) is None


def test_coreaudio_device_selection_prefers_controller_outputs() -> None:
    devices = [
        CoreAudioOutputDevice(10, "MacBook Pro Speakers"),
        CoreAudioOutputDevice(20, "DualSense Wireless Controller"),
    ]

    assert select_dualsense_coreaudio_device(devices) == devices[1]
    assert select_forced_coreaudio_device(devices, "dualSense wireless controller") == devices[1]
    assert select_forced_coreaudio_device(devices, "wireless") == devices[1]
    assert select_forced_coreaudio_device(devices, "Missing") is None


def test_reverse_beep_status_names_pending_and_playing_states() -> None:
    sound = SoundRecorder()
    beep = ReverseBeep(sound)

    assert reverse_beep_status(beep, reverse_active=False, now=10.0) == "off"
    beep.update(reverse_active=True, now=10.0)

    assert reverse_beep_status(beep, reverse_active=True, now=10.5) == "armed 0.5s"

    beep.update(reverse_active=True, now=10.0 + REVERSE_BEEP_START_DELAY_S)

    assert reverse_beep_status(beep, reverse_active=True, now=11.0) == "playing"
    assert reverse_beep_status(ReverseBeep(), reverse_active=True, now=11.0) == "disabled"


def test_gamepad_led_color_can_be_rendered_without_writing_led() -> None:
    assert gamepad_led_color(SPEED_MODE_3, boost_feedback=True) == BOOST_LED_COLOR
    assert led_color_label(SPEED_MODE_LED_COLORS[SPEED_MODE_2]) == "white 55%"
    assert led_color_label((0, SPEED_MODE_LED_COLORS[SPEED_MODE_1][1], 0)) == "green 19%"


def test_car_dashboard_renders_current_action_state() -> None:
    dashboard = render_car_dashboard(
        CarTelemetry(
            model_name="42239 Batmobile Tumbler",
            hub_name="Technic Move",
            max_drive=100,
            max_steering=100,
            throttle=-45,
            steering=30,
            speed_mode=SPEED_MODE_2,
            trigger_pressure=0.45,
            forward_pressure=0.10,
            reverse_pressure=0.55,
            boost=True,
            boost_pressed=True,
            front_lights_on=True,
            manual_front_lights_on=True,
            rocket_lights_on=True,
            flicker=True,
            speed_up_pressed=True,
            front_lights_pressed=True,
            attack_pressed=True,
            led_color=BOOST_LED_COLOR,
            rumble_strength=BOOST_RUMBLE_STRENGTH,
            reverse_beep="playing",
        ),
        width=96,
    )

    assert "DUALSENSE COCKPIT" in dashboard
    assert "DRIVE" in dashboard
    assert "REVERSE" in dashboard
    assert "mode 2 / 50%" in dashboard
    assert "L2  55%" in dashboard
    assert "R2  10%" in dashboard
    assert "[R1 boost ON ACTIVE]" in dashboard
    assert "[D-up ON mode+]" in dashboard
    assert "[Square lights ON]" in dashboard
    assert "rockets BLINK" in dashboard
    assert "beep playing" in dashboard
    assert "RIGHT" in dashboard


def test_setup_panel_tells_user_the_next_required_action() -> None:
    panel = render_setup_panel(
        "Connect the car",
        "Press the Technic Move Hub power/connect button now.",
        [
            ("DualSense controller detected", True),
            ("Technic Move Hub connected", False),
            ("Live drive session ready", False),
        ],
        "Looking for hub: Technic Move",
        width=88,
    )

    assert "LEGO TECHNIC BRIDGE - READY CHECK" in panel
    assert "Press the Technic Move Hub power/connect button now." in panel
    assert "[OK] DualSense controller detected" in panel
    assert "[..] Technic Move Hub connected" in panel
    assert "Looking for hub: Technic Move" in panel


def test_dualsense_name_detection_accepts_common_macos_names() -> None:
    assert gamepad_name_is_dualsense("DualSense Wireless Controller")
    assert gamepad_name_is_dualsense("Wireless Controller")
    assert gamepad_name_is_dualsense("PS5 Controller")
    assert not gamepad_name_is_dualsense("Xbox Wireless Controller")


class LedRecorder:
    def __init__(self) -> None:
        self.colors: list[tuple[int, int, int]] = []

    def set_color(self, color: tuple[int, int, int]) -> bool:
        self.colors.append(color)
        return True


def test_speed_mode_led_uses_white_brightness_levels() -> None:
    led = LedRecorder()

    update_gamepad_led(led, SPEED_MODE_1, boost_feedback=False)
    update_gamepad_led(led, SPEED_MODE_2, boost_feedback=False)
    update_gamepad_led(led, SPEED_MODE_3, boost_feedback=False)

    assert led.colors == [
        SPEED_MODE_LED_COLORS[SPEED_MODE_1],
        SPEED_MODE_LED_COLORS[SPEED_MODE_2],
        SPEED_MODE_LED_COLORS[SPEED_MODE_3],
    ]


def test_boost_led_overrides_speed_mode_with_orange() -> None:
    led = LedRecorder()

    update_gamepad_led(led, SPEED_MODE_3, boost_feedback=True)

    assert led.colors == [BOOST_LED_COLOR]


def test_reverse_led_cycles_speed_white_then_green() -> None:
    led = LedRecorder()
    started_at = 70.0

    update_gamepad_led(led, SPEED_MODE_2, boost_feedback=False, reverse_started_at=started_at, now=started_at)
    update_gamepad_led(
        led,
        SPEED_MODE_2,
        boost_feedback=False,
        reverse_started_at=started_at,
        now=started_at + REVERSE_LED_PHASE_S,
    )
    update_gamepad_led(
        led,
        SPEED_MODE_2,
        boost_feedback=False,
        reverse_started_at=started_at,
        now=started_at + (REVERSE_LED_PHASE_S * 2),
    )

    assert led.colors == [
        SPEED_MODE_LED_COLORS[SPEED_MODE_2],
        (0, SPEED_MODE_LED_COLORS[SPEED_MODE_2][1], 0),
        SPEED_MODE_LED_COLORS[SPEED_MODE_2],
    ]


def test_reverse_led_green_matches_speed_mode_brightness() -> None:
    green_at = 80.0 + REVERSE_LED_PHASE_S

    assert reverse_led_color(SPEED_MODE_1, 80.0, green_at) == (0, SPEED_MODE_LED_COLORS[SPEED_MODE_1][1], 0)
    assert reverse_led_color(SPEED_MODE_2, 80.0, green_at) == (0, SPEED_MODE_LED_COLORS[SPEED_MODE_2][1], 0)
    assert reverse_led_color(SPEED_MODE_3, 80.0, green_at) == (0, SPEED_MODE_LED_COLORS[SPEED_MODE_3][1], 0)
    assert reverse_led_color(SPEED_MODE_3, None, 80.0) is None


def test_boost_led_overrides_reverse_led() -> None:
    led = LedRecorder()

    update_gamepad_led(led, SPEED_MODE_3, boost_feedback=True, reverse_started_at=90.0, now=90.0)

    assert led.colors == [BOOST_LED_COLOR]


def test_crash_led_overrides_other_feedback_with_bright_red() -> None:
    led = LedRecorder()

    update_gamepad_led(
        led,
        SPEED_MODE_3,
        boost_feedback=True,
        boost_color=BOOST_LED_COLOR,
        crash_feedback=True,
        reverse_started_at=90.0,
        now=90.0,
    )

    assert led.colors == [CRASH_LED_COLOR]


def test_boost_led_color_ramps_from_dim_to_bright_orange() -> None:
    boost_started_at = 30.0
    feedback_at = boost_started_at + BOOST_FEEDBACK_DELAY_S
    boost_until = 32.0

    assert boost_led_color(feedback_at, boost_until, feedback_at) == BOOST_LED_DIM_COLOR
    assert boost_led_color(feedback_at, boost_until, feedback_at + (BOOST_FEEDBACK_DELAY_S / 2)) == (
        163,
        60,
        0,
    )
    assert boost_led_color(feedback_at, boost_until, feedback_at + BOOST_FEEDBACK_DELAY_S) == BOOST_LED_COLOR


def test_boost_led_color_fades_after_boost_ends() -> None:
    boost_started_at = 30.0
    feedback_at = boost_started_at + BOOST_FEEDBACK_DELAY_S
    boost_until = 32.0

    assert boost_led_color(feedback_at, boost_until, boost_until) == BOOST_LED_COLOR
    assert boost_led_color(feedback_at, boost_until, boost_until + (BOOST_LED_TAIL_S / 2)) == (
        127,
        48,
        0,
    )
    assert boost_led_color(feedback_at, boost_until, boost_until + BOOST_LED_TAIL_S) == LED_OFF_COLOR


def test_boost_led_waits_for_feedback_delay() -> None:
    led = LedRecorder()
    started_at = 30.0
    feedback_at = started_at + BOOST_FEEDBACK_DELAY_S

    update_gamepad_led(
        led,
        SPEED_MODE_3,
        boost_feedback_active(boost=True, boost_feedback_at=feedback_at, now=feedback_at - 0.01),
    )
    update_gamepad_led(
        led,
        SPEED_MODE_3,
        boost_feedback_active(boost=True, boost_feedback_at=feedback_at, now=feedback_at),
    )

    assert led.colors == [SPEED_MODE_LED_COLORS[SPEED_MODE_3], BOOST_LED_COLOR]


def test_boost_led_lasts_a_little_after_boost_ends() -> None:
    boost_started_at = 30.0
    boost_until = 32.0
    feedback_at = boost_started_at + BOOST_FEEDBACK_DELAY_S

    assert boost_led_feedback_active(feedback_at, boost_until, boost_until)
    assert boost_led_feedback_active(feedback_at, boost_until, boost_until + BOOST_LED_TAIL_S - 0.01)
    assert not boost_led_feedback_active(feedback_at, boost_until, boost_until + BOOST_LED_TAIL_S)


def test_boost_rumble_strength_fades_after_boost_ends() -> None:
    boost_started_at = 30.0
    feedback_at = boost_started_at + BOOST_FEEDBACK_DELAY_S
    boost_until = 32.0

    assert boost_rumble_strength(feedback_at, boost_until, feedback_at - 0.01) == 0.0
    rumble_at = boost_rumble_feedback_at(feedback_at)
    assert boost_rumble_strength(feedback_at, boost_until, rumble_at - 0.01) == 0.0
    assert boost_rumble_strength(feedback_at, boost_until, rumble_at) == BOOST_RUMBLE_STRENGTH
    assert boost_rumble_strength(feedback_at, boost_until, boost_until + (BOOST_LED_TAIL_S / 2)) == pytest.approx(
        BOOST_RUMBLE_STRENGTH / 2
    )
    assert boost_rumble_strength(feedback_at, boost_until, boost_until + BOOST_LED_TAIL_S) == 0.0


def test_boost_rumble_starts_after_led_feedback() -> None:
    boost_started_at = 30.0
    led_feedback_at = boost_started_at + BOOST_FEEDBACK_DELAY_S
    boost_until = 32.0

    assert boost_rumble_feedback_at(led_feedback_at) == pytest.approx(boost_started_at + BOOST_RUMBLE_FEEDBACK_DELAY_S)
    assert boost_led_feedback_active(led_feedback_at, boost_until, led_feedback_at)
    assert boost_rumble_strength(led_feedback_at, boost_until, led_feedback_at) == 0.0


def test_unavailable_boost_feedback_flickers_red_and_strong_rumbles() -> None:
    joystick = RumbleJoystick()
    led = LedRecorder()
    feedback = BoostUnavailableFeedback()

    feedback.trigger(joystick, 40.0)
    update_gamepad_led(led, SPEED_MODE_2, boost_feedback=False, boost_unavailable_feedback=feedback, now=40.0)
    update_gamepad_led(
        led,
        SPEED_MODE_2,
        boost_feedback=False,
        boost_unavailable_feedback=feedback,
        now=40.0 + BOOST_UNAVAILABLE_LED_FLASH_INTERVAL_S,
    )
    update_gamepad_led(
        led,
        SPEED_MODE_2,
        boost_feedback=False,
        boost_unavailable_feedback=feedback,
        now=40.0 + (BOOST_UNAVAILABLE_LED_FLASH_INTERVAL_S * 2),
    )
    update_gamepad_led(
        led,
        SPEED_MODE_2,
        boost_feedback=False,
        boost_unavailable_feedback=feedback,
        now=40.0 + BOOST_UNAVAILABLE_LED_FLASH_S,
    )

    assert joystick.rumbles == [(BOOST_RUMBLE_STRENGTH, BOOST_RUMBLE_STRENGTH, BOOST_UNAVAILABLE_RUMBLE_MS)]
    assert led.colors == [
        BOOST_UNAVAILABLE_LED_COLOR,
        LED_OFF_COLOR,
        BOOST_UNAVAILABLE_LED_COLOR,
        SPEED_MODE_LED_COLORS[SPEED_MODE_2],
    ]


def test_front_lights_follow_forward_speed_and_stop_delay() -> None:
    lights = AutomaticLights()

    assert lights.state_for(0, 10.0) == (False, False)
    assert lights.state_for(25, 11.0) == (True, False)
    assert lights.state_for(0, 12.0) == (True, False)
    assert lights.state_for(0, 12.0 + FRONT_LIGHTS_OFF_DELAY_S - 0.01) == (True, False)
    assert lights.state_for(0, 12.0 + FRONT_LIGHTS_OFF_DELAY_S) == (False, False)


def test_front_lights_can_still_be_toggled_manually_when_stopped() -> None:
    lights = AutomaticLights()

    lights.toggle_front_lights()
    assert lights.state_for(0, 30.0) == (True, False)
    lights.toggle_front_lights()
    assert lights.state_for(0, 31.0) == (False, False)


def test_forward_and_reverse_override_manual_front_lights() -> None:
    lights = AutomaticLights()

    lights.toggle_front_lights()
    assert lights.state_for(-25, 40.0) == (False, False)
    assert lights.state_for(25, 41.0) == (True, False)


def test_reverse_speed_blinks_rocket_lights_until_stopped() -> None:
    lights = AutomaticLights()

    assert lights.state_for(-25, 20.0) == (False, False)
    assert lights.state_for(-25, 20.0 + ROCKET_LIGHTS_BLINK_INTERVAL_S - 0.01) == (False, False)
    assert lights.state_for(-25, 20.0 + ROCKET_LIGHTS_BLINK_INTERVAL_S) == (False, True)
    assert lights.state_for(-25, 20.0 + (ROCKET_LIGHTS_BLINK_INTERVAL_S * 2)) == (False, False)
    assert lights.state_for(0, 23.0) == (False, False)
    assert lights.state_for(-25, 24.0) == (False, False)


def test_attack_signal_runs_for_configured_duration_and_ignores_retrigger() -> None:
    attack = AttackSignal()

    attack.trigger(50.0)
    assert attack.is_active(50.0)
    attack.trigger(50.5)
    assert attack.active_until == 50.0 + ATTACK_SIGNAL_DURATION_S
    assert attack.is_active(50.0 + ATTACK_SIGNAL_DURATION_S - 0.01)
    assert not attack.is_active(50.0 + ATTACK_SIGNAL_DURATION_S)


def test_attack_signal_is_independent_of_reverse_rocket_blinking() -> None:
    lights = AutomaticLights()
    attack = AttackSignal()

    attack.trigger(60.0)
    assert attack.is_active(60.0)
    assert lights.state_for(-25, 60.0) == (False, False)
    assert lights.state_for(-25, 60.0 + ROCKET_LIGHTS_BLINK_INTERVAL_S) == (False, True)
    finished_at = 60.0 + ATTACK_SIGNAL_DURATION_S
    assert not attack.is_active(finished_at)
    assert lights.state_for(-25, finished_at) == (False, True)


def test_dualsense_dpad_light_and_attack_bindings_are_buttons() -> None:
    pad = GamepadProfile.load("dualsense")

    assert pad.button("speed_up") == 11
    assert pad.button("speed_down") == 12
    assert pad.button("front_lights") == 2
    assert pad.button("attack") == 1


def test_probe_report_uses_saved_port_map_shape() -> None:
    hub = FakeHub()
    hub.hub_name = "Technic Move"  # type: ignore[attr-defined]
    hub.hub_address = None  # type: ignore[attr-defined]
    hub.attached_devices = {}  # type: ignore[attr-defined]

    report = build_report(hub, PORT_MAP)  # type: ignore[arg-type]

    assert "- play_vm: 0x36" in report
