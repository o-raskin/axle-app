from __future__ import annotations

import json
import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest

from bridge.protocol import profile_catalog_payload, protocol_event, serialize_event
from scripts import release_assets as assets
from scripts.build_release import build_command, executable_name
from scripts.verify_release import expected_profiles, isolated_environment, verify_catalog, verify_command

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


def test_draft_preparation_never_overwrites_a_published_release(release: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GH_REPO", "owner/repo")
    remote = {"isDraft": False, "targetCommitish": "b" * 40, "assets": []}
    monkeypatch.setattr(
        assets.subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(a, 0, json.dumps(remote), "")
    )
    monkeypatch.setattr(assets, "gh", lambda *a: pytest.fail("Published release must not be modified"))
    with pytest.raises(ValueError, match="different commit"):
        assets.prepare_draft(release, VERSION, COMMIT)


def test_lookup_errors_do_not_create_a_release(release: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GH_REPO", "owner/repo")
    monkeypatch.setattr(assets.subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(a, 1, "", "HTTP 403"))
    monkeypatch.setattr(assets, "gh", lambda *a: pytest.fail("Lookup errors must fail closed"))
    with pytest.raises(RuntimeError, match="Cannot look up"):
        assets.prepare_draft(release, VERSION, COMMIT)


@pytest.mark.parametrize("complete", [True, False])
def test_prepared_release_stays_a_draft_after_complete_upload(
    release: Path, monkeypatch: pytest.MonkeyPatch, complete: bool
) -> None:
    monkeypatch.setenv("GH_REPO", "owner/repo")
    calls = []
    remote = {
        "isDraft": True,
        "targetCommitish": COMMIT,
        "assets": [],
        "url": "https://github.com/owner/repo/releases/tag/v0.1.123",
    }

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
        if arguments[:2] == ("release", "download"):
            destination = Path(arguments[arguments.index("--dir") + 1])
            for index, value in enumerate(arguments):
                if value == "--pattern":
                    shutil.copy2(release / arguments[index + 1], destination / arguments[index + 1])
        return ""

    monkeypatch.setattr(assets.subprocess, "run", lookup)
    monkeypatch.setattr(assets, "gh", github)
    if complete:
        assets.prepare_draft(release, VERSION, COMMIT)
        assert remote["isDraft"] is True
        assert not any(call[:2] == ("release", "edit") for call in calls)
    else:
        with pytest.raises(ValueError, match="incomplete"):
            assets.prepare_draft(release, VERSION, COMMIT)
        assert not any(call[:2] == ("release", "edit") for call in calls)
    assert calls[0][:2] == ("release", "upload")


def test_resumed_draft_rejects_a_tag_pointing_elsewhere(release: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GH_REPO", "owner/repo")
    remote = {
        "isDraft": True,
        "targetCommitish": COMMIT,
        "assets": [],
        "url": "https://github.com/owner/repo/releases/tag/v0.1.123",
    }

    def lookup(arguments, **kwargs):
        value = "b" * 40 if "/commits/" in arguments[2] else json.dumps(remote)
        return subprocess.CompletedProcess(arguments, 0, value, "")

    monkeypatch.setattr(assets.subprocess, "run", lookup)
    monkeypatch.setattr(assets, "gh", lambda *a: pytest.fail("Must not mutate a release for the wrong tag"))
    with pytest.raises(ValueError, match="tag points"):
        assets.prepare_draft(release, VERSION, COMMIT)


@pytest.fixture
def build_metadata() -> tuple[dict, dict, list[dict]]:
    run = {
        "id": 123456,
        "run_number": 123,
        "path": ".github/workflows/release.yml",
        "head_branch": "main",
        "head_sha": COMMIT,
        "event": "push",
        "status": "completed",
        "conclusion": "success",
        "repository": {"full_name": "owner/repo"},
        "head_repository": {"full_name": "owner/repo"},
    }
    comparison = {"status": "ahead", "merge_base_commit": {"sha": COMMIT}}
    pages = [
        {
            "artifacts": [
                {
                    "id": 789,
                    "name": "verified-release",
                    "expired": False,
                    "workflow_run": {"id": 123456, "head_sha": COMMIT},
                },
                {"id": 790, "name": "python-coverage", "expired": False},
            ]
        }
    ]
    return run, comparison, pages


def mock_build_api(monkeypatch: pytest.MonkeyPatch, metadata: tuple[dict, dict, list[dict]]) -> list[tuple]:
    run, comparison, pages = metadata
    calls: list[tuple] = []

    def github(*arguments):
        calls.append(arguments)
        if "--paginate" in arguments:
            return json.dumps(pages)
        if "/compare/" in arguments[-1]:
            return json.dumps(comparison)
        return json.dumps(run)

    monkeypatch.setattr(assets, "gh", github)
    return calls


def test_manual_release_selects_immutable_bundle_from_verified_main_build(
    monkeypatch: pytest.MonkeyPatch, build_metadata: tuple[dict, dict, list[dict]]
) -> None:
    calls = mock_build_api(monkeypatch, build_metadata)
    assert assets.select_build("123456", "owner/repo") == {
        "run_id": "123456",
        "run_number": "123",
        "commit": COMMIT,
        "artifact_id": "789",
    }
    assert len(calls) == 3
    assert all(call[0] == "api" for call in calls), "Selection must remain read-only"


@pytest.mark.parametrize("value", ["0", "-1", "1.0", "001", "123\n", "../runs/1", "1;echo unsafe", ""])
def test_untrusted_run_id_is_rejected_before_any_api_request(value: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(assets, "gh", lambda *a: pytest.fail("Invalid run ID must never reach GitHub"))
    with pytest.raises(ValueError, match="positive decimal"):
        assets.select_build(value, "owner/repo")


@pytest.mark.parametrize(
    "field,value",
    [
        ("id", 456),
        ("path", ".github/workflows/lint.yml"),
        ("head_branch", "feature"),
        ("event", "pull_request"),
        ("status", "in_progress"),
        ("conclusion", "failure"),
        ("repository", {"full_name": "foreign/repo"}),
        ("head_repository", {"full_name": "fork/repo"}),
        ("head_sha", "main"),
        ("run_number", True),
    ],
)
def test_only_successful_canonical_main_builds_can_be_selected(
    monkeypatch: pytest.MonkeyPatch, build_metadata: tuple[dict, dict, list[dict]], field: str, value
) -> None:
    build_metadata[0][field] = value
    calls = mock_build_api(monkeypatch, build_metadata)
    with pytest.raises(ValueError):
        assets.select_build("123456", "owner/repo")
    assert len(calls) == 1, "Untrusted runs must fail before artifact selection"


@pytest.mark.parametrize(
    "damage", ["diverged", "wrong-ancestor", "missing", "duplicate", "expired", "wrong-run", "wrong-commit"]
)
def test_missing_or_untrusted_complete_artifacts_fail_before_draft_creation(
    monkeypatch: pytest.MonkeyPatch, build_metadata: tuple[dict, dict, list[dict]], damage: str
) -> None:
    _, comparison, pages = build_metadata
    artifact = pages[0]["artifacts"][0]
    if damage == "diverged":
        comparison["status"] = "diverged"
    elif damage == "wrong-ancestor":
        comparison["merge_base_commit"]["sha"] = "b" * 40
    elif damage == "missing":
        pages[0]["artifacts"].pop(0)
    elif damage == "duplicate":
        pages.append({"artifacts": [artifact]})
    elif damage == "expired":
        artifact["expired"] = True
    elif damage == "wrong-run":
        artifact["workflow_run"]["id"] = 456
    else:
        artifact["workflow_run"]["head_sha"] = "b" * 40
    mock_build_api(monkeypatch, build_metadata)
    with pytest.raises(ValueError):
        assets.select_build("123456", "owner/repo")


def test_complete_bundle_is_bound_to_selected_build_version_and_commit(release: Path) -> None:
    assets.verify(release, VERSION, COMMIT)
    assert assets.verify_build(release, COMMIT, "123") == VERSION


@pytest.mark.parametrize("damage", ["run-number", "commit", "aggregate", "bytes", "missing"])
def test_manual_draft_gate_rejects_mixed_or_corrupt_complete_bundles(release: Path, damage: str) -> None:
    assets.verify(release, VERSION, COMMIT)
    run_number = "124" if damage == "run-number" else "123"
    commit = "b" * 40 if damage == "commit" else COMMIT
    if damage == "aggregate":
        path = release / "release-manifest.json"
        manifest = json.loads(path.read_text())
        manifest["assets"].pop()
        assets.write_json(path, manifest)
    elif damage == "bytes":
        (release / assets.asset_names(VERSION, "linux-x64")[1]).write_bytes(b"corrupted")
    elif damage == "missing":
        (release / "release-manifest.json").unlink()
    with pytest.raises(ValueError):
        assets.verify_build(release, commit, run_number)


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


@pytest.mark.parametrize("name", ["release-manifest.json", "SHA256SUMS"])
def test_verification_cannot_overwrite_files_through_output_symlinks(release: Path, name: str) -> None:
    outside = release.parent / "user-file"
    outside.write_text("preserve my edits")
    (release / name).symlink_to(outside)
    with pytest.raises(ValueError, match="Unsafe artifact output"):
        assets.verify(release, VERSION, COMMIT)
    assert outside.read_text() == "preserve my edits"


@pytest.mark.parametrize("index", [0, 1, -1])
def test_staging_cannot_write_through_preexisting_output_symlinks(release: Path, index: int) -> None:
    name = assets.asset_names(VERSION, "linux-x64")[index]
    outside = release.parent / "user-file"
    outside.write_text("preserve my edits")
    (release / name).unlink()
    (release / name).symlink_to(outside)
    with pytest.raises(ValueError, match="Unsafe artifact output"):
        assets.stage(release.parent / "source", release, VERSION, COMMIT, "linux-x64")
    assert outside.read_text() == "preserve my edits"


@pytest.mark.parametrize("invalid", [None, [], 42, {"schema": True}, {"assets": [None], "schema": 1}])
def test_malformed_manifests_fail_with_validation_errors(release: Path, invalid) -> None:
    path = release / "manifest-linux-x64.json"
    assets.write_json(path, invalid)
    with pytest.raises(ValueError):
        assets.verify(release, VERSION, COMMIT)


def test_remote_readback_detects_same_size_corruption(release: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    name = assets.asset_names(VERSION, "linux-x64")[1]

    def download(*arguments):
        destination = Path(arguments[arguments.index("--dir") + 1])
        content = (release / name).read_bytes()
        (destination / name).write_bytes(b"x" * len(content))
        return ""

    monkeypatch.setattr(assets, "gh", download)
    with pytest.raises(ValueError, match="Remote artifact checksum"):
        assets.verify_remote_assets(release, f"v{VERSION}", [name])


@pytest.mark.parametrize("state", ["new", "draft", "published"])
@pytest.mark.parametrize("corrupt", [False, True])
def test_draft_preparation_checks_remote_bytes_before_trusting_assets(
    release: Path, monkeypatch: pytest.MonkeyPatch, state: str, corrupt: bool
) -> None:
    published = state == "published"
    monkeypatch.setenv("GH_REPO", "owner/repo")
    manifest = assets.verify(release, VERSION, COMMIT)
    names = [entry["name"] for entry in manifest["assets"]] + ["release-manifest.json", "SHA256SUMS"]
    remote = {
        "isDraft": not published,
        "targetCommitish": COMMIT,
        "url": "https://github.com/owner/repo/releases/tag/v0.1.123",
        "assets": [{"name": name, "size": (release / name).stat().st_size, "state": "uploaded"} for name in names],
    }
    mutations = []

    def lookup(arguments, **kwargs):
        if state == "new" and arguments[:3] == ["gh", "release", "view"]:
            return subprocess.CompletedProcess(arguments, 1, "", "release not found")
        value = COMMIT if "/commits/" in arguments[2] else json.dumps(remote)
        return subprocess.CompletedProcess(arguments, 0, value, "")

    def github(*arguments):
        if arguments[0] == "api":
            return COMMIT
        if arguments[:2] == ("release", "create"):
            assert "--draft" in arguments, "Preparation must never create a public release"
            assert arguments[arguments.index("--target") + 1] == COMMIT
            assert "--generate-notes" in arguments
            assert "First launch on Steam Deck" in Path(arguments[arguments.index("--notes-file") + 1]).read_text()
        if arguments[:2] == ("release", "view"):
            return json.dumps(remote)
        if arguments[:2] == ("release", "download"):
            destination = Path(arguments[arguments.index("--dir") + 1])
            for name in names:
                shutil.copy2(release / name, destination / name)
            if corrupt:
                path = destination / assets.asset_names(VERSION, "linux-x64")[1]
                path.write_bytes(b"x" * path.stat().st_size)
        else:
            mutations.append(arguments[:2])
        return ""

    monkeypatch.setattr(assets.subprocess, "run", lookup)
    monkeypatch.setattr(assets, "gh", github)
    if corrupt:
        with pytest.raises(ValueError, match="Remote artifact checksum"):
            assets.prepare_draft(release, VERSION, COMMIT)
        assert ("release", "edit") not in mutations
    else:
        assets.prepare_draft(release, VERSION, COMMIT)
        assert ("release", "edit") not in mutations
    if published:
        assert mutations == [], "Published release verification must remain read-only"
    else:
        assert (("release", "create") in mutations) is (state == "new")


@pytest.mark.parametrize("payload", [None, [], "invalid", 1])
def test_frozen_commands_reject_nonobject_payloads(payload) -> None:
    stdout = "\n".join(
        serialize_event(event)
        for event in [
            protocol_event("command/result", command="profiles", ok=True, payload=payload),
            protocol_event("exit", reason="complete", exitCode=0),
        ]
    )
    with pytest.raises(ValueError, match="payload"):
        verify_command(stdout, "profiles")


@pytest.mark.parametrize("defaults", [None, [], "invalid"])
def test_frozen_catalog_rejects_malformed_defaults(defaults) -> None:
    payload = profile_catalog_payload()
    payload["defaults"] = defaults
    stdout = "\n".join(
        serialize_event(event)
        for event in [
            protocol_event("command/result", command="profiles", ok=True, payload=payload),
            protocol_event("exit", reason="complete", exitCode=0),
        ]
    )
    with pytest.raises(ValueError, match="defaults"):
        verify_catalog(stdout, expected_profiles(assets.ROOT))
