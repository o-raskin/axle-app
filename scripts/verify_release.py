"""Verify a frozen bridge's resources and protocol without requiring hardware."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parents[1]
PROTOCOL_NAME = "lego-technic-bridge"
PROTOCOL_VERSION = 1
SDL_MODULES = ("audio", "controller", "sdl2")


def expected_profiles(root: Path) -> dict[str, dict[str, str]]:
    """Read the source profile manifest for comparison with the frozen catalog."""
    result = {}
    for category in ("models", "gamepads"):
        profiles = {}
        for path in sorted((root / "config" / category).glob("*.json")):
            value = json.loads(path.read_text(encoding="utf-8"))
            profiles[path.stem] = value["name"]
        if not profiles:
            raise ValueError(f"No source profiles for {category}")
        result[category] = profiles
    result["gamepads"]["auto"] = "Auto"
    return result


def verify_archive(binary: Path, root: Path) -> None:
    """Require bundled resources and native SDL modules, not checkout fallbacks."""
    from PyInstaller.archive.readers import CArchiveReader  # noqa: PLC0415 -- only needed for frozen builds

    archive = CArchiveReader(str(binary))
    names = {name.replace("\\", "/"): name for name in archive.toc}
    resources = [
        root / "beep.mp3",
        *(root / "config" / "models").glob("*.json"),
        *(root / "config" / "gamepads").glob("*.json"),
    ]
    for resource in resources:
        relative = resource.relative_to(root).as_posix()
        if relative not in names or archive.extract(names[relative]) != resource.read_bytes():
            raise ValueError(f"Missing or stale bundled resource: {relative}")
    for module in SDL_MODULES:
        prefix = f"pygame/_sdl2/{module}."
        if not any(name.startswith(prefix) and name.endswith((".so", ".pyd")) for name in names):
            raise ValueError(f"Missing bundled SDL module: {module}")


def isolated_environment(environment: Mapping[str, str], runtime_dir: Path) -> dict[str, str]:
    """Remove source/interpreter overrides and isolate all generated user data."""
    result = {
        key: value
        for key, value in environment.items()
        if not key.upper().startswith(("PYTHON", "PYI_", "_PYI_", "LEGO_BRIDGE_"))
        and key.upper() not in {"VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_DEFAULT_ENV"}
    }
    result["LEGO_BRIDGE_HOME"] = str(runtime_dir)
    result["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"
    return result


def verify_command(stdout: str, command: str) -> dict[str, Any]:
    """Validate the event envelope, result and clean exit for a one-shot command."""
    try:
        events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    except json.JSONDecodeError as error:
        raise ValueError("Frozen bridge wrote non-JSON protocol output") from error
    if not events:
        raise ValueError("Frozen bridge emitted no protocol events")
    for event in events:
        if (
            not isinstance(event, dict)
            or event.get("protocol") != PROTOCOL_NAME
            or event.get("version") != PROTOCOL_VERSION
            or not event.get("timestamp")
        ):
            raise ValueError(f"Invalid protocol envelope: {event!r}")
        if event.get("type") == "error":
            raise ValueError(f"Frozen bridge reported an error: {event!r}")
    results = [event for event in events if event.get("type") == "command/result"]
    if len(results) != 1 or results[0].get("command") != command or results[0].get("ok") is not True:
        raise ValueError(f"Missing successful {command} command result")
    final_event = events[-1]
    if final_event.get("type") != "exit" or final_event.get("exitCode") != 0 or final_event.get("reason") != "complete":
        raise ValueError(f"Frozen bridge did not complete the {command} request cleanly")
    payload: dict[str, Any] = results[0].get("payload", {})
    return payload


def verify_catalog(stdout: str, expected: dict[str, dict[str, str]]) -> None:
    """Validate the complete catalog emitted by the frozen CLI."""
    payload = verify_command(stdout, "profiles")
    for category, profiles in expected.items():
        choices = payload.get(category, [])
        if (
            not isinstance(choices, list)
            or not all(isinstance(choice, dict) for choice in choices)
            or len(choices) != len(profiles)
            or {choice.get("id"): choice.get("name") for choice in choices} != profiles
        ):
            raise ValueError(f"Frozen {category} catalog differs from source profiles")
    defaults = payload.get("defaults", {})
    if defaults.get("model") not in expected["models"] or defaults.get("gamepad") not in expected["gamepads"]:
        raise ValueError("Frozen catalog defaults refer to unavailable profiles")


def verify_binary(binary: Path, root: Path = ROOT) -> None:
    """Run only noninteractive commands from a clean directory outside the repo."""
    binary = binary.resolve(strict=True)
    verify_archive(binary, root)
    with tempfile.TemporaryDirectory(prefix="axle-release-smoke-") as temporary:
        temporary_root = Path(temporary)
        copied_binary = temporary_root / binary.name
        shutil.copy2(binary, copied_binary)
        working_dir = temporary_root / "empty-working-directory"
        working_dir.mkdir()
        environment = isolated_environment(os.environ, temporary_root / "user-data")
        environment.update(SDL_VIDEODRIVER="dummy", SDL_AUDIODRIVER="dummy")
        for arguments in (
            ["--help"],
            ["--frontend", "jsonl", "--profiles-json"],
            ["--frontend", "jsonl", "--gamepad-devices"],
        ):
            result = subprocess.run(
                [str(copied_binary), *arguments],
                cwd=working_dir,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=60,
                check=False,
            )
            if result.returncode != 0:
                raise ValueError(
                    f"Frozen bridge {' '.join(arguments)} failed ({result.returncode}): "
                    f"{result.stdout}\n{result.stderr}"
                )
            if arguments == ["--help"]:
                if "--profiles-json" not in result.stdout or "--frontend" not in result.stdout:
                    raise ValueError("Frozen bridge help is missing supported commands")
            elif "--profiles-json" in arguments:
                verify_catalog(result.stdout, expected_profiles(root))
            else:
                report = verify_command(result.stdout, "gamepadDevices").get("report", "")
                if "controller_count=" not in report or "joystick_count=" not in report:
                    raise ValueError("Frozen SDL controller and joystick modules did not initialize")


def main() -> None:
    """Verify the supplied host-native executable, failing on any mismatch."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    verify_binary(args.binary)
    print(f"Verified frozen executable: {args.binary}")


if __name__ == "__main__":
    main()
