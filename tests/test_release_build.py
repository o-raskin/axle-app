from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from scripts import build_release as builder


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    for category in ("models", "gamepads"):
        directory = tmp_path / "config" / category
        directory.mkdir(parents=True)
        (directory / "test.json").write_text('{"name":"Test"}')
    (tmp_path / "beep.mp3").write_bytes(b"sound")
    (tmp_path / "gamepad_bridge.py").write_text("print('bridge')")
    return tmp_path


@pytest.mark.parametrize(
    "name", ["../bridge", "bridge/inside", "bridge\\inside", "bridge.exe", "bridge.EXE", "", "-option"]
)
def test_build_names_cannot_escape_the_output_or_duplicate_executable_suffixes(name: str) -> None:
    with pytest.raises(ValueError):
        builder.executable_name(name, "win32")


@pytest.mark.parametrize("name", ["CON", "aux", "NUL.data", "Lpt1", "COM9.txt", "bridge."])
def test_windows_builds_reject_device_names_and_trailing_dots(name: str) -> None:
    with pytest.raises(ValueError, match="Windows filename"):
        builder.executable_name(name, "win32")
    assert builder.executable_name(name, "linux") == name


@pytest.mark.parametrize("damage", ["missing-sound", "empty-profiles", "unsupported-host"])
def test_native_recipe_fails_before_starting_when_resources_or_platform_are_invalid(
    checkout: Path, damage: str
) -> None:
    host = "linux"
    if damage == "missing-sound":
        (checkout / "beep.mp3").unlink()
    elif damage == "empty-profiles":
        (checkout / "config" / "models" / "test.json").unlink()
    else:
        host = "unsupported"
    with pytest.raises(ValueError):
        builder.build_command(checkout, checkout / "output", "bridge", host)


@pytest.mark.parametrize("outcome", ["success", "no-binary", "process-error"])
def test_build_cli_checks_the_generated_executable_and_passes_the_native_recipe(
    checkout: Path, monkeypatch: pytest.MonkeyPatch, outcome: str
) -> None:
    output = checkout / "output"
    monkeypatch.setattr(builder, "ROOT", checkout)
    monkeypatch.setattr(sys, "argv", ["build_release.py", "--output-dir", str(output), "--name", "test-bridge"])
    calls = []

    def build(arguments, **options):
        calls.append(arguments)
        assert options["check"] is True and options["cwd"] == checkout
        assert options["env"]["PYINSTALLER_CONFIG_DIR"] == str(checkout / "build" / "pyinstaller" / "cache")
        assert arguments == builder.build_command(checkout, output.resolve(), "test-bridge")
        if outcome == "process-error":
            raise subprocess.CalledProcessError(1, arguments)
        if outcome == "success":
            output.mkdir()
            (output / builder.executable_name("test-bridge")).write_bytes(b"built executable")
        return subprocess.CompletedProcess(arguments, 0)

    monkeypatch.setattr(builder.subprocess, "run", build)
    if outcome == "process-error":
        with pytest.raises(subprocess.CalledProcessError):
            builder.main()
    elif outcome == "no-binary":
        with pytest.raises(RuntimeError, match="did not produce"):
            builder.main()
    else:
        builder.main()
        assert (output / builder.executable_name("test-bridge")).read_bytes() == b"built executable"
    assert len(calls) == 1


def test_build_cli_reports_invalid_resource_arguments_before_spawning(
    checkout: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(builder, "ROOT", checkout)
    monkeypatch.setattr(sys, "argv", ["build_release.py", "--name", "../invalid"])
    monkeypatch.setattr(
        builder.subprocess, "run", lambda *a, **kw: pytest.fail("Invalid recipes cannot start the builder")
    )
    with pytest.raises(SystemExit) as error:
        builder.main()
    assert error.value.code == 2
