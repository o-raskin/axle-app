"""Repository-local paths used by scripts and runtime modules."""

from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = PROJECT_ROOT / "config"
PORT_MAP_PATH = CONFIG_DIR / "port_map.json"
REVERSE_BEEP_PATH = PROJECT_ROOT / "beep.mp3"
HUB_SCHEME_PATH = PROJECT_ROOT / "hub_scheme.txt"


def project_path(*parts: str) -> Path:
    """Return a path rooted at the repository directory."""
    return PROJECT_ROOT.joinpath(*parts)
