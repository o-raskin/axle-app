from __future__ import annotations

import json
import subprocess
import sys
import types
from pathlib import Path

import pytest

from bridge.protocol import protocol_event, serialize_event
from scripts import verify_release as verifier


def encoded(command: str, payload: object) -> str:
    return "\n".join(
        serialize_event(event)
        for event in [
            protocol_event("command/result", command=command, ok=True, payload=payload),
            protocol_event("exit", reason="complete", exitCode=0),
        ]
    )


@pytest.fixture
def frozen_archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "checkout"
    contents = {
        "beep.mp3": b"sound",
        "config/models/tumbler.json": b'{"name":"Test model"}',
        "config/gamepads/xbox.json": b'{"name":"Test gamepad"}',
        **{f"pygame/_sdl2/{name}.so": b"native module" for name in verifier.SDL_MODULES},
    }
    for name, value in contents.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)
    binary = root / "frozen-bridge"
    binary.write_bytes(b"frozen executable")
    reader_module = types.ModuleType("PyInstaller.archive.readers")

    class ArchiveReader:
        def __init__(self, filename: str):
            assert Path(filename) == binary
            self.toc = contents

        def extract(self, name: str) -> bytes:
            return contents[name]

    reader_module.CArchiveReader = ArchiveReader
    for name in ("PyInstaller", "PyInstaller.archive"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "PyInstaller.archive.readers", reader_module)
    return root, binary, contents


@pytest.mark.parametrize("damage", [None, "missing-resource", "stale-resource", "missing-native"])
def test_frozen_archive_requires_original_resources_and_native_modules(frozen_archive, damage) -> None:
    root, binary, contents = frozen_archive
    if damage == "missing-resource":
        del contents["beep.mp3"]
    elif damage == "stale-resource":
        contents["config/models/tumbler.json"] = b"older profile"
    elif damage == "missing-native":
        del contents["pygame/_sdl2/controller.so"]
    if damage is None:
        verifier.verify_archive(binary, root)
    else:
        with pytest.raises(ValueError, match="bundled"):
            verifier.verify_archive(binary, root)


@pytest.mark.parametrize("failure", [None, "help", "exit-code", "malformed-report", "timeout"])
def test_frozen_verification_is_isolated_and_checks_all_runtime_commands(
    frozen_archive, monkeypatch: pytest.MonkeyPatch, failure: str | None
) -> None:
    root, binary, _ = frozen_archive
    monkeypatch.setenv("LEGO_BRIDGE_PROJECT_ROOT", str(root))
    monkeypatch.setenv("PYTHONPATH", str(root))
    calls = []
    copies = []

    def run(arguments, **options):
        calls.append(arguments[1:])
        copy = Path(arguments[0])
        copies.append(copy)
        assert copy != binary and copy.read_bytes() == binary.read_bytes()
        assert options["cwd"].is_dir() and list(options["cwd"].iterdir()) == []
        assert options["timeout"] == 60
        assert "PYTHONPATH" not in options["env"]
        assert "LEGO_BRIDGE_PROJECT_ROOT" not in options["env"]
        assert options["env"]["LEGO_BRIDGE_HOME"] != str(root)
        assert options["env"]["SDL_VIDEODRIVER"] == "dummy"
        if failure == "timeout":
            raise subprocess.TimeoutExpired(arguments, options["timeout"])
        if failure == "exit-code":
            return subprocess.CompletedProcess(arguments, 7, "", "loader failed")
        if "--help" in arguments:
            output = "bad help" if failure == "help" else "--profiles-json --frontend --discover"
        elif "--profiles-json" in arguments:
            output = encoded(
                "profiles",
                {
                    "models": [{"id": "tumbler", "name": "Test model"}],
                    "gamepads": [{"id": "xbox", "name": "Test gamepad"}, {"id": "auto", "name": "Auto"}],
                    "defaults": {"model": "tumbler", "gamepad": "auto"},
                },
            )
        else:
            report = None if failure == "malformed-report" else "controller_count=0 joystick_count=0"
            output = encoded("gamepadDevices", {"report": report})
        return subprocess.CompletedProcess(arguments, 0, output, "")

    monkeypatch.setattr(verifier.subprocess, "run", run)
    if failure == "timeout":
        with pytest.raises(subprocess.TimeoutExpired):
            verifier.verify_binary(binary, root)
    elif failure:
        with pytest.raises(ValueError):
            verifier.verify_binary(binary, root)
    else:
        verifier.verify_binary(binary, root)
        assert calls == [
            ["--help"],
            ["--frontend", "jsonl", "--profiles-json"],
            ["--frontend", "jsonl", "--gamepad-devices"],
        ]
    # Temporary copies and runtime storage are removed even on a timeout/error.
    assert copies and all(not copy.parent.exists() for copy in copies)
    assert binary.read_bytes() == b"frozen executable"


@pytest.mark.parametrize("damage", ["noise", "empty", "envelope", "boolean-version", "error", "wrong-result", "exit"])
def test_frozen_protocol_rejects_bad_envelopes_and_incomplete_commands(damage: str) -> None:
    events = [
        protocol_event("command/result", command="profiles", ok=True, payload={}),
        protocol_event("exit", reason="complete", exitCode=0),
    ]
    if damage == "envelope":
        events[0]["timestamp"] = {"invalid": True}
    elif damage == "boolean-version":
        events[0]["version"] = True
    elif damage == "error":
        events.insert(0, protocol_event("error", message="failed"))
    elif damage == "wrong-result":
        events[0]["command"] = "other"
    elif damage == "exit":
        events[-1]["exitCode"] = False
    output = "\n".join(json.dumps(event) for event in events)
    if damage == "noise":
        output += "\nnot JSON"
    elif damage == "empty":
        output = "\n \n"
    with pytest.raises(ValueError):
        verifier.verify_command(output, "profiles")
