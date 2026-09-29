"""Generic SDL/XInput gamepad profile entry point."""

from __future__ import annotations

from .profile_loader import GamepadProfile

PROFILE_ID = "generic_sdl"


def profile() -> GamepadProfile:
    """Load the generic SDL/XInput fallback gamepad profile."""
    return GamepadProfile.load(PROFILE_ID)
