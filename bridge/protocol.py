"""JSON Lines frontend protocol for non-interactive bridge controllers."""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import io
import json
import os
import sys
import threading
import time
from collections.abc import Iterable, Iterator
from datetime import datetime, timezone
from typing import Any, TextIO

from .audio import audio_output_devices, coreaudio_output_devices, dualsense_audio_device, run_audio_probe
from .cars.model_profiles import ModelProfile, available_model_choices
from .dashboard import CarTelemetry, SetupConsole
from .discovery import discover_hardware
from .gamepads.input import gamepad_diagnostics, snapshot
from .gamepads.profile_loader import AUTO_GAMEPAD_PROFILE, available_gamepad_choices, gamepad_profile_candidates
from .hub_probe import save_probe_outputs, scan_hub
from .paths import HUB_SCHEME_PATH, PORT_MAP_PATH
from .session import (
    DEFAULT_MODEL_PROFILE,
    HubTarget,
    prepare_port_map_for_drive,
    run_live_session,
    startup_steps,
    wait_for_bluetooth,
    wait_for_drive_hardware,
    wait_for_gamepad,
)
from .settings import AXIS_REPORT_STEP, DASHBOARD_LOG_LIMIT, SESSION_EXIT
from .transport import DEFAULT_HUB_NAME

PROTOCOL_NAME = "lego-technic-bridge"
PROTOCOL_VERSION = 1
TELEMETRY_INTERVAL_S = 0.1
GAMEPAD_PROBE_INTERVAL_S = 0.03
MAX_CONTROL_LINE_BYTES = 4096

JsonObject = dict[str, Any]


def utc_timestamp() -> str:
    """Return an ISO-8601 UTC timestamp for protocol events."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def protocol_event(event_type: str, **payload: Any) -> JsonObject:
    """Build one protocol event with the common envelope."""
    return {
        "protocol": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "type": event_type,
        "timestamp": utc_timestamp(),
        **payload,
    }


def serialize_event(event: JsonObject) -> str:
    """Serialize one protocol event as a compact JSON Lines record."""
    return json.dumps(event, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


class JsonLineEmitter:
    """Write protocol events to stdout without leaking human text into the stream."""

    def __init__(self, stream: TextIO | None = None) -> None:
        """Store the output stream used for JSON Lines records."""
        self.stream = stream or sys.stdout

    def emit(self, event_type: str, **payload: Any) -> JsonObject:
        """Serialize and flush one event."""
        event = protocol_event(event_type, **payload)
        self.stream.write(f"{serialize_event(event)}\n")
        self.stream.flush()
        return event


def profile_catalog_payload() -> JsonObject:
    """Return model and gamepad choices for frontends."""
    return {
        "models": [{"id": choice.profile_id, "name": choice.name} for choice in available_model_choices()],
        "gamepads": [
            {"id": AUTO_GAMEPAD_PROFILE, "name": "Auto"},
            *[{"id": choice.profile_id, "name": choice.name} for choice in available_gamepad_choices()],
        ],
        "defaults": {
            "model": DEFAULT_MODEL_PROFILE,
            "gamepad": AUTO_GAMEPAD_PROFILE,
            "hubName": DEFAULT_HUB_NAME,
        },
    }


def profile_catalog_json() -> str:
    """Return model and gamepad choices as stable JSON for legacy non-interactive callers."""
    return json.dumps(profile_catalog_payload(), sort_keys=True)


def telemetry_payload(telemetry: CarTelemetry) -> JsonObject:
    """Convert live car telemetry into JSON-safe frontend data."""
    payload = dataclasses.asdict(telemetry)
    led_color = payload.get("led_color")
    if isinstance(led_color, tuple):
        payload["led_color"] = list(led_color)
    return payload


def audio_probe_report() -> str:
    """Return the existing audio probe text without writing to protocol stdout."""
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        run_audio_probe()
    return buffer.getvalue().rstrip("\n")


def audio_probe_payload(report: str) -> JsonObject:
    """Return a structured summary plus the human diagnostic report."""
    coreaudio_devices = coreaudio_output_devices()
    audio_devices = audio_output_devices()
    return {
        "report": report,
        "coreAudioOutputs": [{"id": device.device_id, "name": device.name} for device in coreaudio_devices],
        "audioOutputs": audio_devices,
        "selectedOutput": dualsense_audio_device(None),
    }


def setup_stage(title: str, steps: Iterable[tuple[str, bool]], detail: str = "") -> str:
    """Map existing setup screens onto stable frontend progress states."""
    lowered_title = title.lower()
    lowered_detail = detail.lower()
    step_map = {label.lower(): done for label, done in steps}
    gamepad_ready = step_map.get("gamepad controller detected", False)
    hub_ready = step_map.get("technic move hub connected", False)
    live_ready = step_map.get("live drive session ready", False)
    bluetooth_ready = step_map.get("bluetooth enabled", True)

    stage = "ready"
    if live_ready or ("ready" in lowered_title and hub_ready):
        stage = "ready"
    elif "scan" in lowered_title:
        stage = "scanning_hub"
    elif not bluetooth_ready or "bluetooth" in lowered_title:
        stage = "bluetooth_ready" if bluetooth_ready and "ready" in lowered_title else "waiting_for_bluetooth"
    elif not gamepad_ready and not hub_ready:
        if "hub" in lowered_detail or "car" in lowered_title:
            stage = "waiting_for_gamepad_and_hub"
        else:
            stage = "waiting_for_gamepad"
    elif not gamepad_ready:
        stage = "waiting_for_gamepad"
    elif not hub_ready:
        stage = "waiting_for_hub"
    return stage


class ProtocolSetupConsole(SetupConsole):
    """Setup screen adapter that emits structured progress events."""

    def __init__(self, emitter: JsonLineEmitter) -> None:
        """Store the protocol emitter and the last progress event key."""
        super().__init__(stream=emitter.stream)
        self.emitter = emitter
        self._last_event_key: tuple[Any, ...] | None = None

    def show(self, title: str, message: str, steps: list[tuple[str, bool]], detail: str = "") -> None:
        """Emit one startup or reconnect progress event."""
        step_payload = [{"label": label, "done": done} for label, done in steps]
        stage = setup_stage(title, steps, detail)
        event_key = (stage, title, message, tuple((item["label"], item["done"]) for item in step_payload), detail)
        if event_key == self._last_event_key:
            return
        self._last_event_key = event_key
        self.emitter.emit(
            "setup/progress",
            stage=stage,
            title=title,
            message=message,
            steps=step_payload,
            detail=detail,
        )

    def stop(self) -> None:
        """Terminal consoles leave spacing here; protocol mode has nothing to clean up."""


class ProtocolLiveConsole:
    """Live session adapter that emits logs and throttled telemetry."""

    def __init__(self, emitter: JsonLineEmitter, min_telemetry_interval_s: float = TELEMETRY_INTERVAL_S) -> None:
        """Store telemetry throttling settings for a protocol live session."""
        self.emitter = emitter
        self.min_telemetry_interval_s = min_telemetry_interval_s
        self.logs: list[str] = []
        self._last_telemetry_at = 0.0

    def start(self, state: CarTelemetry) -> None:
        """Emit the first telemetry snapshot when live control starts."""
        self._emit_telemetry(state, force=True)

    def update(self, state: CarTelemetry) -> None:
        """Emit live telemetry at a bounded rate."""
        self._emit_telemetry(state)

    def log(self, message: str) -> None:
        """Emit one or more log lines."""
        for line in str(message).splitlines() or [""]:
            self.logs.append(line)
            if len(self.logs) > DASHBOARD_LOG_LIMIT:
                del self.logs[:-DASHBOARD_LOG_LIMIT]
            self.emitter.emit("log", level="info", message=line)

    def stop(self) -> None:
        """No terminal cursor state exists in protocol mode."""

    def _emit_telemetry(self, state: CarTelemetry, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_telemetry_at < self.min_telemetry_interval_s:
            return
        self._last_telemetry_at = now
        self.emitter.emit("telemetry", telemetry=telemetry_payload(state))


def _is_stop_command(line: bytes) -> bool:
    try:
        command = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        return False
    return (
        isinstance(command, dict)
        and command.get("protocol") == PROTOCOL_NAME
        and command.get("version") == PROTOCOL_VERSION
        and command.get("type") == "control/stop"
    )


@contextlib.contextmanager
def _frontend_control(stream: TextIO | None) -> Iterator[threading.Event]:
    """Cancel once on a stop command or parent EOF, preserving async cleanup."""
    stopped = threading.Event()
    finished = threading.Event()
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()

    def request_stop() -> None:
        if not finished.is_set() and task is not None and not task.done():
            stopped.set()
            task.cancel()

    def read_commands(fd: int) -> None:
        pending = b""
        try:
            while not finished.is_set():
                # Read the descriptor directly: a daemon blocked on Python's
                # buffered stdin can otherwise deadlock interpreter shutdown.
                chunk = os.read(fd, MAX_CONTROL_LINE_BYTES)
                if not chunk:
                    loop.call_soon_threadsafe(request_stop)
                    return
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if _is_stop_command(line):
                        loop.call_soon_threadsafe(request_stop)
                        return
                if len(pending) > MAX_CONTROL_LINE_BYTES:
                    loop.call_soon_threadsafe(request_stop)
                    return
        except (OSError, RuntimeError):
            # The process may already be closing its descriptors/event loop.
            return

    if stream is not None:
        threading.Thread(target=read_commands, args=(stream.fileno(),), daemon=True).start()
    try:
        yield stopped
    finally:
        finished.set()


async def run_jsonl_frontend(
    args: Any,
    emitter: JsonLineEmitter | None = None,
    control_stream: TextIO | None = None,
) -> int:
    """Dispatch one machine-readable frontend operation."""
    out = emitter or JsonLineEmitter()
    operation = operation_from_args(args)
    out.emit("process/status", status="starting", operation=operation)
    # One-shot inventories do not require an open parent connection.
    stream = control_stream if operation in {"live", "scanHub", "probeGamepad", "discover"} else None
    with _frontend_control(stream) as stopped:
        return await _dispatch_jsonl_operation(args, out, operation, stopped)


async def _dispatch_jsonl_operation(args: Any, out: JsonLineEmitter, operation: str, stopped: threading.Event) -> int:
    try:
        if args.profiles_json:
            out.emit("command/result", command="profiles", ok=True, payload=profile_catalog_payload())
        elif args.audio_devices:
            report = audio_probe_report()
            _emit_report_logs(out, report)
            out.emit("command/result", command="audioDevices", ok=True, payload=audio_probe_payload(report))
        elif args.gamepad_devices:
            report = gamepad_diagnostics()
            _emit_report_logs(out, report)
            out.emit("command/result", command="gamepadDevices", ok=True, payload={"report": report})
        elif getattr(args, "discover", False):
            await discover_hardware(out, args.name, args.address)
        elif args.scan_hub:
            await run_protocol_hub_scan(out, args.name, args.address)
        elif args.probe:
            await run_protocol_gamepad_probe(out, args.gamepad)
        else:
            await run_protocol_live_control(out, args.model, args.gamepad, args.name, args.address)
    except KeyboardInterrupt:
        out.emit("process/status", status="stopping", operation=operation)
        out.emit("exit", reason="interrupted", exitCode=130)
        return 130
    except asyncio.CancelledError:
        out.emit("process/status", status="stopping", operation=operation)
        out.emit("exit", reason="cancelled", exitCode=130)
        return 130
    except Exception as exc:
        out.emit("error", errorType=type(exc).__name__, message=str(exc))
        out.emit("exit", reason="error", exitCode=1)
        return 1
    if stopped.is_set():
        # The live session consumes cancellation after stopping its motors.
        out.emit("process/status", status="stopping", operation=operation)
        out.emit("exit", reason="cancelled", exitCode=130)
        return 130
    out.emit("exit", reason="complete", exitCode=0)
    return 0


def operation_from_args(args: Any) -> str:  # noqa: PLR0911 -- One return per mutually selected frontend mode.
    """Return the frontend operation name implied by parsed CLI args."""
    if args.profiles_json:
        return "profiles"
    if getattr(args, "discover", False):
        return "discover"
    if args.scan_hub:
        return "scanHub"
    if args.probe:
        return "probeGamepad"
    if args.gamepad_devices:
        return "gamepadDevices"
    if args.audio_devices:
        return "audioDevices"
    return "live"


async def run_protocol_hub_scan(out: JsonLineEmitter, name: str, address: str | None) -> None:
    """Scan a hub and report the generated port map through JSONL events."""
    setup = ProtocolSetupConsole(out)
    await wait_for_bluetooth(setup)
    setup.show(
        "Scan the car",
        "Press the Technic Move Hub power/connect button now so the bridge can learn this car.",
        startup_steps(dualsense=False, hub=False, ready=False),
        f"Looking for hub: {address or name}",
    )
    port_map, report = await scan_hub(name, address)
    save_probe_outputs(port_map, report)
    setup.show(
        "Hub scan complete",
        "The car port map has been saved.",
        startup_steps(dualsense=False, hub=True, ready=True),
        f"Saved port map to {PORT_MAP_PATH}; saved report to {HUB_SCHEME_PATH}",
    )
    _emit_report_logs(out, report)
    out.emit(
        "command/result",
        command="scanHub",
        ok=True,
        payload={
            "portMap": port_map,
            "report": report,
            "portMapPath": str(PORT_MAP_PATH),
            "reportPath": str(HUB_SCHEME_PATH),
        },
    )


async def run_protocol_gamepad_probe(out: JsonLineEmitter, gamepad_name: str) -> None:
    """Run the existing gamepad discovery path and stream input snapshots."""
    setup = ProtocolSetupConsole(out)
    pad_candidates = gamepad_profile_candidates(gamepad_name)
    pygame_mod, joystick, pad = await wait_for_gamepad(setup, pad_candidates)
    try:
        setup.show(
            "Controller ready",
            f"Controller detected: {joystick.get_name()} ({pad.name})",
            startup_steps(dualsense=True, hub=False, ready=True),
        )
        out.emit(
            "command/result",
            command="probeGamepad",
            ok=True,
            payload={
                "name": joystick.get_name(),
                "profile": pad.profile_id,
                "axes": joystick.get_numaxes(),
                "buttons": joystick.get_numbuttons(),
                "hats": joystick.get_numhats(),
            },
        )
        previous = snapshot(joystick)
        out.emit("telemetry", telemetry={"kind": "gamepadProbe", "snapshot": previous, "changes": []})
        while True:
            pygame_mod.event.pump()
            current = snapshot(joystick)
            changes = gamepad_snapshot_changes(previous, current)
            if changes:
                out.emit("telemetry", telemetry={"kind": "gamepadProbe", "snapshot": current, "changes": changes})
            previous = current
            await asyncio.sleep(GAMEPAD_PROBE_INTERVAL_S)
    finally:
        pygame_mod.quit()


async def run_protocol_live_control(
    out: JsonLineEmitter,
    model_name: str | None,
    gamepad_name: str,
    hub_name: str,
    hub_address: str | None,
) -> None:
    """Run guided live control using existing bridge engine objects."""
    setup = ProtocolSetupConsole(out)
    pad_candidates = gamepad_profile_candidates(gamepad_name)
    selected_model_name = model_name or DEFAULT_MODEL_PROFILE
    model = ModelProfile.load(selected_model_name)

    await wait_for_bluetooth(setup)
    port_map = await prepare_port_map_for_drive(setup, hub_name, hub_address)

    reconnect_reason: str | None = None
    while True:
        hardware_result = await wait_for_drive_hardware(
            setup,
            port_map,
            pad_candidates,
            reconnect_reason=reconnect_reason,
            hub_target=HubTarget(hub_name, hub_address),
            required_port_roles=model.required_port_roles,
        )
        if hardware_result is None:
            return
        pad, hardware = hardware_result

        setup.show(
            "Starting live control",
            f"All checks passed for {model.name} with {pad.name}. Keep the wheels clear.",
            startup_steps(dualsense=True, hub=True, ready=True),
        )
        setup.stop()
        out.emit("process/status", status="running", operation="live")
        reconnect_reason = await run_live_session(
            model,
            pad,
            port_map,
            hardware,
            live_console=ProtocolLiveConsole(out),
        )
        if reconnect_reason == SESSION_EXIT:
            return


def gamepad_snapshot_changes(previous: JsonObject, current: JsonObject) -> list[JsonObject]:
    """Return changed axis/button/hat entries between two gamepad snapshots."""
    changes = []
    singular = {"axes": "axis", "buttons": "button", "hats": "hat"}
    for kind in ("axes", "buttons", "hats"):
        previous_values = previous.get(kind, [])
        current_values = current.get(kind, [])
        for index, old_new in enumerate(zip(previous_values, current_values)):
            old, new = old_new
            moved = abs(old - new) >= AXIS_REPORT_STEP if kind == "axes" else old != new
            if moved:
                changes.append({"kind": singular[kind], "index": index, "old": old, "new": new})
    return changes


def _emit_report_logs(out: JsonLineEmitter, report: str) -> None:
    for line in report.splitlines():
        out.emit("log", level="info", message=line)
