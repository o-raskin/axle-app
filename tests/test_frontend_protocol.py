from __future__ import annotations

import json
from io import StringIO

from bridge.dashboard import CarTelemetry
from bridge.protocol import (
    PROTOCOL_NAME,
    PROTOCOL_VERSION,
    JsonLineEmitter,
    ProtocolSetupConsole,
    gamepad_snapshot_changes,
    profile_catalog_payload,
    setup_stage,
    telemetry_payload,
)
from bridge.session import startup_steps


def test_json_line_emitter_writes_protocol_envelope() -> None:
    stream = StringIO()
    emitter = JsonLineEmitter(stream)

    emitter.emit("log", level="info", message="ready")

    payload = json.loads(stream.getvalue())
    assert payload["protocol"] == PROTOCOL_NAME
    assert payload["version"] == PROTOCOL_VERSION
    assert payload["type"] == "log"
    assert payload["message"] == "ready"
    assert payload["timestamp"].endswith("Z")


def test_profile_catalog_payload_includes_frontend_defaults() -> None:
    payload = profile_catalog_payload()

    assert payload["defaults"]["model"] == "tumbler"
    assert payload["defaults"]["gamepad"] == "auto"
    assert {"id": "auto", "name": "Auto"} in payload["gamepads"]
    assert any(model["id"] == "tumbler" for model in payload["models"])


def test_setup_stage_maps_existing_terminal_screens() -> None:
    assert (
        setup_stage("Enable Bluetooth", startup_steps(False, False, False, bluetooth=False)) == "waiting_for_bluetooth"
    )
    assert setup_stage("Scan the car", startup_steps(False, False, False)) == "scanning_hub"
    assert setup_stage("Connect controller and car", startup_steps(False, False, False), "Looking for hub") == (
        "waiting_for_gamepad_and_hub"
    )
    assert setup_stage("Starting live control", startup_steps(True, True, True)) == "ready"


def test_protocol_setup_console_deduplicates_repeated_progress() -> None:
    stream = StringIO()
    console = ProtocolSetupConsole(JsonLineEmitter(stream))
    steps = startup_steps(False, False, False, bluetooth=False)

    console.show("Enable Bluetooth", "Turn Bluetooth on.", steps, "adapter off")
    console.show("Enable Bluetooth", "Turn Bluetooth on.", steps, "adapter off")

    lines = stream.getvalue().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["stage"] == "waiting_for_bluetooth"


def test_telemetry_payload_is_json_safe() -> None:
    payload = telemetry_payload(
        CarTelemetry(model_name="Tumbler", hub_name="Technic Move", max_drive=100, max_steering=70)
    )

    assert payload["model_name"] == "Tumbler"
    assert payload["hub_name"] == "Technic Move"
    assert isinstance(payload["led_color"], list)


def test_gamepad_snapshot_changes_reports_axes_above_threshold() -> None:
    previous = {"axes": [0.0, 0.0], "buttons": [0], "hats": [(0, 0)]}
    current = {"axes": [0.0, 0.2], "buttons": [1], "hats": [(0, 0)]}

    assert gamepad_snapshot_changes(previous, current) == [
        {"kind": "axis", "index": 1, "old": 0.0, "new": 0.2},
        {"kind": "button", "index": 0, "old": 0, "new": 1},
    ]
