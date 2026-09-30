"""Data-backed gamepad profile loading and matching."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .. import paths

CONFIG_DIR = paths.CONFIG_DIR
AUTO_GAMEPAD_PROFILE = "auto"
AUTO_GAMEPAD_CANDIDATES = ("dualsense", "steamdeck", "generic_sdl")


@dataclass(frozen=True)
class GamepadProfileChoice:
    """One selectable gamepad profile shown by external frontends."""

    profile_id: str
    name: str


def _need(mapping: dict[str, Any], key: str, owner: str, what: str) -> Any:
    """Look up a profile key, naming the alternatives when it is missing."""
    if key not in mapping:
        raise RuntimeError(f"{owner} has no {what} '{key}' (has: {', '.join(mapping) or 'none'})")
    return mapping[key]


def _load(kind: str, name: str) -> dict[str, Any]:
    path = CONFIG_DIR / kind / f"{name}.json"
    if not path.exists():
        available = sorted(p.stem for p in (CONFIG_DIR / kind).glob("*.json"))
        raise RuntimeError(f"No {kind} profile '{name}'. Available: {', '.join(available) or 'none'}")
    loaded: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return loaded


class GamepadProfile:
    """Button and axis indices for one controller."""

    def __init__(self, data: dict[str, Any], name: str) -> None:
        """Read one gamepad profile."""
        self.profile_id = name
        self.name: str = data["name"]
        self.buttons: dict[str, int] = data["buttons"]
        self.axes: dict[str, int] = data["axes"]
        self.deadzone: float = data["deadzone"]
        self.trigger_deadzone: float = data.get("trigger_deadzone", self.deadzone)
        self.triggers_rest_negative: bool = data["triggers_rest_negative"]
        self.supports_led: bool = bool(data.get("supports_led", False))
        self.controls: str = data["controls"]
        self.name_hints: tuple[str, ...] = tuple(str(hint).lower() for hint in data.get("name_hints", []))
        self.exclude_name_hints: tuple[str, ...] = tuple(
            str(hint).lower() for hint in data.get("exclude_name_hints", [])
        )

    @classmethod
    def load(cls, name: str) -> "GamepadProfile":
        """Load config/gamepads/<name>.json."""
        return cls(_load("gamepads", name), name)

    def button(self, action: str) -> int:
        """Button index for an action, or an error naming what this pad has."""
        return int(_need(self.buttons, action, self.name, "button"))

    def optional_button(self, action: str) -> int | None:
        """Return a button index when a profile defines an optional action."""
        if action not in self.buttons:
            return None
        return int(self.buttons[action])

    def axis(self, action: str) -> int:
        """Axis index for an action, or an error naming what this pad has."""
        return int(_need(self.axes, action, self.name, "axis"))

    def matches_device_name(self, device_name: str) -> bool:
        """Return whether a pygame joystick name matches this profile."""
        lowered = device_name.lower()
        if any(hint in lowered for hint in self.exclude_name_hints):
            return False
        if not self.name_hints:
            return True
        return any(hint in lowered for hint in self.name_hints)


def gamepad_profile_candidates(name: str) -> list[GamepadProfile]:
    """Return one or more gamepad profiles to try for a CLI profile name."""
    if name != AUTO_GAMEPAD_PROFILE:
        return [GamepadProfile.load(name)]
    return [GamepadProfile.load(candidate) for candidate in AUTO_GAMEPAD_CANDIDATES]


def available_gamepad_choices() -> list[GamepadProfileChoice]:
    """Return all gamepad profiles available under config/gamepads."""
    choices = []
    for path in sorted((CONFIG_DIR / "gamepads").glob("*.json")):
        data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        choices.append(GamepadProfileChoice(profile_id=path.stem, name=str(data.get("name", path.stem))))
    if not choices:
        raise RuntimeError(f"No gamepad profiles found in {CONFIG_DIR / 'gamepads'}")
    return choices
