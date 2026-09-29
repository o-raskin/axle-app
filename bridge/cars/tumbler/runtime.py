"""Per-frame runtime behavior for the LEGO Technic 42239 Batmobile Tumbler."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from ...feedback import BoostUnavailableFeedback, CrashLockout, change_speed_mode_with_feedback
from ...gamepads.input import axis_to_percent, button_held, read_drive_state, read_trigger_pressures
from ...gamepads.profile_loader import GamepadProfile
from ...settings import (
    BOOST_FEEDBACK_DELAY_S,
    CRASH_LOCKOUT_S,
    DEFAULT_SPEED_MODE,
    SPEED_MODE_RATIOS,
    SPEED_RUMBLE_DURATION_MS,
)
from ..model_profiles import ModelProfile
from .effects import AttackSignal, AutomaticLights
from .low_level_control import LowLevelControl

LogCallback = Callable[[str], None]


@dataclass(frozen=True)
class TumblerInputMap:
    """Profile action names resolved to concrete gamepad axes and buttons."""

    brake_button: int
    boost_button: int
    speed_up_button: int
    speed_down_button: int
    front_lights_button: int
    attack_button: int
    steer_axis: int

    @classmethod
    def from_profile(cls, pad: GamepadProfile) -> "TumblerInputMap":
        """Resolve all Tumbler control actions from a gamepad profile."""
        return cls(
            brake_button=pad.button("brake"),
            boost_button=pad.button("boost"),
            speed_up_button=pad.button("speed_up"),
            speed_down_button=pad.button("speed_down"),
            front_lights_button=pad.button("front_lights"),
            attack_button=pad.button("attack"),
            steer_axis=pad.axis("steer"),
        )


@dataclass(frozen=True)
class TumblerButtons:
    """Current gamepad button state for Tumbler actions."""

    brake: bool
    boost: bool
    speed_up: bool
    speed_down: bool
    front_lights: bool
    attack: bool


@dataclass(frozen=True)
class TumblerDriveFrame:
    """One resolved Tumbler command frame plus telemetry-facing state."""

    throttle: int
    steering: int
    speed_mode: int
    trigger_pressure: float
    forward_pressure: float
    reverse_pressure: float
    brake: bool
    boost: bool
    boost_ready_in: float
    boost_feedback_at: float
    boost_until: float
    drive_rumble_paused_until: float
    crash: bool
    crash_lockout_left: float
    front_lights_on: bool
    manual_front_lights_on: bool
    rocket_lights_on: bool
    flicker: bool
    reverse_led_started_at: float | None
    speed_up_pressed: bool
    speed_down_pressed: bool
    boost_pressed: bool
    front_lights_pressed: bool
    attack_pressed: bool

    @property
    def reverse_active(self) -> bool:
        """Return whether the car is currently commanded to reverse."""
        return self.throttle < 0

    @property
    def command(self) -> tuple[int, int, bool, bool, bool, bool, bool]:
        """Return the low-level command identity used to suppress duplicate sends."""
        return (
            self.throttle,
            self.steering,
            self.brake,
            self.boost,
            self.front_lights_on,
            self.rocket_lights_on,
            self.flicker,
        )


@dataclass(frozen=True)
class TumblerMotionState:
    """Resolved throttle-side analog input before lights and steering are applied."""

    throttle: int
    trigger_pressure: float
    forward_pressure: float
    reverse_pressure: float
    brake: bool


class TumblerDriveRuntime:
    """Stateful Tumbler-specific command resolver used by the generic live session."""

    def __init__(self, model: ModelProfile, pad: GamepadProfile) -> None:
        """Bind the Tumbler model profile and gamepad mapping."""
        self.model = model
        self.pad = pad
        self.input_map = TumblerInputMap.from_profile(pad)
        self.lights = AutomaticLights()
        self.attack_signal = AttackSignal()
        self.boost_unavailable_feedback = BoostUnavailableFeedback()
        self.crash_lockout = CrashLockout()
        self.speed_mode = DEFAULT_SPEED_MODE
        self.drive_rumble_paused_until = 0.0
        self.front_lights_prev = False
        self.attack_prev = False
        self.speed_up_prev = False
        self.speed_down_prev = False
        self.boost_prev = False
        self.boost_until = 0.0
        self.boost_feedback_at = 0.0
        self.boost_ready_at = 0.0
        self.reverse_led_started_at: float | None = None
        self.boost_hold = model.boost["hold_s"]
        self.boost_cooldown = model.boost["cooldown_s"]

    def read_buttons(self, joystick: Any) -> TumblerButtons:
        """Read all Tumbler action buttons from the joystick."""
        mapping = self.input_map
        return TumblerButtons(
            brake=button_held(joystick, mapping.brake_button),
            boost=button_held(joystick, mapping.boost_button),
            speed_up=button_held(joystick, mapping.speed_up_button),
            speed_down=button_held(joystick, mapping.speed_down_button),
            front_lights=button_held(joystick, mapping.front_lights_button),
            attack=button_held(joystick, mapping.attack_button),
        )

    async def sample(
        self,
        joystick: Any,
        control: LowLevelControl,
        now: float,
        log: LogCallback,
    ) -> TumblerDriveFrame:
        """Resolve buttons, hub status, timers, and analog input into one drive frame."""
        buttons = self.read_buttons(joystick)
        crash_active = self.crash_lockout.active(now)
        brake = buttons.brake and not crash_active

        await self._update_speed_mode(joystick, buttons, crash_active, now, log)
        motion = self._read_motion(joystick, brake, crash_active)

        crash_active, motion = self._update_crash_lockout(
            control,
            motion,
            buttons.brake,
            crash_active,
            now,
            log=log,
        )

        self._update_reverse_state(motion.throttle, now)
        self._update_boost(joystick, buttons, motion.brake, crash_active, now, log=log)
        self._update_manual_effects(buttons, crash_active, now)

        boost = not crash_active and now < self.boost_until
        flicker = False if crash_active else self.attack_signal.is_active(now)
        front_lights_on, rocket_lights_on = (
            (False, False) if crash_active else self.lights.state_for(motion.throttle, now)
        )
        steering = 0
        if not crash_active:
            steering = axis_to_percent(
                joystick.get_axis(self.input_map.steer_axis),
                self.model.max_steering,
                self.pad.deadzone,
            )

        return TumblerDriveFrame(
            throttle=motion.throttle,
            steering=steering,
            speed_mode=self.speed_mode,
            trigger_pressure=motion.trigger_pressure,
            forward_pressure=motion.forward_pressure,
            reverse_pressure=motion.reverse_pressure,
            brake=motion.brake,
            boost=boost,
            boost_ready_in=max(0.0, self.boost_ready_at - now),
            boost_feedback_at=self.boost_feedback_at,
            boost_until=self.boost_until,
            drive_rumble_paused_until=self.drive_rumble_paused_until,
            crash=crash_active,
            crash_lockout_left=self.crash_lockout.remaining(now),
            front_lights_on=front_lights_on,
            manual_front_lights_on=self.lights.front_lights_manual_on,
            rocket_lights_on=rocket_lights_on,
            flicker=flicker,
            reverse_led_started_at=self.reverse_led_started_at,
            speed_up_pressed=buttons.speed_up and not crash_active,
            speed_down_pressed=buttons.speed_down and not crash_active,
            boost_pressed=buttons.boost and not crash_active,
            front_lights_pressed=buttons.front_lights and not crash_active,
            attack_pressed=buttons.attack and not crash_active,
        )

    async def _update_speed_mode(
        self,
        joystick: Any,
        buttons: TumblerButtons,
        crash_active: bool,
        now: float,
        log: LogCallback,
    ) -> None:
        if not crash_active and buttons.speed_up and not self.speed_up_prev:
            await self._change_speed_mode(joystick, 1, now, log)
        self.speed_up_prev = buttons.speed_up

        if not crash_active and buttons.speed_down and not self.speed_down_prev:
            await self._change_speed_mode(joystick, -1, now, log)
        self.speed_down_prev = buttons.speed_down

    async def _change_speed_mode(self, joystick: Any, direction: int, now: float, log: LogCallback) -> None:
        previous_speed_mode = self.speed_mode
        self.speed_mode = await change_speed_mode_with_feedback(joystick, self.speed_mode, direction)
        if self.speed_mode != previous_speed_mode:
            self.drive_rumble_paused_until = now + (SPEED_RUMBLE_DURATION_MS / 1000)
        ratio = int(SPEED_MODE_RATIOS[self.speed_mode] * 100)
        log(f"speed mode={self.speed_mode} trigger_to_power={ratio}%")

    def _read_motion(
        self,
        joystick: Any,
        brake: bool,
        crash_active: bool,
    ) -> TumblerMotionState:
        if brake:
            forward_pressure, reverse_pressure = read_trigger_pressures(joystick, self.pad)
            return TumblerMotionState(0, 0.0, forward_pressure, reverse_pressure, brake=True)
        if crash_active:
            return TumblerMotionState(0, 0.0, 0.0, 0.0, brake=False)
        throttle, trigger_pressure, forward_pressure, reverse_pressure = read_drive_state(
            joystick,
            self.pad,
            self.model.max_drive,
            self.speed_mode,
        )
        return TumblerMotionState(throttle, trigger_pressure, forward_pressure, reverse_pressure, brake=False)

    def _update_crash_lockout(
        self,
        control: LowLevelControl,
        motion: TumblerMotionState,
        brake_pressed: bool,
        crash_active: bool,
        now: float,
        *,
        log: LogCallback,
    ) -> tuple[bool, TumblerMotionState]:
        status_reports = control.drain_status_reports()
        crash_started = False
        if status_reports:
            for _raw, status_flags in status_reports:
                crash_started = (
                    self.crash_lockout.update(
                        motion.throttle,
                        self.model.max_drive,
                        now,
                        impact="impact" in status_flags,
                        enabled=not brake_pressed,
                    )
                    or crash_started
                )
        else:
            self.crash_lockout.update(
                motion.throttle,
                self.model.max_drive,
                now,
                impact=None,
                enabled=not brake_pressed,
            )

        if not crash_active and crash_started:
            log(f"crash detected: controls locked for {CRASH_LOCKOUT_S:.1f}s")
            self.boost_until = 0.0
            self.boost_feedback_at = 0.0
            self.drive_rumble_paused_until = 0.0
            return True, TumblerMotionState(0, 0.0, 0.0, 0.0, brake=False)

        return crash_active, motion

    def _update_reverse_state(self, throttle: int, now: float) -> None:
        if throttle < 0:
            if self.reverse_led_started_at is None:
                self.reverse_led_started_at = now
        else:
            self.reverse_led_started_at = None

    def _update_boost(
        self,
        joystick: Any,
        buttons: TumblerButtons,
        brake: bool,
        crash_active: bool,
        now: float,
        *,
        log: LogCallback,
    ) -> None:
        if not crash_active and buttons.boost and not self.boost_prev and now >= self.boost_ready_at and not brake:
            self.boost_until = now + self.boost_hold
            self.boost_feedback_at = now + BOOST_FEEDBACK_DELAY_S
            self.boost_ready_at = self.boost_until + self.boost_cooldown
            log(f"boost fired, ready again in {self.boost_hold + self.boost_cooldown:.1f}s")
        elif not crash_active and buttons.boost and not self.boost_prev:
            if brake:
                log("boost unavailable while braking")
            else:
                log(f"boost not ready ({self.boost_ready_at - now:.1f}s left)")
            self.boost_unavailable_feedback.trigger(joystick, now)
        self.boost_prev = buttons.boost
        if brake or crash_active:
            self.boost_until = 0.0
            self.boost_feedback_at = 0.0

    def _update_manual_effects(self, buttons: TumblerButtons, crash_active: bool, now: float) -> None:
        if not crash_active and buttons.front_lights and not self.front_lights_prev:
            self.lights.toggle_front_lights()
        self.front_lights_prev = buttons.front_lights

        if not crash_active and buttons.attack and not self.attack_prev:
            self.attack_signal.trigger(now)
        self.attack_prev = buttons.attack
