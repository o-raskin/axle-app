"""Pure time-based lighting/effect state for the model."""

from __future__ import annotations

from dataclasses import dataclass

from ...settings import ATTACK_SIGNAL_DURATION_S, FRONT_LIGHTS_OFF_DELAY_S, ROCKET_LIGHTS_BLINK_INTERVAL_S


@dataclass
class AttackSignal:
    """Timed PLAYVM flicker signal started by the configured attack button."""

    active_from: float | None = None
    active_until: float | None = None

    def trigger(self, now: float) -> None:
        """Start a signal unless one is already active."""
        if not self.is_active(now):
            self.active_from = now
            self.active_until = now + ATTACK_SIGNAL_DURATION_S

    def is_active(self, now: float) -> bool:
        """Return whether the signal is currently active."""
        if self.active_from is None or self.active_until is None:
            return False
        if now < self.active_until:
            return True
        self.active_from = None
        self.active_until = None
        return False


@dataclass
class AutomaticLights:
    """Derive PLAYVM light bits from drive direction and monotonic time."""

    front_lights_manual_on: bool = False
    front_lights_off_at: float | None = None
    front_lights_auto_on: bool = False
    rocket_lights_started_at: float | None = None

    def toggle_front_lights(self) -> None:
        """Flip the manual front-light state used when motion does not override it."""
        self.front_lights_manual_on = not self.front_lights_manual_on
        self.front_lights_auto_on = False
        self.front_lights_off_at = None

    def state_for(self, speed: int, now: float) -> tuple[bool, bool]:
        """Return ``(front_lights_on, rocket_lights_on)`` for the current speed."""
        if speed > 0:
            self.front_lights_off_at = None
            self.front_lights_auto_on = True
            self.rocket_lights_started_at = None
            return True, False

        if speed < 0:
            self.front_lights_off_at = None
            self.front_lights_auto_on = False
            if self.rocket_lights_started_at is None:
                self.rocket_lights_started_at = now
            phase = int((now - self.rocket_lights_started_at) // ROCKET_LIGHTS_BLINK_INTERVAL_S)
            return False, phase % 2 == 1

        self.rocket_lights_started_at = None
        if self.front_lights_auto_on and self.front_lights_off_at is None:
            self.front_lights_off_at = now + FRONT_LIGHTS_OFF_DELAY_S

        if self.front_lights_off_at is not None and now < self.front_lights_off_at:
            return True, False

        if self.front_lights_off_at is not None:
            self.front_lights_off_at = None
            self.front_lights_auto_on = False
            self.front_lights_manual_on = False
            return False, False

        return self.front_lights_manual_on, False
