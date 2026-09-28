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

## Requirements

- macOS with a Sony DualSense controller, or Steam Deck/Linux x86_64 with Steam Input/Xbox-style controls
- Bluetooth enabled
- LEGO Technic Move Hub (88019)
- LEGO Technic 42239 Batmobile Tumbler profile, shipped as `config/models/tumbler.json`

Python 3.9+ is only required when running from source or building a release.

## Start From a Release

Download the matching asset from the latest GitHub prerelease:

- macOS Apple Silicon: `lego-technic-gamepad-bridge-v...-macos-arm64`
- Steam Deck/Linux x86_64 AppImage: `lego-technic-gamepad-bridge-v...-linux-x86_64.AppImage`
- Steam Deck/Linux x86_64 raw terminal binary: `lego-technic-gamepad-bridge-v...-linux-x86_64`

On Steam Deck, use the AppImage for normal launching:

```bash
chmod +x ./lego-technic-gamepad-bridge-v...-linux-x86_64.AppImage
./lego-technic-gamepad-bridge-v...-linux-x86_64.AppImage
```

The raw Linux binary is useful for terminal debugging, but KDE/Dolphin may ask whether to run it
with Konsole. The AppImage is the intended double-clickable and Steam-friendly format; when launched
without a terminal, it opens Konsole itself and runs the bridge inside it.

If macOS blocks a downloaded unsigned binary, remove the download quarantine and run it again:

```bash
xattr -dr com.apple.quarantine ./lego-technic-gamepad-bridge
./lego-technic-gamepad-bridge
```

The release executable starts the guided live-control flow by default. If this machine does not have
a saved car port map yet, the bridge scans the hub first, saves the result, and continues startup.
The scan does not move the model.

Release runtime files are stored under:

```text
~/Library/Application Support/LEGO Technic Gamepad Bridge/
~/.lego-technic-gamepad-bridge/
```

Set `LEGO_BRIDGE_HOME=/some/path` before launch to use a different runtime state directory.

Useful release commands:

```bash
./lego-technic-gamepad-bridge             # guided live control; scans first if needed
./lego-technic-gamepad-bridge --scan-hub  # refresh the saved hub port map without driving
./lego-technic-gamepad-bridge --probe     # show gamepad axes/buttons, no hub
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
Steam as a Non-Steam Game if you want to launch it from Game Mode. Directly launching the AppImage
opens its own Konsole window; do not use Dolphin's raw-binary `Run with Konsole` path for normal use.

## Build Release Binaries

Build the matching release target on its native OS:

```bash
scripts/build_macos_release.sh
bash scripts/build_linux_release.sh
bash scripts/build_linux_appimage.sh
./dist/lego-technic-gamepad-bridge
./dist/lego-technic-gamepad-bridge.AppImage
```

The macOS build script must run on macOS. The Linux script must run on x86_64 Linux. Each script
creates a local release virtualenv, installs PyInstaller and the runtime dependencies, then writes a
single terminal executable to `dist/lego-technic-gamepad-bridge`. The AppImage script wraps that
Linux executable into `dist/lego-technic-gamepad-bridge.AppImage`; set `APPIMAGETOOL=/path/to/appimagetool`
when building locally.

## Automated Release Builds

Every push to `main` runs `.github/workflows/release.yml`. It is a multi-job pipeline:

- `lint`: runs ruff, pytest, and mypy;
- `version`: computes a SemVer version as `0.1.<github-run-number>`;
- `build_macos_release`: builds the single-file macOS executable;
- `build_linux_release`: builds the single-file Linux x86_64 executable;
- `publish_release`: uploads both assets and publishes a GitHub Release.

Release tags use `v0.1.<github-run-number>`. The release assets are named
`lego-technic-gamepad-bridge-v0.1.<github-run-number>-macos-arm64` and
`lego-technic-gamepad-bridge-v0.1.<github-run-number>-linux-x86_64`; Steam Deck releases also include
`lego-technic-gamepad-bridge-v0.1.<github-run-number>-linux-x86_64.AppImage`.

Manual builds can also be started from the workflow's `workflow_dispatch` trigger. Release publishing
is limited to runs on `main`.

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
```

The legacy `python probe_hub.py` command is still available for development, but users should not
need it.

## Drive

Live startup checks Bluetooth, connects to the hub from the saved port map, starts PLAYVM, waits for
calibration, opens the selected gamepad, and prints each changed command sent to the hub. Press
`Ctrl+C`, `Esc`, or the controller Start/Menu button for safe motor stop, LED cleanup, BLE
disconnect, and pygame shutdown.

Startup is guided. The bridge first confirms Bluetooth is enabled, then waits for a supported
gamepad. On Steam Deck, the built-in Steam Input controller should be detected by `--gamepad auto`;
if SDL reports an unexpected controller name, the generic SDL fallback is used. Then it waits for the
car and asks you to press the Technic Move Hub power/connect button so the hub starts advertising.
When the checklist is complete, live control starts automatically.

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
