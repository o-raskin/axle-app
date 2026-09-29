"""Steam Deck and Steam Input gamepad profile entry point."""

from __future__ import annotations

from .profile_loader import GamepadProfile

PROFILE_ID = "steamdeck"


def profile() -> GamepadProfile:
    """Load the Steam Deck SDL gamepad profile."""
    return GamepadProfile.load(PROFILE_ID)
