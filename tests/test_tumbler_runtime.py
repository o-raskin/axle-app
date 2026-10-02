"""Deterministic input-to-command workflows for the Tumbler's stateful runtime."""

from __future__ import annotations

import asyncio

import pytest

from bridge.cars.model_profiles import ModelProfile
from bridge.cars.tumbler.low_level_control import LowLevelControl
from bridge.cars.tumbler.runtime import TumblerDriveRuntime
from bridge.gamepads.profile_loader import GamepadProfile
from bridge.safety import SafetyLimits
from bridge.settings import BOOST_UNAVAILABLE_RUMBLE_MS, CRASH_LOCKOUT_S
from tests.fake_hub import PLAY_VM_PORT, FakeHub

PORT_MAP = {"roles": {"play_vm": "0x36", "drive_left": "0x32", "drive_right": "0x33"}}


class Controller:
    def __init__(self, pad: GamepadProfile) -> None:
        self.pad = pad
        self.buttons: set[str] = set()
        self.axes = {pad.axis("steer"): 0.0, pad.axis("throttle_forward"): -1.0, pad.axis("throttle_reverse"): -1.0}
        self.rumbles: list[tuple[float, float, int]] = []

    def get_numbuttons(self) -> int:
        return 16

    def get_button(self, index: int) -> bool:
        return any(self.pad.button(action) == index for action in self.buttons)

    def get_axis(self, index: int) -> float:
        return self.axes[index]

    def rumble(self, low: float, high: float, duration: int) -> bool:
        self.rumbles.append((low, high, duration))
        return True

    def trigger(self, action: str, pressure: float) -> None:
        self.axes[self.pad.axis(action)] = pressure * 2 - 1


def runtime() -> tuple[TumblerDriveRuntime, Controller, LowLevelControl, FakeHub]:
    model = ModelProfile.load("tumbler")
    pad = GamepadProfile.load("dualsense")
    hub = FakeHub()
    return (
        TumblerDriveRuntime(model, pad),
        Controller(pad),
        LowLevelControl(hub, PORT_MAP, model, SafetyLimits(100, 100)),
        hub,
    )


def status(hub: FakeHub, word: int) -> None:
    hub.queue.append(bytes([10, 0, 0x45, PLAY_VM_PORT, 3, 1, *word.to_bytes(4, "little")]))


def test_new_crash_precedes_speed_boost_and_light_buttons_in_the_same_frame() -> None:
    driver, joystick, control, hub = runtime()
    driver.speed_mode = 2
    joystick.trigger("throttle_forward", 1.0)
    joystick.axes[joystick.pad.axis("steer")] = 1.0

    async def run() -> None:
        assert (await driver.sample(joystick, control, 10.0, lambda _: None)).throttle == 50
        joystick.buttons = {"speed_up", "boost", "front_lights", "attack"}
        status(hub, 0x10100)
        logs = []
        frame = await driver.sample(joystick, control, 10.1, logs.append)
        assert frame.crash
        assert frame.command == (0, 0, False, False, False, False, False)
        assert frame.speed_mode == 2
        assert not frame.manual_front_lights_on
        assert frame.boost_until == 0.0
        assert joystick.rumbles == [], "Speed-change haptics must not run after the hub reports a crash"
        assert len(logs) == 1 and "crash detected" in logs[0]
        await control.drive(frame.throttle, frame.steering, lights=frame.front_lights_on)
        assert hub.play_vm_frames()[-1][9:] == bytes([0, 0, 0, 1])

        # Holding buttons through lockout cannot queue a fresh action on expiry.
        held = await driver.sample(joystick, control, 10.1 + CRASH_LOCKOUT_S, logs.append)
        assert not held.crash
        assert held.throttle == 50
        assert held.speed_mode == 2 and not held.boost and not held.flicker
        joystick.buttons = set()
        await driver.sample(joystick, control, 14.0, logs.append)
        joystick.buttons = {"boost", "speed_up"}
        pressed = await driver.sample(joystick, control, 14.1, logs.append)
        assert pressed.boost and pressed.speed_mode == 3

    asyncio.run(run())


def test_speed_change_does_not_reclassify_past_slow_motion_as_a_crash() -> None:
    driver, joystick, control, hub = runtime()
    joystick.trigger("throttle_forward", 1.0)

    async def run() -> None:
        assert (await driver.sample(joystick, control, 10.0, lambda _: None)).throttle == 25
        status(hub, 0x10100)
        joystick.buttons = {"speed_up"}
        frame = await driver.sample(joystick, control, 10.1, lambda _: None)
        assert not frame.crash, "The impact happened before this frame raised the requested speed"
        assert frame.speed_mode == 2 and frame.throttle == 50

    asyncio.run(run())


def test_boost_is_edge_triggered_has_a_cooldown_and_brake_cancels_all_feedback() -> None:
    driver, joystick, control, _hub = runtime()
    joystick.trigger("throttle_reverse", 0.8)

    async def run() -> None:
        logs = []
        joystick.buttons = {"boost"}
        first = await driver.sample(joystick, control, 10.0, logs.append)
        assert first.boost and first.reverse_active
        assert first.boost_ready_in == pytest.approx(driver.boost_hold + driver.boost_cooldown)
        for at in (10.1, 12.0, 20.0):
            held = await driver.sample(joystick, control, at, logs.append)
        assert not held.boost and len(logs) == 1
        joystick.buttons = set()
        await driver.sample(joystick, control, 20.1, logs.append)
        joystick.buttons = {"boost"}
        fired = await driver.sample(joystick, control, 20.2, logs.append)
        assert fired.boost
        joystick.buttons = {"brake"}
        stopped = await driver.sample(joystick, control, 20.3, logs.append)
        assert stopped.brake and stopped.throttle == 0 and stopped.trigger_pressure == 0
        assert stopped.reverse_pressure == pytest.approx(0.8)
        assert stopped.boost_until == stopped.boost_feedback_at == 0.0
        assert stopped.reverse_led_started_at is None
        joystick.buttons = {"brake", "boost"}
        unavailable = await driver.sample(joystick, control, 20.4, logs.append)
        assert not unavailable.boost and unavailable.brake
        assert "boost unavailable while braking" in logs[-1]
        assert len(joystick.rumbles) == 1
        assert unavailable.drive_rumble_paused_until == pytest.approx(20.4 + BOOST_UNAVAILABLE_RUMBLE_MS / 1000)

    asyncio.run(run())


def test_button_edges_and_analog_pressures_reach_real_playvm_frames() -> None:
    driver, joystick, control, hub = runtime()
    joystick.trigger("throttle_reverse", 1.0)
    joystick.axes[joystick.pad.axis("steer")] = -0.5
    joystick.buttons = {"speed_up", "attack", "front_lights"}

    async def run() -> None:
        first = await driver.sample(joystick, control, 10.0, lambda _: None)
        second = await driver.sample(joystick, control, 10.1, lambda _: None)
        assert first.speed_mode == second.speed_mode == 2
        assert len(joystick.rumbles) == 1
        assert first.manual_front_lights_on and second.manual_front_lights_on
        assert first.flicker and second.flicker
        assert first.command == (-50, -50, False, False, False, False, True)
        await control.drive(
            first.throttle,
            first.steering,
            brake=first.brake,
            boost=first.boost,
            lights=first.front_lights_on,
            rocket_lights=first.rocket_lights_on,
            flicker=first.flicker,
        )
        assert hub.play_vm_frames()[-1][9:] == bytes([206, 206, 0, 3])
        joystick.buttons = set()
        await driver.sample(joystick, control, 10.2, lambda _: None)
        joystick.buttons = {"speed_up"}
        third = await driver.sample(joystick, control, 10.3, lambda _: None)
        assert third.speed_mode == 3 and third.throttle == -100
        await driver.sample(joystick, control, 12.0, lambda _: None)
        assert not driver.attack_signal.is_active(12.0)

    asyncio.run(run())


def test_duplicate_impact_reports_do_not_extend_lockout_and_clear_report_rearms_it() -> None:
    driver, joystick, control, hub = runtime()
    driver.speed_mode = 3
    joystick.trigger("throttle_forward", 1.0)

    async def run() -> None:
        status(hub, 0x10100)
        assert (await driver.sample(joystick, control, 10.0, lambda _: None)).crash
        status(hub, 0x10100)
        assert (await driver.sample(joystick, control, 12.0, lambda _: None)).crash_lockout_left == 1.0
        status(hub, 0x10100)
        assert not (await driver.sample(joystick, control, 13.0, lambda _: None)).crash
        status(hub, 0x100)
        await driver.sample(joystick, control, 13.1, lambda _: None)
        status(hub, 0x10100)
        assert (await driver.sample(joystick, control, 13.2, lambda _: None)).crash

    asyncio.run(run())
