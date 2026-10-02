"""Data-backed LEGO Technic car model profiles."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .. import paths
from ..profile_validation import integer, integer_mapping, load_profile, number, object_mapping

CONFIG_DIR = paths.CONFIG_DIR
DEFAULT_REQUIRED_PORT_ROLES = ("steering", "drive_left", "drive_right", "play_vm")


@dataclass(frozen=True)
class ModelProfileChoice:
    """One selectable model profile shown in the startup menu."""

    profile_id: str
    name: str


def _need(mapping: dict[str, Any], key: str, owner: str, what: str) -> Any:
    """Look up a profile key, naming the alternatives when it is missing."""
    if key not in mapping:
        raise RuntimeError(f"{owner} has no {what} '{key}' (has: {', '.join(mapping) or 'none'})")
    return mapping[key]


def _load(kind: str, name: str) -> dict[str, Any]:
    return load_profile(CONFIG_DIR, kind, name)


def available_model_choices() -> list[ModelProfileChoice]:
    """Return all model profiles available under config/models."""
    choices = []
    for path in sorted((CONFIG_DIR / "models").glob("*.json")):
        data = _load("models", path.stem)
        choices.append(ModelProfileChoice(profile_id=path.stem, name=str(data.get("name", path.stem))))
    if not choices:
        raise RuntimeError(f"No model profiles found in {CONFIG_DIR / 'models'}")
    return choices


class ModelProfile:
    """Per-model command semantics.

    Ports are discovered from the hub, but the command bits and startup pacing belong to the car's
    own PLAYVM program. Missing keys raise instead of defaulting to something that might move the
    model incorrectly.
    """

    def __init__(self, data: dict[str, Any], name: str) -> None:
        """Read one model profile; missing keys raise here rather than at drive time."""
        self.profile_id = name
        self.name: str = data["name"]
        self.program_id = integer(data["program_id"], self.name, "program_id", maximum=255)
        self._control = integer_mapping(data["control"], self.name, "control", maximum=255)
        self._control2 = integer_mapping(data["control2"], self.name, "control2", maximum=255)
        self._pace = {
            key: number(value, self.name, f"calibration_pace_s.{key}")
            for key, value in object_mapping(data["calibration_pace_s"], self.name, "calibration_pace_s").items()
        }
        self._boost: dict[str, float] | None = None
        if data.get("boost") is not None:
            self._boost = {
                key: number(value, self.name, f"boost.{key}")
                for key, value in object_mapping(data["boost"], self.name, "boost").items()
            }
        self.max_drive = integer(data["limits"]["drive"], self.name, "limits.drive", maximum=100)
        self.max_steering = integer(data["limits"]["steering"], self.name, "limits.steering", maximum=100)
        self.required_port_roles: tuple[str, ...] = tuple(data.get("required_ports", DEFAULT_REQUIRED_PORT_ROLES))

    @classmethod
    def load(cls, name: str) -> "ModelProfile":
        """Load config/models/<name>.json."""
        return cls(_load("models", name), name)

    def bit(self, action: str) -> int:
        """Control-byte bit for an action, or an error naming what this model has."""
        return int(_need(self._control, action, self.name, "control bit"))

    def bit2(self, action: str) -> int:
        """Second control byte bit (lights and effects)."""
        return int(_need(self._control2, action, self.name, "control2 bit"))

    def pace(self, step: str) -> float:
        """Seconds to hold before the next calibration command."""
        return float(_need(self._pace, step, self.name, "calibration pace"))

    @property
    def boost(self) -> dict[str, float]:
        """Boost hold and cooldown timings."""
        if self._boost is None:
            raise RuntimeError(f"{self.name} has no boost")
        return self._boost
