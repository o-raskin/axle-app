# LEGO Technic DualSense Bridge for macOS

Turn a Sony DualSense controller into a tactile cockpit for a LEGO Technic Move Hub (88019).
The current implementation is tuned for the LEGO Technic 42239 Batmobile Tumbler: analog drive,
steering, braking, boost, automatic lights, controller LEDs, haptics, and a reverse warning beep.

> Current scope: macOS + DualSense + LEGO Technic Move Hub. The only shipped profiles are
> `config/gamepads/dualsense.json` and `config/models/tumbler.json`. The CLI still accepts
> `--gamepad` and `--model` for profile work, but the controls below describe the current
> DualSense-only implementation.

## What It Does

This bridge connects to the Technic Move Hub over BLE, starts the hub's built-in PLAYVM control
program, calibrates the model, then sends live drive frames from the DualSense at a 20 Hz control
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
| Feedback | DualSense rumble, LED color, LED brightness, reverse audio, and the terminal dashboard mirror the car state. |

Keep the wheels off the ground the first time you run live control. The script asks for an explicit
Enter press before arming the hub, but once armed it can move the model immediately.

## Requirements

- macOS
- Sony DualSense controller connected to macOS
- LEGO Technic Move Hub (88019)
- LEGO Technic 42239 Batmobile Tumbler profile, shipped as `config/models/tumbler.json`

Python 3.9+ is only required when running from source or building a release.

## Start From a Release

Download the `lego-technic-gamepad-bridge-macos` asset from the latest GitHub prerelease, then run:

```bash
mv lego-technic-gamepad-bridge-macos lego-technic-gamepad-bridge
chmod +x ./lego-technic-gamepad-bridge
./lego-technic-gamepad-bridge
```

If macOS blocks a downloaded unsigned binary, remove the download quarantine and run it again:

```bash
xattr -dr com.apple.quarantine ./lego-technic-gamepad-bridge
./lego-technic-gamepad-bridge
```

The release executable starts the guided live-control flow by default. If this Mac does not have a
saved car port map yet, the bridge scans the hub first, saves the result, and continues startup. The
scan does not move the model.

Release runtime files are stored under:

```text
~/Library/Application Support/LEGO Technic Gamepad Bridge/
```

Set `LEGO_BRIDGE_HOME=/some/path` before launch to use a different runtime state directory.

Useful release commands:

```bash
./lego-technic-gamepad-bridge             # guided live control; scans first if needed
./lego-technic-gamepad-bridge --scan-hub  # refresh the saved hub port map without driving
./lego-technic-gamepad-bridge --probe     # show DualSense axes/buttons, no hub
./lego-technic-gamepad-bridge --audio-devices
```

By default the scan looks for a hub named `Technic Move`. If several hubs are nearby, or if you want
to reconnect to the exact same hub, pass its BLE address:

```bash
./lego-technic-gamepad-bridge --scan-hub --address 44:3E:8A:7B:A4:EC
```

## Build the macOS Release

Local release builds must be created on macOS:

```bash
scripts/build_macos_release.sh
./dist/lego-technic-gamepad-bridge
```

The build script creates a local `.venv-release`, installs PyInstaller and the runtime dependencies,
then writes a single terminal executable to `dist/lego-technic-gamepad-bridge`.

## Automated Release Builds

Every push to `master` runs `.github/workflows/release.yml`. The workflow:

- runs ruff, pytest, and mypy;
- builds the single-file macOS executable with `scripts/build_macos_release.sh`;
- uploads the binary as a GitHub Actions artifact named `lego-technic-gamepad-bridge-macos-<sha>`;
- publishes a GitHub prerelease tagged `master-<short-sha>` with the binary attached as
  `lego-technic-gamepad-bridge-macos`.

Manual builds can also be started from the workflow's `workflow_dispatch` trigger. Manual runs upload
the Actions artifact; release publishing is limited to commits on `master`.

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

Live startup connects to the hub from the saved port map, starts PLAYVM, waits for calibration, opens
the DualSense, and prints each changed command sent to the hub. Press `Ctrl+C` for safe motor stop,
LED cleanup, BLE disconnect, and pygame shutdown.

Startup is guided. The bridge first waits for a DualSense and tells you to connect it by USB or
Bluetooth if it is missing. Then it waits for the car and asks you to press the Technic Move Hub
power/connect button so the hub starts advertising. Live control is not armed until both sides are
available and you confirm the final safety prompt.

During live control, a cockpit-style terminal panel stays above the event log. It shows a drive-power
speedometer, steering meter, separate L2/R2 trigger bars, speed-mode selector, live button states,
boost/cooldown, brake, lights, flicker, controller LED, rumble, reverse beep, and a small car view.
Set `CAR_DASHBOARD=off` before launch to keep ordinary scrolling logs.

If the DualSense or hub disconnects while driving, the bridge stops the live session, performs safe
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
  and deadzones.
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

The tests cover the byte-level startup sequence, PLAYVM command bits, port-map shape, DualSense
trigger scaling, speed modes, LED colors, rumble behavior, reverse beep cadence, and automatic
lights.
