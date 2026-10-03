# Release pipeline

Every push to `main` builds all supported distributions through **Build distributions**
(`release.yml`). PRs run the same **Verify** workflow (`lint.yml`), including the native matrix.
These workflows have read-only repository permissions and create downloadable artifacts only.
They never create a release, draft or tag. No signing credentials or additional services are needed.

**Prepare release draft** (`prepare-release.yml`) runs only when a maintainer explicitly requests
it on `main`. It reuses a successful build's exact packages and leaves publication to the maintainer.

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

1. Ruff lint/format, strict mypy, and checksum-pinned actionlint validation of every workflow.
   The full Python test suite also runs on Python 3.9, the minimum development runtime, including
   PLAYVM calibration through live telemetry with cold, delayed and unavailable encoder feedback,
   plus encoder shutdown/restart when an immediately completed request consumes task cancellation.
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

If the aggregate reports `python-compatibility: cancelled` and `native: skipped`, open the
**Python 3.9 runtime and live startup** job first. A cancelled job can mean that its ten-minute
deadline expired; native packaging correctly waits for it to succeed. The compatibility step
prints each test name and dumps thread tracebacks if a test lasts longer than 60 seconds.
The deadline and required gate remain in place. Rerunning an old commit does not include a
fix still present only in the local working tree; run a new build after committing that fix.

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

## Download a build

Open a successful **Build distributions** run in Actions. Its summary shows the version, source
commit and build run ID, with a direct download of **verified-release** containing every platform,
update metadata and checksums. The four **release-macos-arm64**, **release-macos-x64**,
**release-windows-x64** and **release-linux-x64** artifacts are also available separately under
Artifacts. All distribution artifacts are retained for **30 days**; coverage and failed-UI evidence
are retained for 7 days. Extract the outer Actions artifact ZIP before using the installers.

Artifacts are build candidates. They do not appear in the app's updater until someone publishes a
GitHub Release. Try Bluetooth and controller behavior on the intended hardware before publication.

## Create a release when you are ready

1. Choose a successful **Build distributions** run from `main`. Copy its **build run ID** from the
   summary or the last number in its Actions URL. This is the long run ID, not the short run number.
2. In Actions, open **Prepare release draft → Run workflow**, select branch **main**, paste the
   `build_run_id`, and start the workflow. No local build, asset selection, secret or tag push is needed.
3. Follow **Open the release draft** in the finished workflow's summary. It contains all eleven
   platform downloads, both updater feeds, `SHA256SUMS` and `release-manifest.json`. Notes include
   a generated changelog, installation instructions and a link to the verified source build.
4. Edit the notes, check the version and hardware behavior, then click **Publish release** in GitHub.
   Publication is always your explicit action. The associated tag targets the original built commit,
   even if `main` has moved forward since the build.

If an upload fails, the release stays a draft. Run the preparation again with the same build run ID
to resume; notes you have already edited are preserved. Published assets are never replaced. If the
artifact has expired, run **Build distributions** manually on `main` to obtain a fresh candidate.
Builds made before this artifact-first pipeline have no `verified-release` bundle and cannot be selected.

## Version and safeguards

`Verify complete release` is the aggregate check suitable for branch protection. It fails when
any prerequisite fails or is skipped, including failures before the native matrix starts.

Major/minor come from `ui/electron/package.json`; patch is the Build distributions workflow run number.
For example, package version `0.1.0` and run 123 produce version `0.1.123`, tag `v0.1.123`.
PR builds use `0.1.0` as a validation version and never publish.

The original `release.yml` file is retained so its workflow run numbering continues from existing
releases. Rerunning one build keeps its version; a new build run gets a new patch. Distinct main
commits have independent concurrency groups so a new push cannot replace a pending older commit's
verification. PR runs can supersede older runs for the same PR.

For a rebuild after a successful run, choose **Run workflow** to get a fresh version. **Re-run all jobs**
retains the old version and cannot overwrite immutable artifacts already uploaded under the same names.

Actions are pinned by commit and do not persist Git credentials. Only the draft upload job gets
`contents: write`, after a separate job with read-only access confirms the candidate. Selection rejects
PR/fork/other-workflow runs, failed or incomplete jobs, commits outside main's history, and missing,
duplicate or expired complete bundles. Download uses the validated immutable artifact ID, rather than
an artifact name that could resolve to a different upload. The complete manifest's commit and patch
must match the selected run; all four manifests, filenames, feeds, sizes and checksums are verified again.

Draft preparation creates or resumes a draft belonging to the same commit, uploads every asset and
reads the files back to verify their bytes. Existing tags must point to that commit. A published release
is accepted only if its inventory, bytes and tag match exactly, with no modifications. No command in
the release helper or workflow publishes a release. New versions are required for changed public assets.

To enforce validation before merging, configure a GitHub branch rule/ruleset for `main` that requires
**Verify complete release**, requires the PR branch to be up to date, and blocks bypass/force pushes.
These workflows do not configure repository branch rules. Without them, direct pushes are still checked
after the push, but a failed check cannot undo the commit.

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
