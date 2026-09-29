"""Steam Deck and Steam Input specific SDL process hints."""

from __future__ import annotations

import os

SDL_HINTS = {
    "SDL_ENABLE_STEAM_CONTROLLERS": "1",
    "SDL_GAMECONTROLLER_ALLOW_STEAM_VIRTUAL_GAMEPAD": "1",
    "SDL_GAMECONTROLLER_USE_BUTTON_LABELS": "0",
    "SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS": "1",
    "SDL_JOYSTICK_HIDAPI": "1",
    "SDL_JOYSTICK_HIDAPI_STEAM": "1",
    "SDL_JOYSTICK_HIDAPI_STEAMDECK": "1",
}


def apply_sdl_hints() -> None:
    """Apply Steam Input SDL defaults unless the user already configured them."""
    for name, value in SDL_HINTS.items():
        os.environ.setdefault(name, value)
