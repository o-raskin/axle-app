# Release pipeline

PRs and releases use the same verification workflow. Pushes to `main` and manual dispatch invoke
`release.yml`; only `main` can publish. No signing credentials or other optional services are needed.

## Native targets

| Runner | Architecture | Terminal | Desktop |
| --- | --- | --- | --- |
| `macos-14` | arm64 | tar.gz | DMG and ZIP |
| `macos-15-intel` | x64 | tar.gz | DMG and ZIP |
| `windows-2022` | x64 | ZIP | NSIS installer |
| `ubuntu-22.04` | x64 | tar.gz | deb and AppImage |

The AppImage is the same file for Linux and Steam Deck. Ubuntu 22.04 provides a conservative glibc
baseline for the frozen Python runtime. This matrix does not claim Windows/Linux ARM support.
Python 3.12 provides pygame wheels on all four hosts; Node.js 24 LTS runs the Electron toolchain.

## Required checks

1. Ruff lint/format, strict mypy, and checksum-pinned actionlint validation of both workflows.
   The full Python test suite also runs on Python 3.9, the minimum development runtime, including
   PLAYVM calibration through live telemetry with cold, delayed and unavailable encoder feedback.
2. Electron lint, type checking, unit tests, production renderer build and fixture UI tests.
3. Python and Electron unit tests on each native host, then one PyInstaller build reused by the
   terminal distribution and the desktop package. Frozen verification checks embedded profiles,
   beep audio and SDL modules, then runs help, JSONL catalog and SDL device-inventory commands
   outside the source tree. Device inventory must initialize both SDL controller and joystick APIs.
4. Native packaging and a real packaged-app smoke test: macOS DMG integrity, read-only mounting,
   ZIP extraction, strict recursive signature validation and launch from both containers;
   Windows silent installation; Linux AppImage launch through its actual runtime using FUSE under
   X11, and `APPIMAGE_EXTRACT_AND_RUN=1` under headless Wayland with no X11 display. The extracted
   deb also launches under Xvfb. These checks do not claim coverage of Steam Deck GPU drivers or gamescope.
   Each app must report the intended version and load every profile through the real bundled engine.
5. A complete inventory of four target manifests, eleven distribution files and two update feeds, with matching
   version, commit, size and SHA-256. Missing, unexpected, stale or corrupt files fail verification.

Tests never connect to Bluetooth hardware. Hardware operation on each OS, including Steam Input
in Deck Game Mode, remains a manual acceptance check. macOS apps are ad-hoc signed, without an
Apple Developer ID or notarization. This seals the modified Electron bundle and nested executables
correctly but does not confer Gatekeeper trust on a download. Windows packages are unsigned.
The macOS tests launch the app executable directly; passing them does not prove that Finder will
accept an unapproved download. Without Apple credentials, users must approve their trusted copy
in **System Settings → Privacy & Security → Open Anyway** after attempting to open it. Release
notes and the DMG's `Open Axle on macOS.txt` explain this step. Eliminating this approval requires
Developer ID signing and notarization, which are outside the credential-free release setup.

The AppImage uses electron-builder's checksum-pinned static runtime toolset `1.0.3`, which avoids
the legacy runtime's dependency on host `libfuse.so.2`. A FUSE device is still needed for mounting;
extract-and-run supports systems without one. The AppImage test preserves the launcher's own
sandbox decision rather than letting Playwright inject `--no-sandbox`. Do not replace these checks
with an extracted `AppRun` launch: that bypassed the broken outer launcher in v0.1.13.

On macOS, signing changes the frozen helper's signature. Verification checks its signature and
compares the source and packaged binaries after removing signatures from disposable copies only.
The installed app and source helper are never modified by verification.

## Version and publication

`Verify complete release` is the aggregate check suitable for branch protection. It fails when
any prerequisite fails or is skipped, including failures before the native matrix starts.

Major/minor come from `ui/electron/package.json`; patch is the release workflow run number.
For example, package version `0.1.0` and run 123 produce version `0.1.123`, tag `v0.1.123`.
PR builds use `0.1.0` as a validation version and never publish.

Actions are pinned by commit. Workflows default to read-only permissions and do not persist Git
credentials. Only the final publish job gets `contents: write`. PR runs supersede earlier runs for
the same PR; release runs are serialized without canceling an active publication.

Publication revalidates downloaded artifacts, creates or resumes a draft belonging to the same
commit, uploads the complete set plus `SHA256SUMS` and `release-manifest.json`, verifies the uploaded
inventory and sizes, then publishes. A failed upload leaves a draft. A rerun never replaces public
assets; an already published release is accepted only when its commit and manifest match exactly.
Rebuilding an already published version may produce different bytes; create a new run/version then.

## Desktop updates

The packaged update feed is explicitly pinned to `o-raskin/axle-app` on GitHub.
The release staging step generates `latest.yml` for the Windows NSIS installer and
`latest-linux.yml` for the Linux/Steam Deck AppImage. These JSON documents are valid
YAML for electron-updater. They contain the release version, exact artifact filename,
size and SHA-512 checksum. Verification regenerates the expected metadata from the
installer bytes and rejects any mismatch, in addition to checking the complete SHA-256
release inventory. Both feeds are uploaded into the draft together with the installers
and become visible only when the complete release is published. Full downloads avoid
dependencies on older release blockmaps. No GitHub token is shipped in the app.

Startup checks select stable newer versions only. Downloading and restarting to install
require separate confirmation; auto-install on ordinary quit is disabled. Vehicle
control must stop before installation, and new bridge commands are blocked during that
shutdown. AppImage updates stage the replacement on the destination filesystem and
atomically replace the original path, preserving Steam shortcuts and executable permissions.
Unsigned macOS builds offer the matching DMG for manual installation; Developer ID signing
would be required to enable the standard macOS self-updater. Linux deb installations use
manual package-manager installation. Packaged smoke tests disable live update checks and
verify the embedded GitHub feed identity. Actual two-version Windows/AppImage installation
still requires a native acceptance run; the local tests cover consent, failure recovery,
vehicle shutdown ordering, metadata integrity and AppImage filesystem replacement.

## Local reproduction

Use a Python 3.12 virtual environment on the target OS/CPU:

```sh
python -m pip install -r requirements.txt -r requirements-build.txt
python -m pytest tests -q
python -m ruff check .
python -m ruff format --check .
python -m mypy --strict --ignore-missing-imports --scripts-are-modules gamepad_bridge.py probe_hub.py bridge scripts
python scripts/build_release.py
python scripts/verify_release.py dist/lego-technic-gamepad-bridge
cd ui/electron
npm ci
npm run lint
npm test
npm run build
npm run test:ui
npm run dist:mac
node scripts/verify-macos.cjs
```

On Windows append `.exe` to the frozen binary and use `npm run dist:win`; on Linux use
`npm run dist:linux` and run GUI checks under `xvfb-run --auto-servernum` in headless environments.
`npm run test:package -- /absolute/path/to/executable` checks an installed/extracted payload.
The package hook requires the native binary in the root `dist/` directory and does not install
Python dependencies automatically. Desktop runtime state is outside the read-only package.

Build dependencies have pinned direct versions; npm also freezes transitive versions in its lockfile.
Hosted runner images and Python's transitive dependencies can change, so builds are not claimed to
be bit-for-bit reproducible. Update action commits, actionlint checksums and dependency pins together
with a successful native matrix run.

## AppImage bridge execution

The frozen helper validates file capabilities before starting. SquashFUSE can return `EINVAL`
for that extended-attribute query, so executing the helper directly inside a mounted AppImage
can fail even when extract-and-run succeeds. AppImage builds copy the bundled helper once per
app process into a private `0700` directory under user data and execute that identical copy.
Normal process exit removes it. This preserves PyInstaller's security checks and does not use
system Python. A forced termination can leave the private directory behind.

The package verifier confirms the requested FUSE/extraction mode, profile loading through the
real helper, byte-for-byte identity of its private copy, directory permissions and cleanup on exit.
