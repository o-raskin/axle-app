"""Validate local profile files before their values reach device commands."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


def load_profile(config_dir: Path, kind: str, name: str) -> dict[str, Any]:
    """Load one JSON object by filename, without allowing paths as profile ids."""
    if not name or name in {".", ".."} or any(character in name for character in ("/", "\\", ":", "\x00")):
        raise RuntimeError(f"Invalid {kind} profile id: {name!r}")
    path = config_dir / kind / f"{name}.json"
    if not path.is_file():
        available = sorted(p.stem for p in (config_dir / kind).glob("*.json"))
        raise RuntimeError(f"No {kind} profile '{name}'. Available: {', '.join(available) or 'none'}")
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise RuntimeError(f"Could not read {kind} profile '{name}': {exc}") from exc
    return object_mapping(loaded, name, "profile")


def object_mapping(value: Any, owner: str, field: str) -> dict[str, Any]:
    """Require a JSON object for a keyed profile section."""
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise RuntimeError(f"{owner} {field} must be an object")
    return dict(value)


def number(value: Any, owner: str, field: str, minimum: float = 0.0, maximum: float | None = None) -> float:
    """Require a finite numeric setting within its supported range."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError(f"{owner} {field} must be a number")
    try:
        numeric = float(value)
    except OverflowError as exc:
        raise RuntimeError(f"{owner} {field} is outside the supported range") from exc
    if not math.isfinite(numeric) or numeric < minimum or (maximum is not None and numeric > maximum):
        raise RuntimeError(f"{owner} {field} is outside the supported range")
    return numeric


def integer(value: Any, owner: str, field: str, maximum: int | None = None) -> int:
    """Require a nonnegative integer setting, excluding booleans and truncation."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or (maximum is not None and value > maximum):
        raise RuntimeError(f"{owner} {field} must be a nonnegative integer within the supported range")
    return int(value)


def integer_mapping(value: Any, owner: str, field: str, maximum: int | None = None) -> dict[str, int]:
    """Validate button/axis indices or byte-sized command bits."""
    mapping = object_mapping(value, owner, field)
    return {key: integer(item, owner, f"{field}.{key}", maximum) for key, item in mapping.items()}
