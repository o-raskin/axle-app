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
| Feedback | DualSense rumble, LED color, LED brightness, reverse audio, and the terminal dashboard mirror the car state. |

Keep the wheels off the ground the first time you run live control. The script asks for an explicit
Enter press before arming the hub, but once armed it can move the model immediately.

## Requirements

- macOS
- Python 3.9+
- Sony DualSense controller connected to macOS
- LEGO Technic Move Hub (88019)
- LEGO Technic 42239 Batmobile Tumbler profile, shipped as `config/models/tumbler.json`

## Setup

```bash
python3 -m venv lego-env
source lego-env/bin/activate
pip install -r requirements.txt
```

## Scan the Hub

Run the probe once before driving. It does not move the model. It writes the runtime port map to
`config/port_map.json` and a readable topology report to `hub_scheme.txt`.

```bash
python probe_hub.py
```

By default the probe scans for a hub named `Technic Move`. If several hubs are nearby, or if you want
to reconnect to the exact same hub, pass its BLE address:

```bash
python probe_hub.py --address 44:3E:8A:7B:A4:EC
```

## Drive

Useful commands:

```bash
python gamepad_bridge.py --probe          # show DualSense axes/buttons, no hub
python gamepad_bridge.py --audio-devices  # show reverse-beep outputs
python gamepad_bridge.py --arm            # live hub control
```

`--arm` connects to the hub from `config/port_map.json`, starts PLAYVM, waits for calibration, opens
the DualSense, and prints each changed command sent to the hub. Press `Ctrl+C` for safe motor stop,
LED cleanup, BLE disconnect, and pygame shutdown.

Startup is guided. The bridge first waits for a DualSense and tells you to connect it by USB or
Bluetooth if it is missing. Then it waits for the car and asks you to press the Technic Move Hub
power/connect button so the hub starts advertising. Live control is not armed until both sides are
available and you confirm the final safety prompt.

During live control, a cockpit-style terminal panel stays above the event log. It shows a drive-power
speedometer, steering meter, separate L2/R2 trigger bars, speed-mode selector, live button states,
boost/cooldown, brake, lights, flicker, controller LED, rumble, reverse beep, and a small car view.
Set `CAR_DASHBOARD=off` before `--arm` to keep ordinary scrolling logs.

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
| Forward motion | Front lights turn on automatically and stay on for one second after stopping. |
| Reverse motion | Front lights turn off; rocket lights blink once per second. |

## Reverse Beep Audio

The bridge first looks for a CoreAudio or SDL output whose name contains `DualSense` or
`Wireless Controller`. If macOS does not expose the controller speaker, it falls back to the current
system output.

```bash
python gamepad_bridge.py --audio-devices
DUALSENSE_AUDIO_DEVICE="DualSense Wireless Controller" python gamepad_bridge.py --arm
REVERSE_BEEP_OUTPUT=default python gamepad_bridge.py --arm
REVERSE_BEEP_OUTPUT=off python gamepad_bridge.py --arm
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
- `config/port_map.json` is generated by `probe_hub.py` and tells the bridge which hub ports are
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
