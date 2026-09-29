"""Sony DualSense gamepad-specific profile and name matching."""

from __future__ import annotations

from ..settings import DUALSENSE_GAMEPAD_HINTS, NON_DUALSENSE_GAMEPAD_HINTS
from .profile_loader import GamepadProfile

PROFILE_ID = "dualsense"


def profile() -> GamepadProfile:
    """Load the Sony DualSense gamepad profile."""
    return GamepadProfile.load(PROFILE_ID)


def matches_device_name(device_name: str) -> bool:
    """Return whether a pygame joystick name looks like a DualSense controller."""
    lowered = device_name.lower()
    if any(hint in lowered for hint in NON_DUALSENSE_GAMEPAD_HINTS):
        return False
    return any(hint in lowered for hint in DUALSENSE_GAMEPAD_HINTS)
