# LEGO Technic Gamepad Bridge

Turn a Sony DualSense or Steam Deck controller into a tactile cockpit for a LEGO Technic Move Hub (88019).
The current implementation is tuned for the LEGO Technic 42239 Batmobile Tumbler: analog drive,
steering, braking, boost, automatic lights, controller LEDs, haptics, and a reverse warning beep.

> Current scope: macOS + DualSense, and Linux/Steam Deck + Steam Input/Xbox-style controller
> mappings. The shipped profiles are `config/gamepads/dualsense.json`,
> `config/gamepads/steamdeck.json`, `config/gamepads/generic_sdl.json`, and
> `config/models/tumbler.json`. The CLI defaults to `--gamepad auto`, trying DualSense first, then
> the Steam Deck profile, then a generic SDL/XInput fallback for Steam Deck names SDL reports
> differently.

## What It Does

This bridge connects to the Technic Move Hub over BLE, starts the hub's built-in PLAYVM control
program, calibrates the model, then sends live drive frames from the gamepad at a 20 Hz control
loop. It only sends a new frame when the command state changes, and it performs a safe stop on
interrupts, disconnects, or normal exit.

Highlights:

| Area | Current behavior |
| --- | --- |
| Drive | R2 drives forward, L2 drives reverse, both scaled by the selected speed mode. |
| Steering | Left stick X controls steering with profile limits and deadzone protection. |
| Speed modes | D-pad Up/Down selects 25%, 50%, or 100% trigger-to-motor power. |
| Braking | L1 immediately cuts throttle and cancels boost. |
| Boost | R1 fires the Tumbler boost for 1.95 seconds, then enforces a 7.5 second cooldown. |
| Lights | Front lights follow forward motion; reverse blinks rocket lights once per second. |
| Effects | Circle sends a one-second PLAYVM flicker signal. |
| Crash lockout | A hub-reported PLAYVM `impact` at 30%+ drive power blocks controls for 3 seconds. |
| Feedback | Rumble, DualSense LED color/brightness when available, reverse audio, and the terminal dashboard mirror the car state. |

Keep the wheels off the ground the first time you run live control. Once Bluetooth, the gamepad, and
the hub are ready, live control starts automatically and can move the model immediately.

## Project Structure

The runtime is split around the extension points that change between hardware setups:

- `bridge/gamepads/`: gamepad profiles, SDL/Pygame discovery, diagnostics, and normalized input.
- `bridge/gamepads/dualsense.py`, `steamdeck_gamepad.py`, `generic_sdl.py`: gamepad-specific entry points.
- `bridge/platforms/macos.py`, `linux.py`, `steamdeck_platform.py`, `windows.py`: target-specific platform hooks.
- `bridge/cars/`: car model profiles and car-specific command behavior.
- `bridge/cars/tumbler/`: all Tumbler-specific PLAYVM control, lights, boost, crash lockout, and per-frame runtime state.

New gamepads should be added as JSON profiles under `config/gamepads/` plus a specific module under
`bridge/gamepads/` when SDL needs special handling. New LEGO Technic cars should get their model JSON
under `config/models/` and any car-specific runtime package under `bridge/cars/<car_name>/`.

The Electron desktop UI base lives separately under `ui/electron/`. It has its own Node package,
Electron main/preload/renderer processes, and packaging scripts for macOS, Windows, Linux, and a
Steam Deck-oriented Linux x64 AppImage. Desktop releases include a frozen bridge runtime. Python
remains the source of truth for BLE, gamepad input, model behavior, safety shutdown, hub scanning,
and diagnostics; Electron is only a frontend/controller over the structured Python protocol.

## Requirements

- macOS (Apple Silicon or Intel), Windows x64, or Linux x64 / Steam Deck with a compatible controller
- Bluetooth enabled
- LEGO Technic Move Hub (88019)
- LEGO Technic 42239 Batmobile Tumbler profile, shipped as `config/models/tumbler.json`

Python is required only for development. CI builds with Python 3.12 and Node.js 24 LTS.

## Start From a Release

Download the matching asset from the latest GitHub Release:

| Platform | Terminal archive | Axle desktop |
| --- | --- | --- |
| macOS Apple Silicon | `lego-technic-gamepad-bridge-vVERSION-macos-arm64.tar.gz` | `Axle-VERSION-mac-arm64.dmg` / `.zip` |
| macOS Intel | `lego-technic-gamepad-bridge-vVERSION-macos-x64.tar.gz` | `Axle-VERSION-mac-x64.dmg` / `.zip` |
| Windows x64 | `lego-technic-gamepad-bridge-vVERSION-windows-x64.zip` | `Axle-VERSION-win-x64.exe` |
| Linux x64 / Steam Deck | `lego-technic-gamepad-bridge-vVERSION-linux-x64.tar.gz` | `Axle-VERSION-linux-x86_64.AppImage` / `Axle-VERSION-linux-amd64.deb` |

Replace `VERSION` with the release number. Extract terminal archives before running the binary;
on Windows its filename ends in `.exe`. Both editions include Python, SDL and the built-in profiles.
The release includes `SHA256SUMS` and `release-manifest.json` for download verification.

On Steam Deck, use the AppImage for normal launching:

```bash
chmod +x ./Axle-VERSION-linux-x86_64.AppImage
./Axle-VERSION-linux-x86_64.AppImage
```

The AppImage opens the Axle desktop UI and is shared by Linux and Steam Deck. The terminal archive
provides the command-line interface for scripting and debugging. Current packages are unsigned.

If macOS blocks a downloaded unsigned binary, remove the download quarantine and run it again:

```bash
xattr -dr com.apple.quarantine ./lego-technic-gamepad-bridge
./lego-technic-gamepad-bridge
```

The terminal executable starts the guided live-control flow by default. Startup first asks which model
profile to drive. Use keyboard Up/Down + Enter, or gamepad D-pad Up/Down + A/Cross, to choose. If
this machine does not have a saved car port map yet, the bridge scans the hub first, saves the
result, and continues startup. The scan does not move the model.

Release runtime files are stored under:

```text
~/Library/Application Support/LEGO Technic Gamepad Bridge/
~/.lego-technic-gamepad-bridge/
```

Set `LEGO_BRIDGE_HOME=/some/path` before launching the terminal to change its state directory.
The desktop app stores bridge state with its settings in Electron's user-data directory.

Useful release commands:

```bash
./lego-technic-gamepad-bridge             # choose model, then guided live control
./lego-technic-gamepad-bridge --model tumbler
./lego-technic-gamepad-bridge --scan-hub  # refresh the saved hub port map without driving
./lego-technic-gamepad-bridge --probe     # show gamepad axes/buttons, no hub
./lego-technic-gamepad-bridge --gamepad-devices
./lego-technic-gamepad-bridge --audio-devices
./lego-technic-gamepad-bridge --gamepad dualsense
./lego-technic-gamepad-bridge --gamepad steamdeck
```

By default the scan looks for a hub named `Technic Move`. If several hubs are nearby, or if you want
to reconnect to the exact same hub, pass its BLE address:

```bash
./lego-technic-gamepad-bridge --scan-hub --address 44:3E:8A:7B:A4:EC
```

On Steam Deck, download the AppImage in Desktop Mode, mark it executable, and add the AppImage to
Steam as a Non-Steam Game if you want to launch it from Game Mode. Use a gamepad Steam Input layout.

If startup remains stuck on `Gamepad controller detected`, run:

```bash
./lego-technic-gamepad-bridge --gamepad-devices
```

The same report is available in Axle's Diagnostics. On Steam Deck, the best report has a `controller_count` greater than zero and at least one
`controller[N].is_controller=True` line for `Steam Virtual Gamepad`, `Steam Deck`, or an Xbox-style
name. The bridge uses SDL's GameController path first because Steam Input and the Deck's built-in
controller are mapped there consistently; `joystick_count=0` is acceptable if the controller lines
are present. If both `controller_count=0` and `joystick_count=0`, the app is not being launched with
a gamepad-visible Steam Input path; add the AppImage to Steam and run it from Steam with a gamepad
layout, or switch Desktop Mode controls into gamepad mode before launching. If SDL reports a
controller name that does not match any profile, send the full report and add/update a profile for
the reported name.

## Build Release Binaries

Build the matching release target on its native OS:

```bash
python -m pip install -r requirements-build.txt
python scripts/build_release.py
python scripts/verify_release.py dist/lego-technic-gamepad-bridge
./dist/lego-technic-gamepad-bridge
```

Use a Python 3.12 virtual environment on the target OS and architecture. On Windows, append `.exe`
to the output path. The macOS/Linux shell scripts are wrappers around this shared recipe.
Build the terminal runtime before packaging Electron; the package hook copies it into the app.
The old `build_linux_appimage.sh` terminal wrapper remains available for legacy manual builds;
the release pipeline ships the Electron AppImage instead.

## Desktop UI Package

The Electron renderer talks only to its preload API. In development, the main process runs
`gamepad_bridge.py --frontend jsonl`; packaged apps run their bundled native executable. Both paths
validate JSON Lines events and use a stdin stop command so the engine can finish cleanup on every OS.

```bash
python3 -m venv lego-env
source lego-env/bin/activate
pip install -r requirements.txt

cd ui/electron
npm install
npm run dev
```

`npm run dev` opens Electron. The Drive screen guides you through connecting the vehicle and
controller, preparing live control, and ending the session. If multiple vehicle profiles are
available, choose one on the vehicle card. Settings contains controller selection, fullscreen
preference, and advanced connection overrides. Opt-in Diagnostics retains
hub scanning, gamepad reports, the live input probe, audio outputs, and technical event details.
The Python CLI remains responsible for every hardware operation.

See [the desktop product audit](docs/product-redesign.md) for the user journeys, state contract,
design direction, and asset inventory.

The development app expects the Python source checkout to be present. It searches upward from the
Electron package for `gamepad_bridge.py`, then tries Python in this order:

- `LEGO_BRIDGE_PYTHON=/path/to/python`, when set;
- `lego-env/bin/python` or `.venv/bin/python` under the repo;
- `python3`, `python`, then the Windows `py -3` launcher.

Set `LEGO_BRIDGE_PROJECT_ROOT=/path/to/lego-technic-gamepad-bridge` if you launch Electron from an
unusual working directory. Python dependencies must already be installed in the selected
environment; the Electron package does not install or bundle them yet.

The normal CLI remains human-first and keeps the terminal dashboard/log UX:

```bash
python gamepad_bridge.py --model tumbler --gamepad auto
python gamepad_bridge.py --scan-hub
```

Electron uses protocol mode instead. In protocol mode, stdout is reserved for JSON Lines events and
human diagnostics are emitted as structured log events or stderr:

```bash
python gamepad_bridge.py --frontend jsonl --profiles-json
python gamepad_bridge.py --frontend jsonl --model tumbler --gamepad auto
python gamepad_bridge.py --frontend jsonl --scan-hub
```

Protocol events include lifecycle status, setup progress, logs, errors, command results, live car
telemetry where available, and exit/shutdown records. TypeScript does not duplicate BLE, gamepad,
model, port-map, safety, audio, or diagnostic behavior; it only starts Python operations and renders
their structured events.

Desktop package commands:

```bash
npm run dist:mac         # unsigned local macOS DMG + ZIP
npm run dist:mac:signed  # signed macOS DMG + ZIP when certificates are configured
npm run dist:win
npm run dist:linux
npm run dist:steamdeck
```

The `dist:*` commands require the native runtime in the repository's `dist/` directory and must run
on the target OS/architecture. They produce self-contained desktop packages. Use `npm run dev`
while developing, or `npm run start` after `npm run build` to preview the app locally.
The Linux x64 AppImage is also the Steam Deck package.

## Automated Release Builds

Pull requests run the reusable `.github/workflows/lint.yml`: Python lint/format/types, Electron
lint/types/unit/UI checks, native Python and Electron tests, all four native package builds, and
verification of frozen resources, installed/extracted desktop payloads and the complete artifact set.

Every push to `main` runs `.github/workflows/release.yml`, using the same verification workflow.
Versions use the major/minor from `ui/electron/package.json` and the release workflow run number
as the patch (currently `0.1.<run-number>`). Publication requires all eleven distribution assets.
Assets are uploaded to a draft first; published assets are never overwritten by a rerun.

Manual dispatch builds any selected branch; only `main` publishes. See
[release pipeline details](docs/release-pipeline.md) for runner choices, verification and local commands.

## Run From Source

```bash
python3 -m venv lego-env
source lego-env/bin/activate
pip install -r requirements.txt
python gamepad_bridge.py
```

Source-mode utility commands mirror the release executable:

```bash
python gamepad_bridge.py --scan-hub
python gamepad_bridge.py --probe
python gamepad_bridge.py --audio-devices
python gamepad_bridge.py --frontend jsonl --profiles-json
```

The legacy `python probe_hub.py` command is still available for development, but users should not
need it.

## Drive

Live startup checks Bluetooth, connects to the hub from the saved port map, starts PLAYVM, waits for
calibration, opens the selected gamepad, and prints each changed command sent to the hub. Press
`Ctrl+C`, `Esc`, or the controller Start/Menu button for safe motor stop, LED cleanup, BLE
disconnect, and pygame shutdown.

Startup is guided. If `--model` is not passed, startup opens a model selector; use keyboard Up/Down +
Enter, or gamepad D-pad Up/Down + A/Cross. The bridge then confirms Bluetooth is enabled and waits
for a supported gamepad. On Steam Deck, the built-in Steam Input controller should be detected by
`--gamepad auto`; if SDL reports an unexpected controller name, the generic SDL fallback is used.
Then it waits for the car and asks you to press the Technic Move Hub power/connect button so the hub
starts advertising. When the checklist is complete, live control starts automatically.

During live control, a cockpit-style terminal panel stays above the event log. It shows a drive-power
speedometer, steering meter, separate L2/R2 trigger bars, speed-mode selector, live button states,
boost/cooldown, brake, lights, flicker, controller LED, rumble, reverse beep, and a small car view.
Set `CAR_DASHBOARD=off` before launch to keep ordinary scrolling logs.

If the gamepad or hub disconnects while driving, the bridge stops the live session, performs safe
cleanup, and returns to the matching reconnect screen instead of crashing with a traceback.

## DualSense Controls

| Control | Action |
| --- | --- |
| Left stick X | Steer left/right. |
| R2 | Forward throttle. |
| L2 | Reverse throttle. |
| D-pad Up | Increase speed mode: 25% -> 50% -> 100%. |
| D-pad Down | Decrease speed mode: 100% -> 50% -> 25%. |
| L1 | Brake; throttle is ignored while held, and any active boost is cancelled. |
| R1 | Boost, when ready and not braking. |
| Square | Toggle front lights manually when stopped. Forward and reverse motion override it. |
| Circle | Trigger the one-second flicker/attack signal. |
| Cross / X | Confirm model selection during startup. |
| Options / Esc | Safe exit. |

## Steam Deck Controls

| Control | Action |
| --- | --- |
| Left stick X | Steer left/right. |
| RT | Forward throttle. |
| LT | Reverse throttle. |
| D-pad Up | Increase speed mode: 25% -> 50% -> 100%. |
| D-pad Down | Decrease speed mode: 100% -> 50% -> 25%. |
| LB | Brake; throttle is ignored while held, and any active boost is cancelled. |
| RB | Boost, when ready and not braking. |
| X | Toggle front lights manually when stopped. |
| B | Trigger the one-second flicker/attack signal. |
| A | Confirm model selection during startup. |
| Menu / Start | Safe exit. |

## DualSense Feedback

| State | Feedback |
| --- | --- |
| Speed mode 1/2/3 | White LED brightness shows 25%, 50%, or 100% power mode. |
| Speed change | Short rumble: one motor for up, the other for down. |
| Driving | Trigger-pressure rumble scales with both trigger pressure and speed mode. |
| Reverse | LED alternates between speed-mode white and matching-brightness green every second. |
| Reverse after 1 second | `beep.mp3` repeats through the DualSense speaker when macOS exposes it. |
| Boost active | LED ramps to orange, stays orange during boost, then fades out. Strong rumble follows. |
| Boost unavailable | LED flashes red for 0.6 seconds and sends a short strong rumble. |
| Crash lockout | Bright red LED and full-strength rumble for 3 seconds. |
| Forward motion | Front lights turn on automatically and stay on for one second after stopping. |
| Reverse motion | Front lights turn off; rocket lights blink once per second. |

## Crash Lockout

Crash lockout is driven by the hub's PLAYVM status, not by normal trigger movement. Releasing R2 or
L2 after driving, changing speed mode, or pressing L1 brake does not count as a crash.

The bridge starts crash lockout only when the hub reports an `impact` status while the current or
recent commanded drive power is at least 30% of the model's maximum. When that happens, controls are
blocked for 3 seconds: throttle and steering are forced to zero, boost/lights/flicker inputs are
ignored, the DualSense LED turns bright red, and the controller rumbles at full strength. Control is
restored automatically after the lockout expires.

## Reverse Beep Audio

The bridge first looks for a CoreAudio or SDL output whose name contains `DualSense` or
`Wireless Controller`. If macOS does not expose the controller speaker, it falls back to the current
system output.

```bash
python gamepad_bridge.py --audio-devices
DUALSENSE_AUDIO_DEVICE="DualSense Wireless Controller" python gamepad_bridge.py
REVERSE_BEEP_OUTPUT=default python gamepad_bridge.py
REVERSE_BEEP_OUTPUT=off python gamepad_bridge.py
```

Use `DUALSENSE_AUDIO_DEVICE` when the controller appears under a different output name. Use
`REVERSE_BEEP_OUTPUT=default` to force system audio, or `REVERSE_BEEP_OUTPUT=off` to disable the
reverse beep.

## Profiles

Profiles keep hardware discovery separate from model-specific command meanings:

- `config/models/tumbler.json` defines PLAYVM command bits, calibration pacing, boost timing, and
  drive/steering limits.
- `config/gamepads/dualsense.json` defines the DualSense button and axis indices, trigger behavior,
  deadzones, safe-exit button, and LED support.
- `config/gamepads/steamdeck.json` defines the Steam Deck/Steam Input SDL mapping and keeps LED
  support disabled.
- `config/gamepads/generic_sdl.json` uses the same SDL/XInput mapping without name filtering. It is
  the final `--gamepad auto` fallback for devices whose SDL name is unknown.
- The saved `port_map.json` is generated by the hub scan and tells the bridge which hub ports are
  drive, steering, lights, and PLAYVM.

Command bits are model-specific. For example, `0x04` is boost on the Tumbler, but a different model
can use the same bit for a different action. Add new profiles deliberately and test with the model
off the ground.

## Development

```bash
pre-commit install
pytest tests -q
```

The tests cover the byte-level startup sequence, PLAYVM command bits, port-map shape, DualSense and
Steam Deck profile mappings, Bluetooth status parsing, safe-exit inputs, trigger scaling, speed
modes, LED colors, rumble behavior, reverse beep cadence, and automatic lights.

## Independence

This is an independent project and is not affiliated with, endorsed by, or sponsored by the LEGO
Group. LEGO® is a trademark of the LEGO Group. Other product and brand names identify compatible
hardware or model profiles and belong to their respective owners.
