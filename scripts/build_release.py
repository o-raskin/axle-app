"""Build the native terminal executable and Electron bridge with one recipe."""

from __future__ import annotations

import argparse
import os
import platform
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_NAME = "lego-technic-gamepad-bridge"
RESOURCE_PATHS = ("config/models", "config/gamepads", "beep.mp3")
SDL_MODULES = ("audio", "controller", "sdl2")


def executable_name(name: str, host: str = sys.platform) -> str:
    """Choose the native executable suffix without accepting path traversal."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name) or name.endswith(".exe"):
        raise ValueError("--name must be a filename without an .exe suffix")
    return f"{name}.exe" if host == "win32" else name


def build_command(root: Path, output_dir: Path, name: str, host: str = sys.platform) -> list[str]:
    """Return the shared PyInstaller recipe, including every runtime resource."""
    executable_name(name, host)
    if host not in {"darwin", "linux", "win32"}:
        raise ValueError(f"Unsupported release host: {host}")
    for relative in RESOURCE_PATHS:
        path = root / relative
        if not path.exists() or (path.is_dir() and not list(path.glob("*.json"))):
            raise ValueError(f"Missing release resource: {path}")
    work_dir = root / "build" / "pyinstaller" / f"{host}-{platform.machine()}"
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--clean",
        "--noconfirm",
        "--onefile",
        "--console",
        "--noupx",
        "--name",
        name,
        "--distpath",
        str(output_dir),
        "--workpath",
        str(work_dir / "work"),
        "--specpath",
        str(work_dir),
    ]
    for relative in RESOURCE_PATHS:
        destination = relative if relative.startswith("config/") else "."
        command.extend(("--add-data", f"{root / relative}:{destination}"))
    command.extend(("--collect-all", "bleak"))
    for module in SDL_MODULES:
        command.extend(("--hidden-import", f"pygame._sdl2.{module}"))
    command.append(str(root / "gamepad_bridge.py"))
    return command


def main() -> None:
    """Build with dependencies already installed in the current interpreter."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    parser.add_argument("--name", default=DEFAULT_NAME)
    args = parser.parse_args()
    try:
        command = build_command(ROOT, args.output_dir.resolve(), args.name)
    except ValueError as error:
        parser.error(str(error))
    environment = os.environ.copy()
    environment["PYINSTALLER_CONFIG_DIR"] = str(ROOT / "build" / "pyinstaller" / "cache")
    subprocess.run(command, check=True, cwd=ROOT, env=environment)
    binary = args.output_dir.resolve() / executable_name(args.name)
    if not binary.is_file():
        raise RuntimeError(f"PyInstaller did not produce {binary}")
    print(f"Built {binary}")


if __name__ == "__main__":
    main()
