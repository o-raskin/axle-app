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

Set up the Python bridge from the repository root first, using Python 3.9 or newer
(release packaging uses Python 3.12):

```bash
python3 -m venv lego-env
source lego-env/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
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

On launch, Axle automatically starts the supported Tumbler connection flow: waits for
Bluetooth, searches for the controller and hub, calibrates PLAYVM, then starts live
control. Keep the car stationary and its wheels clear during setup. Device loss stops
motors; the bridge waits and reconnects without a button. If the worker exits, the app
retries after a short delay. Model selection is available in Settings throughout the flow.
Only Tumbler is exposed in the desktop
UI for now; terminal profiles remain unchanged. Selection and connection-setting changes
stop the old worker before starting the latest selection, including during setup.

The top-right **Exit** button is available in fullscreen and startup/error screens.
Its touch target is at least 48 pixels high. Exit stops the bridge before closing the
app on every desktop platform; failed cleanup leaves the window open for another try.
Keyboard focus uses a subdued indicator; pointer/touch dialog restoration has no ring.

Installed builds check the latest stable [GitHub release](https://github.com/o-raskin/axle-app/releases)
once at startup. **Help → Check for updates…** retries manually. Development builds
do not check; `--disable-update-check` also disables checks for offline/automated use.
An unavailable network never blocks launch. Checks do not interrupt an active vehicle session.

Windows installers and Linux/Steam Deck AppImages download only after confirmation,
verify the release's SHA-512 checksum, then ask separately before stopping vehicle
control and restarting to install. Closing Axle normally does not install an update.
AppImage replacement preserves its existing filename so Steam shortcuts remain valid;
it requires a writable containing directory. macOS builds have no Apple Developer ID,
so they offer the matching DMG for manual installation and macOS approval. Linux deb
installations similarly offer the package for installation through the package manager.
Only builds containing this feature can check for updates; older builds need one manual upgrade.

Selecting **42239 Batmobile Tumbler** shows a detailed CAD model bundled with the app.
Editable Studio/LDraw sources, offline conversion tools, references and asset licenses
live in [models/tumbler](models/tumbler/README.md).
The CAD/library sources are preserved losslessly in `models/tumbler/source/cad-source.zip`;
offline conversion reads them directly. `npm run model:extract -- <new directory>`
restores the editable files, and `npm run model:pack -- <directory>` repacks them.
Fogeyman's assembly is **CC BY-NC 4.0**, separately from Apache-2.0 application code.
Read the [model license](models/tumbler/LICENSE.md), [rights gaps](models/tumbler/RIGHTS.md)
and generated part attribution before redistributing; these records also accompany
the packaged desktop app. Unidentified Studio geometry and underlying brand/design
rights have not been independently cleared.
The compact **View** menu beside the vehicle name contains part views and **Follow active part**.
It opens upward, leaving the 3D preview unobstructed when closed; **Auto** indicates that following is enabled.
The compact vehicle footer contains the model name and View control; wheel-feedback messages
and detailed preview notes appear only in Developer mode. Orbit/zoom help lives inside View.
The default overview and active-part shots are closer, with lower chase views for driving
and boost; narrow windows pull the camera back to preserve framing. Drag to orbit, scroll to zoom,
or choose a close view; keyboard arrows, plus/minus and Home also
control the camera. **Follow active part** is enabled by default and moves smoothly between
cinematic views: rear chase for driving/boost, a left-side view revealing the flashing rear
green light when reversing, and a wide
composition for simultaneous front/rear effects. Steering adjusts driving views without
switching camera sides. Manual camera movement pauses following. Other model profiles retain
their existing illustration.

The model uses the bridge's resolved steering/throttle commands, braking, front light/flicker
and independent reverse/boost light flags. Reverse blinking illuminates the two front internal
green couplers and the rear green assembly. Attack flickers all three green assemblies
alongside the white headlights, then restores the current reverse-light phase; reduced
motion shows steady Attack illumination. Only boost illuminates the orange jet lens.
Wheel rotation now follows drive encoder positions, converted through the real 7/11 rear
drivetrain ratio. The renderer interpolates measured travel with a 120 ms delay and never
guesses RPM from throttle. This reflects actual boost, stalls, reversal and coasting. The
shared differential exposes mean rear-wheel travel; independent wheel speeds during turns
or slip are not observable. Front tires use the 68.7/56 rolling-diameter ratio.
Keep the car stationary during connection when possible. Encoder direction is learned
passively during the first normal drive, without any extra motor commands. If discovery
finishes after the first trigger press, measured motion itself establishes the baseline.
Until it is learned,
or if encoder readings are unavailable, wheel animation pauses. Steering still shows its
commanded position and attack panels stay fixed. See [wheel feedback](models/tumbler/wheel-feedback.md).
The bridge rejects encoder samples older than 300 ms. The viewer allows 600 ms total
measurement/transport age to cover polling and delivery, then pauses wheel motion;
controls/lights expire after 1.5 seconds without
matching telemetry. Session changes and disconnect also stop animation.
Reduced-motion preferences preserve the current steering pose and lights while
suppressing wheel rotation, light pulses and automatic camera moves. If graphics support is
unavailable, the driving controls remain usable.

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
  including its frozen helper. Downloaded apps require approval in **System Settings → Privacy &
  Security → Open Anyway** because these builds have no Developer ID or notarization; see the
  [installation steps](../../README.md#start-from-a-release) and the instructions inside the DMG.
  Keeping builds free of Apple credentials means this approval cannot be removed.
  `dist:mac:signed` overrides the identity with `CSC_NAME` when Apple credentials are configured;
  Developer ID signing alone does not replace notarization.
- Windows packaging runs on Windows x64 and produces an NSIS installer.
- Linux and Steam Deck AppImage builds should run on Linux x86_64 for runtime compatibility.

Every package includes the frozen Python runtime, SDL, profiles and beep audio in `resources/bridge`.
The packaging hook rejects cross-compilation or a missing bridge. Packaged apps never discover
system Python or source checkouts; writable bridge files are stored under Electron's user-data
directory. Linux and Steam Deck share one x64 AppImage with a static FUSE runtime, avoiding a host
FUSE 2 dependency. CI launches the actual AppImage in mounted and extract-and-run modes. macOS CI
verifies bundle signatures and launches both the mounted DMG app and the extracted ZIP app.
These runtime checks do not test Finder's first launch of a quarantined download or grant
Gatekeeper approval.

## Using the Desktop App

Drive is the main screen. Connection, calibration, engine startup, and reconnection
are automatic. Keep the wheels clear: controller input can move the vehicle as soon
as setup finishes. Use Exit to stop control and close the app.
`--disable-hardware-discovery` disables automatic hardware startup for isolated/offline
test runs; it does not permit motor control.

Settings contains the supported model picker,
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
saved settings. It also verifies the real Tumbler canvas, camera movement, steering/wheel/light
feedback and stale-session isolation. Linux CI runs this under Xvfb; fixture-only software rendering
allows these checks without a physical GPU.

`test:package` launches the actual installed/extracted app with temporary settings, invalid source
overrides and a working directory outside the repository. It verifies the embedded version and
complete profile catalog through the real preload and frozen child process. Physical Bluetooth,
controller input, calibration and motor shutdown still need testing with hardware.
See [release pipeline details](../../docs/release-pipeline.md).
