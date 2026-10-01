"""Stage, validate and publish the complete native release artifact set."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {
    "macos-arm64": ("mac", ["dmg", "zip"]),
    "macos-x64": ("mac", ["dmg", "zip"]),
    "windows-x64": ("win", ["exe"]),
    "linux-x64": ("linux", ["AppImage", "deb"]),
}
BINARY = "lego-technic-gamepad-bridge"
EXECUTABLE_MODE = 0o755
RELEASE_FIELDS = "isDraft,targetCommitish,assets"


def validate_identity(version: str, commit: str) -> None:
    """Restrict identifiers used in filenames, tags and release API requests."""
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError(f"Invalid release version: {version}")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Release commit must be a full Git SHA")


def asset_names(version: str, target: str) -> list[str]:
    """Return the exact required distribution filenames for one native target."""
    host, extensions = TARGETS[target]
    arch = target.rsplit("-", 1)[1]
    package_arch = {"deb": "amd64", "AppImage": "x86_64"}
    archive = "zip" if target.startswith("windows-") else "tar.gz"
    return [
        f"{BINARY}-v{version}-{target}.{archive}",
        *(f"Axle-{version}-{host}-{package_arch.get(extension, arch)}.{extension}" for extension in extensions),
        *(["latest.yml"] if target == "windows-x64" else ["latest-linux.yml"] if target == "linux-x64" else []),
    ]


def update_metadata(directory: Path, version: str, target: str) -> dict[str, Any]:
    """Produce electron-updater metadata bound to the exact verified installer bytes.

    JSON is valid YAML; generating it here avoids merging per-architecture macOS
    feeds (macOS uses manual installation until Developer ID signing is available).
    Full downloads need no blockmaps. Linux automatic updates use only AppImage.
    """
    name = f"Axle-{version}-win-x64.exe" if target == "windows-x64" else f"Axle-{version}-linux-x86_64.AppImage"
    path = directory / name
    describe(path)
    digest = hashlib.sha512()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    checksum = base64.b64encode(digest.digest()).decode("ascii")
    return {
        "version": version,
        "files": [{"url": name, "sha512": checksum, "size": path.stat().st_size}],
        "path": name,
        "sha512": checksum,
    }


def describe(path: Path) -> dict[str, Any]:
    """Hash a nonempty regular artifact without following symlinks."""
    if path.is_symlink() or not path.is_file() or not path.stat().st_size:
        raise ValueError(f"Missing or empty artifact: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"name": path.name, "size": path.stat().st_size, "sha256": digest.hexdigest()}


def write_json(path: Path, value: Any) -> None:
    """Write stable, human-readable release metadata."""
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def stage(root: Path, output: Path, version: str, commit: str, target: str) -> None:
    """Archive the CLI, preserve executable permissions and stage desktop installers."""
    validate_identity(version, commit)
    names = asset_names(version, target)
    output.mkdir(parents=True, exist_ok=True)
    binary_name = BINARY + (".exe" if target.startswith("windows-") else "")
    binary = root / "dist" / binary_name
    describe(binary)
    archive_path = output / names[0]
    if target.startswith("windows-"):
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(binary, binary_name)
            archive.write(root / "LICENSE", "LICENSE")
        with zipfile.ZipFile(archive_path) as archive:
            if archive.testzip() is not None or archive.read(binary_name) != binary.read_bytes():
                raise ValueError("Terminal ZIP verification failed")
    else:
        with tarfile.open(archive_path, "w:gz") as archive:
            info = archive.gettarinfo(str(binary), arcname=binary_name)
            info.mode = EXECUTABLE_MODE
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            with binary.open("rb") as stream:
                archive.addfile(info, stream)
            archive.add(root / "LICENSE", arcname="LICENSE")
        with tarfile.open(archive_path) as archive:
            member = archive.getmember(binary_name)
            extracted = archive.extractfile(member)
            if member.mode != EXECUTABLE_MODE or extracted is None or extracted.read() != binary.read_bytes():
                raise ValueError("Terminal tarball verification failed")
    for name in names[1:]:
        if name in ("latest.yml", "latest-linux.yml"):
            write_json(output / name, update_metadata(output, version, target))
            continue
        source = root / "ui" / "electron" / "release" / name
        describe(source)
        shutil.copy2(source, output / name)
    write_json(
        output / f"manifest-{target}.json",
        {
            "schema": 1,
            "version": version,
            "commit": commit,
            "target": target,
            "assets": [describe(output / name) for name in names],
        },
    )


def verify(directory: Path, version: str, commit: str) -> dict[str, Any]:
    """Reject missing, foreign, duplicated or modified assets before publication."""
    validate_identity(version, commit)
    expected_files = {f"manifest-{target}.json" for target in TARGETS}
    all_assets = []
    for target in TARGETS:
        manifest_path = directory / f"manifest-{target}.json"
        describe(manifest_path)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        identity = {key: manifest.get(key) for key in ("schema", "version", "commit", "target")}
        if identity != {"schema": 1, "version": version, "commit": commit, "target": target}:
            raise ValueError(f"Wrong release identity: {manifest_path.name}")
        expected = asset_names(version, target)
        entries = manifest.get("assets", [])
        if not isinstance(entries, list) or [entry.get("name") for entry in entries] != expected:
            raise ValueError(f"Wrong artifact inventory: {target}")
        for entry in entries:
            if describe(directory / entry["name"]) != entry:
                raise ValueError(f"Artifact checksum or size mismatch: {entry['name']}")
        if target in ("windows-x64", "linux-x64"):
            metadata = json.loads((directory / expected[-1]).read_text(encoding="utf-8"))
            if metadata != update_metadata(directory, version, target):
                raise ValueError(f"Update metadata does not match its installer: {target}")
        all_assets.extend(entries)
        expected_files.update(expected)
    actual_files = {path.name for path in directory.iterdir()}
    # Permit metadata from a previous verification; it is always regenerated.
    if actual_files - {"SHA256SUMS", "release-manifest.json"} != expected_files:
        raise ValueError("Release directory contains unexpected or missing files")
    result: dict[str, Any] = {
        "schema": 1,
        "version": version,
        "commit": commit,
        "assets": sorted(all_assets, key=lambda entry: entry["name"]),
    }
    write_json(directory / "release-manifest.json", result)
    checksums = [*result["assets"], describe(directory / "release-manifest.json")]
    (directory / "SHA256SUMS").write_text(
        "".join(f"{item['sha256']}  {item['name']}\n" for item in checksums), encoding="utf-8"
    )
    return result


def gh(*arguments: str) -> str:
    """Run GitHub CLI with checked exit status and argument-safe invocation."""
    return subprocess.run(["gh", *arguments], check=True, capture_output=True, text=True).stdout


def publish(directory: Path, version: str, commit: str) -> None:
    """Upload into a draft, publishing only after every asset has arrived."""
    manifest = verify(directory, version, commit)
    tag = f"v{version}"
    repository = os.environ["GH_REPO"]
    response = subprocess.run(
        ["gh", "release", "view", tag, "--json", RELEASE_FIELDS], capture_output=True, text=True, check=False
    )
    existing = None
    if response.returncode == 0:
        existing = json.loads(response.stdout)
    elif response.stderr.strip() != "release not found":
        raise RuntimeError(f"Cannot look up release: {response.stderr}")
    names = [entry["name"] for entry in manifest["assets"]] + ["release-manifest.json", "SHA256SUMS"]
    if existing is not None:
        if existing["targetCommitish"] != commit:
            raise ValueError("Existing release belongs to a different commit; refusing to overwrite")
        remote_names = {asset["name"] for asset in existing["assets"]}
        if not existing["isDraft"]:
            with tempfile.TemporaryDirectory() as temporary:
                gh("release", "download", tag, "--pattern", "release-manifest.json", "--dir", temporary)
                remote = json.loads((Path(temporary) / "release-manifest.json").read_text(encoding="utf-8"))
            if remote != manifest or remote_names != set(names):
                raise ValueError("Published release differs from this build; published assets are immutable")
            resolved = gh("api", f"repos/{repository}/commits/{tag}", "--jq", ".sha").strip()
            if resolved != commit:
                raise ValueError("Published tag points to a different commit")
            print(f"{tag} is already published with the same artifact manifest")
            return
        if remote_names - set(names):
            raise ValueError("Existing draft contains unexpected assets")
    # Check tags for new releases and resumed drafts alike.
    tag_result = subprocess.run(
        ["gh", "api", f"repos/{repository}/commits/{tag}", "--jq", ".sha"],
        capture_output=True,
        text=True,
        check=False,
    )
    if tag_result.returncode == 0 and tag_result.stdout.strip() != commit:
        raise ValueError("Existing tag points to a different commit")
    if tag_result.returncode and "(HTTP 404)" not in tag_result.stderr and "(HTTP 422)" not in tag_result.stderr:
        raise RuntimeError(f"Cannot verify release tag: {tag_result.stderr}")
    if existing is None:
        gh("release", "create", tag, "--draft", "--target", commit, "--title", f"Axle {version}")
    gh("release", "upload", tag, *(str(directory / name) for name in names), "--clobber")
    # gh release view also resolves draft tags; the REST tags endpoint only finds published releases.
    uploaded = json.loads(gh("release", "view", tag, "--json", RELEASE_FIELDS))
    expected_sizes = {name: (directory / name).stat().st_size for name in names}
    actual_sizes = {asset["name"]: asset["size"] for asset in uploaded["assets"] if asset["state"] == "uploaded"}
    if not uploaded["isDraft"] or actual_sizes != expected_sizes:
        raise ValueError("Draft upload is incomplete; leaving it unpublished")
    notes = (
        f"Commit: `{commit}`\n\n"
        "Terminal: macOS arm64/x64, Windows x64, Linux x64.\n\n"
        "Axle desktop: macOS DMG/ZIP, Windows installer, Linux deb and AppImage. "
        "Use the Linux x64 AppImage on Steam Deck. Python is bundled.\n\n"
        "Verify downloads with SHA256SUMS. macOS desktop builds are ad-hoc signed and are not "
        "notarized by Apple; Windows packages are unsigned.\n\n"
        "**First launch on macOS:** Copy Axle to Applications and open it. If Apple cannot verify "
        "Axle, dismiss the alert with Done, then open **System Settings → Privacy & Security**. "
        "Scroll to Security, choose **Open Anyway** for Axle, and confirm Open. Authenticate if asked. "
        "If the option is missing, try opening Axle again; it is available for about an hour after "
        "the attempted launch. This approves only Axle. Builds without Apple Developer credentials "
        "cannot remove this approval requirement. "
        "[Apple's instructions](https://support.apple.com/en-us/102445).\n\n"
        "**First launch on Steam Deck:** In Desktop Mode, open the AppImage's Properties → "
        "Permissions, enable **Is executable**, then open it. Browser downloads do not preserve "
        "the executable permission. If adding Axle to Steam, leave forced Proton compatibility "
        "disabled: this is a native Linux app.\n\n"
        "Hardware behavior requires a compatible controller, Bluetooth adapter and hub.\n"
    )
    with tempfile.TemporaryDirectory() as temporary:
        notes_path = Path(temporary) / "notes.md"
        notes_path.write_text(notes, encoding="utf-8")
        gh("release", "edit", tag, "--notes-file", str(notes_path), "--draft=false")
    print(f"Published {tag}")


def main() -> None:
    """Run the requested stage of the release artifact contract."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("stage", "verify", "publish"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--directory", type=Path, default=ROOT / "release-assets")
    parser.add_argument("--target", choices=TARGETS)
    args = parser.parse_args()
    if args.command == "stage":
        if not args.target:
            parser.error("stage requires --target")
        stage(ROOT, args.directory, args.version, args.commit, args.target)
    elif args.command == "verify":
        verify(args.directory, args.version, args.commit)
        print("Verified all four native targets, eleven distribution assets and two update feeds")
    else:
        publish(args.directory, args.version, args.commit)


if __name__ == "__main__":
    main()
