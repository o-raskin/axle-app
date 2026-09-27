"""Application paths for source checkouts and frozen release builds."""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_SUPPORT_DIR_NAME = "LEGO Technic Gamepad Bridge"
HOME_ENV = "LEGO_BRIDGE_HOME"

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BUNDLE_ROOT = Path(getattr(sys, "_MEIPASS", PROJECT_ROOT))
CONFIG_DIR = BUNDLE_ROOT / "config"
REVERSE_BEEP_PATH = BUNDLE_ROOT / "beep.mp3"


def is_frozen() -> bool:
    """Return whether the process is running from a bundled executable."""
    return bool(getattr(sys, "frozen", False))


def _default_runtime_dir() -> Path:
    override = os.environ.get(HOME_ENV)
    if override:
        return Path(override).expanduser()
    if is_frozen() and sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_SUPPORT_DIR_NAME
    if is_frozen():
        return Path.home() / ".lego-technic-gamepad-bridge"
    return PROJECT_ROOT


RUNTIME_DIR = _default_runtime_dir()
PORT_MAP_PATH = RUNTIME_DIR / "config" / "port_map.json"
HUB_SCHEME_PATH = RUNTIME_DIR / "hub_scheme.txt"


def project_path(*parts: str) -> Path:
    """Return a path rooted at bundled assets in release builds or the checkout in source runs."""
    return BUNDLE_ROOT.joinpath(*parts)
