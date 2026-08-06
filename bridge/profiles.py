"""Model and gamepad profiles.

The hub tells us its topology — which port is a drive motor, which is the Play VM — so ports are
never configured. What it does NOT tell us is what the command bits MEAN: that lives in the VM
program and in the app, and differs per model. 0x04 is lights-off on the Porsche and boost on the
Tumbler. So the bit map has to come from a profile, and getting it wrong moves the car.
"""

import json
from pathlib import Path
from typing import Any

CONFIG_DIR = Path("config")
PORT_MAP_PATH = CONFIG_DIR / "port_map.json"


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


class ModelProfile:
    """Per-model command semantics. Missing keys raise rather than defaulting to something plausible."""

    def __init__(self, data: dict[str, Any], name: str) -> None:
        """Read one model profile; missing keys raise here rather than at drive time."""
        self.name: str = data["name"]
        self.program_id: int = data["program_id"]
        self._control: dict[str, int] = data["control"]
        self._control2: dict[str, int] = data["control2"]
        self._pace: dict[str, float] = data["calibration_pace_s"]
        self._boost: dict[str, float] | None = data.get("boost")
        self.max_drive: int = data["limits"]["drive"]
        self.max_steering: int = data["limits"]["steering"]

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


class GamepadProfile:
    """Button and axis indices for one controller."""

    def __init__(self, data: dict[str, Any], name: str) -> None:
        """Read one gamepad profile."""
        self.name: str = data["name"]
        self.buttons: dict[str, int] = data["buttons"]
        self.axes: dict[str, int] = data["axes"]
        self.deadzone: float = data["deadzone"]
        # Measured for this pad, not sniffed at runtime: DualSense triggers idle at -1.0.
        self.triggers_rest_negative: bool = data["triggers_rest_negative"]
        self.controls: str = data["controls"]

    @classmethod
    def load(cls, name: str) -> "GamepadProfile":
        """Load config/gamepads/<name>.json."""
        return cls(_load("gamepads", name), name)

    def button(self, action: str) -> int:
        """Button index for an action, or an error naming what this pad has."""
        return int(_need(self.buttons, action, self.name, "button"))

    def axis(self, action: str) -> int:
        """Axis index for an action, or an error naming what this pad has."""
        return int(_need(self.axes, action, self.name, "axis"))
