from __future__ import annotations

import json
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest

from bridge.protocol import profile_catalog_payload, protocol_event, serialize_event
from scripts import release_assets as assets
from scripts.build_release import build_command, executable_name
from scripts.verify_release import expected_profiles, isolated_environment, verify_catalog

VERSION = "0.1.123"
COMMIT = "a" * 40


@pytest.fixture
def release(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    (source / "dist").mkdir(parents=True)
    packages = source / "ui" / "electron" / "release"
    packages.mkdir(parents=True)
    (source / "LICENSE").write_text("test license", encoding="utf-8")
    output = tmp_path / "release"
    for target in assets.TARGETS:
        binary = assets.BINARY + (".exe" if target.startswith("windows") else "")
        (source / "dist" / binary).write_bytes(b"frozen bridge")
        for name in assets.asset_names(VERSION, target)[1:]:
            (packages / name).write_bytes(name.encode())
        assets.stage(source, output, VERSION, COMMIT, target)
    return output


def test_release_requires_every_target_and_generates_checksums(release: Path) -> None:
    manifest = assets.verify(release, VERSION, COMMIT)
    assert len(manifest["assets"]) == 13
    assert len((release / "SHA256SUMS").read_text().splitlines()) == 14
    assert assets.verify(release, VERSION, COMMIT) == manifest
    for target in assets.TARGETS:
        path = release / assets.asset_names(VERSION, target)[0]
        if path.suffix == ".zip":
            with zipfile.ZipFile(path) as archive:
                assert archive.read(f"{assets.BINARY}.exe") == b"frozen bridge"
                assert "LICENSE" in archive.namelist()
        else:
            with tarfile.open(path) as archive:
                assert archive.getmember(assets.BINARY).mode == 0o755
                assert "LICENSE" in archive.getnames()


@pytest.mark.parametrize("damage", ["version", "checksum", "url", "size"])
def test_update_metadata_must_match_installer_even_with_a_valid_inventory(release: Path, damage: str) -> None:
    path = release / "latest-linux.yml"
    metadata = json.loads(path.read_text())
    if damage == "version":
        metadata["version"] = "9.9.9"
    else:
        key = {"checksum": "sha512", "url": "url", "size": "size"}[damage]
        metadata["files"][0][key] = "https://foreign.invalid/installer" if damage == "url" else 1
    assets.write_json(path, metadata)
    manifest_path = release / "manifest-linux-x64.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["assets"][-1] = assets.describe(path)
    assets.write_json(manifest_path, manifest)
    with pytest.raises(ValueError, match="Update metadata"):
        assets.verify(release, VERSION, COMMIT)


@pytest.mark.parametrize("damage", ["missing", "modified", "foreign", "wrong-commit", "duplicate", "traversal"])
def test_release_rejects_incomplete_or_mixed_builds(release: Path, damage: str) -> None:
    path = release / assets.asset_names(VERSION, "linux-x64")[-1]
    manifest_path = release / "manifest-linux-x64.json"
    manifest = json.loads(manifest_path.read_text())
    if damage == "missing":
        path.unlink()
    elif damage == "modified":
        path.write_bytes(b"corrupted download")
    elif damage == "foreign":
        (release / "unexpected.exe").write_bytes(b"foreign")
    elif damage == "wrong-commit":
        manifest["commit"] = "b" * 40
    elif damage == "duplicate":
        manifest["assets"].append(manifest["assets"][0])
    else:
        manifest["assets"][0]["name"] = "../foreign.exe"
    assets.write_json(manifest_path, manifest)
    with pytest.raises(ValueError):
        assets.verify(release, VERSION, COMMIT)


def test_publisher_never_overwrites_a_published_release(release: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GH_REPO", "owner/repo")
    remote = {"isDraft": False, "targetCommitish": "b" * 40, "assets": []}
    monkeypatch.setattr(
        assets.subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(a, 0, json.dumps(remote), "")
    )
    monkeypatch.setattr(assets, "gh", lambda *a: pytest.fail("Published release must not be modified"))
    with pytest.raises(ValueError, match="different commit"):
        assets.publish(release, VERSION, COMMIT)


def test_lookup_errors_do_not_create_a_release(release: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GH_REPO", "owner/repo")
    monkeypatch.setattr(assets.subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(a, 1, "", "HTTP 403"))
    monkeypatch.setattr(assets, "gh", lambda *a: pytest.fail("Lookup errors must fail closed"))
    with pytest.raises(RuntimeError, match="Cannot look up"):
        assets.publish(release, VERSION, COMMIT)


@pytest.mark.parametrize("complete", [True, False])
def test_draft_publishes_only_after_all_uploads(release: Path, monkeypatch: pytest.MonkeyPatch, complete: bool) -> None:
    monkeypatch.setenv("GH_REPO", "owner/repo")
    calls = []
    remote = {"isDraft": True, "targetCommitish": COMMIT, "assets": []}

    def lookup(arguments, **kwargs):
        if "/commits/" in arguments[2]:
            return subprocess.CompletedProcess(arguments, 1, "", "gh: Not Found (HTTP 404)")
        return subprocess.CompletedProcess(arguments, 0, json.dumps(remote), "")

    def github(*arguments):
        calls.append(arguments)
        if arguments[:2] == ("release", "upload"):
            paths = [Path(value) for value in arguments[3:-1]]
            remote["assets"] = [{"name": path.name, "size": path.stat().st_size, "state": "uploaded"} for path in paths]
            if not complete:
                remote["assets"].pop()
        if arguments[:2] == ("release", "view"):
            return json.dumps(remote)
        return ""

    monkeypatch.setattr(assets.subprocess, "run", lookup)
    monkeypatch.setattr(assets, "gh", github)
    if complete:
        assets.publish(release, VERSION, COMMIT)
        assert calls[-1][:2] == ("release", "edit")
        assert "--draft=false" in calls[-1]
    else:
        with pytest.raises(ValueError, match="incomplete"):
            assets.publish(release, VERSION, COMMIT)
        assert not any(call[:2] == ("release", "edit") for call in calls)
    assert calls[0][:2] == ("release", "upload")


def test_resumed_draft_rejects_a_tag_pointing_elsewhere(release: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GH_REPO", "owner/repo")
    remote = {"isDraft": True, "targetCommitish": COMMIT, "assets": []}

    def lookup(arguments, **kwargs):
        value = "b" * 40 if "/commits/" in arguments[2] else json.dumps(remote)
        return subprocess.CompletedProcess(arguments, 0, value, "")

    monkeypatch.setattr(assets.subprocess, "run", lookup)
    monkeypatch.setattr(assets, "gh", lambda *a: pytest.fail("Must not mutate a release for the wrong tag"))
    with pytest.raises(ValueError, match="tag points"):
        assets.publish(release, VERSION, COMMIT)


def test_native_build_recipe_contains_all_runtime_resources() -> None:
    for host in ("darwin", "linux", "win32"):
        command = build_command(assets.ROOT, assets.ROOT / "dist", assets.BINARY, host)
        assert "--onefile" in command
        assert "--console" in command
        assert "--collect-all" in command and "bleak" in command
        assert all(f"pygame._sdl2.{module}" in command for module in ("audio", "controller", "sdl2"))
        assert sum("config/models:config/models" in part.replace("\\", "/") for part in command) == 1
    assert executable_name(assets.BINARY, "win32").endswith(".exe")
    with pytest.raises(ValueError):
        executable_name("../bad-name")


def test_frozen_catalog_rejects_partial_profile_bundles() -> None:
    payload = profile_catalog_payload()
    events = [
        protocol_event("command/result", command="profiles", ok=True, payload=payload),
        protocol_event("exit", reason="complete", exitCode=0),
    ]

    def encode() -> str:
        return "\n".join(serialize_event(event) for event in events)

    verify_catalog(encode(), expected_profiles(assets.ROOT))
    payload["models"].pop()
    with pytest.raises(ValueError, match="catalog differs"):
        verify_catalog(encode(), expected_profiles(assets.ROOT))


def test_frozen_smoke_removes_development_overrides(tmp_path: Path) -> None:
    env = isolated_environment({"PYTHONHOME": "/python", "LEGO_BRIDGE_HOME": "/source", "PATH": "/bin"}, tmp_path)
    assert "PYTHONHOME" not in env
    assert env["LEGO_BRIDGE_HOME"] == str(tmp_path)
    assert env["PATH"] == "/bin"
