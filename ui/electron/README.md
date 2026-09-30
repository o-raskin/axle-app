# Axle desktop app

Axle is the independent desktop UI for LEGO Technic Gamepad Bridge. It is intentionally separate from
the Python bridge runtime: the renderer uses a preload API, the Electron main process spawns
the bundled native bridge (or `gamepad_bridge.py --frontend jsonl` in development), and Python remains responsible for BLE,
gamepad input, car logic, safety, hub scanning, audio/gamepad diagnostics, and live control.

## Layout

```text
ui/electron/
  src/main/       Electron main process
  src/preload/    Safe IPC bridge exposed to the renderer
  src/renderer/   React/Vite renderer app
  src/shared/     Types and static bootstrap data shared across processes
  resources/      Packaging resources such as icons and bundled runtime assets
```

## Local Development

Set up the Python bridge from the repository root first:

```bash
python3 -m venv lego-env
source lego-env/bin/activate
pip install -r requirements.txt
```

Then launch Electron with Node.js 24 LTS (24.12 or newer):

```bash
cd ui/electron
npm ci
npm run dev
```

The app searches for the repository root by walking upward until it finds `gamepad_bridge.py`.
Override this with `LEGO_BRIDGE_PROJECT_ROOT=/path/to/repo` when needed. Python is resolved in this
order: `LEGO_BRIDGE_PYTHON`, `lego-env/bin/python`, `.venv/bin/python`, `python3`, `python`, then
`py -3` on Windows.

The UI can start guided live control, stop the running bridge through its stdin control protocol, scan the
hub, run gamepad diagnostics, run the live input probe, and show audio devices. Python stdout is
reserved for JSON Lines protocol events in Electron mode; stderr is treated as human diagnostics.
The main process validates event shapes defensively and forwards structured events to the renderer
through typed IPC.

The normal Python CLI remains unchanged and keeps its human terminal UI:

```bash
python gamepad_bridge.py --model tumbler --gamepad auto
python gamepad_bridge.py --scan-hub
```

Protocol examples used by Electron:

```bash
python gamepad_bridge.py --frontend jsonl --profiles-json
python gamepad_bridge.py --frontend jsonl --model tumbler --gamepad auto
python gamepad_bridge.py --frontend jsonl --scan-hub
```

## Build

```bash
# From the repository root, using a Python 3.12 virtual environment:
python -m pip install -r requirements-build.txt
python scripts/build_release.py
cd ui/electron
npm run build
npm run dist
```

`dist` commands build installers/packages; they do not launch the UI. Use `npm run dev` during
development, or `npm run start` after `npm run build` to preview the packaged renderer locally.

Platform-specific package commands:

```bash
npm run dist:mac         # ad-hoc signed macOS DMG + ZIP; no Apple credentials
npm run dist:mac:signed  # Developer ID build with certificates and CSC_NAME configured
npm run dist:win         # Windows NSIS installer
npm run dist:linux       # Linux AppImage + deb
npm run dist:steamdeck   # Linux x64 AppImage target for Steam Deck
```

Build platform notes:

- macOS release packaging runs on macOS. Default builds explicitly ad-hoc sign the full bundle,
  including its frozen helper. Downloaded apps still need a Gatekeeper exception because these
  builds have no Developer ID or notarization; see the root README. `dist:mac:signed` overrides
  that identity with `CSC_NAME` (or certificate discovery) when Apple credentials are configured.
- Windows packaging runs on Windows x64 and produces an NSIS installer.
- Linux and Steam Deck AppImage builds should run on Linux x86_64 for runtime compatibility.

Every package includes the frozen Python runtime, SDL, profiles and beep audio in `resources/bridge`.
The packaging hook rejects cross-compilation or a missing bridge. Packaged apps never discover
system Python or source checkouts; writable bridge files are stored under Electron's user-data
directory. Linux and Steam Deck share one x64 AppImage with a static FUSE runtime, avoiding a host
FUSE 2 dependency. CI launches the actual AppImage in mounted and extract-and-run modes. macOS CI
verifies bundle signatures and launches both the mounted DMG app and the extracted ZIP app.

## Using the Desktop App

Drive is the main screen. Connect vehicle starts Python's guided discovery and calibration. Keep
the wheels clear during setup: live controller input begins as soon as the vehicle is ready, and
the backend resumes automatically after reconnecting. The visible stop action ends the session.

The vehicle card offers a model picker when more than one profile is available. Settings contains
controller selection, fullscreen preference, and Advanced connection overrides. Automatic
controller detection is the default. Diagnostics is an explicit opt-in surface
for hub scanning, controller/audio reports, the input probe, raw events, and logs. It preserves the
existing tools without placing them in the ordinary driving flow.

The shell stores desktop preferences in Electron's `userData` directory. The top bar is a draggable
window region on macOS where the native titlebar is hidden; interactive controls remain clickable.
See [the product audit](../../docs/product-redesign.md) for the state contract and design decisions.

## Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:ui
npm run test:package   # after packaging; optionally pass an installed executable path
```

Run Python checks from the repository root:

```bash
lego-env/bin/python -m pytest tests -q
lego-env/bin/python -m ruff check .
lego-env/bin/python -m mypy --strict --ignore-missing-imports --scripts-are-modules gamepad_bridge.py probe_hub.py bridge
```

Oxlint checks TypeScript, React hooks and build/test scripts without depending on the TypeScript
compiler API. `tsc` checks types separately. The optional React performance rule for synchronous
state resets in effects is disabled; the app resets bootstrap state when subscribing to external IPC.

The UI fixture runner uses the pinned `playwright-core` dependency and the installed Electron
executable. It covers narrow layouts, 200% zoom, reduced motion, keyboard focus, reconnect/impact
states, diagnostics and startup recovery. Generated fixtures never connect to hardware or modify
saved settings. Linux CI runs this under Xvfb.

`test:package` launches the actual installed/extracted app with temporary settings, invalid source
overrides and a working directory outside the repository. It verifies the embedded version and
complete profile catalog through the real preload and frozen child process. Physical Bluetooth,
controller input, calibration and motor shutdown still need testing with hardware.
See [release pipeline details](../../docs/release-pipeline.md).
