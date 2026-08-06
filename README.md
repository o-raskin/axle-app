# lego-technic-gamepad-bridge

Drive a LEGO Technic Move Hub (88019) from a PC gamepad over BLE. Windows, Python 3.11+.
Developed against the 42239 Batmobile Tumbler.

## Setup

```powershell
python -m venv lego-env
.\lego-env\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Scan the hub

Writes `config/port_map.json`, which the bridge needs. Moves nothing.

```powershell
python probe_hub.py [--address 44:3E:8A:7B:A4:EC]
```

## Drive

```powershell
python gamepad_bridge.py --arm
python gamepad_bridge.py --probe    # gamepad indices, no hub
```

Left stick steers, R2/L2 drive, L1 brakes, R1 boosts, Triangle toggles lights. Wheels off the
ground the first time.

## Profiles

`config/models/*.json` — command bits, calibration pacing, boost timings.
`config/gamepads/*.json` — button and axis indices. Select with `--model` / `--gamepad`.

Command bits differ per model: `0x04` is lights-off on the Porsche 42176, boost on the Tumbler.

## Development

```powershell
pre-commit install
pytest tests -q
```
