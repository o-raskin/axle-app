"""Name the ports a hub reports, so the bridge can find the ones it drives."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .transport import IO_DRIVE_MOTOR, IO_LIGHTS, IO_PLAY_VM, IO_STEERING_MOTOR, TechnicMoveHub

DRIVE_MOTORS_EXPECTED = 2
MAX_PORT_ID = 0xFF


def normalize_port_map(hub: TechnicMoveHub) -> dict[str, Any]:
    """Map device types to roles. Everything else the hub said lives in the probe's report."""
    drive_ports = []
    steering_port = None
    lights_port = None
    play_vm_port = None

    for port_id in sorted(hub.attached_devices):
        device = hub.attached_devices[port_id]
        # A previous PLAYVM session may have left its paired virtual motor
        # attached. Roles describe the physical wiring used to create that pair.
        if device.virtual_ports is not None:
            continue
        port_key = f"0x{port_id:02X}"
        if device.io_type_id == IO_DRIVE_MOTOR:
            drive_ports.append(port_key)
        elif device.io_type_id == IO_STEERING_MOTOR:
            steering_port = port_key
        elif device.io_type_id == IO_LIGHTS:
            lights_port = port_key
        elif device.io_type_id == IO_PLAY_VM:
            play_vm_port = port_key

    roles: dict[str, str] = {}
    if drive_ports:
        roles["drive_left"] = drive_ports[0]
    if len(drive_ports) >= DRIVE_MOTORS_EXPECTED:
        roles["drive_right"] = drive_ports[1]
    if steering_port:
        roles["steering"] = steering_port
    if lights_port:
        roles["lights"] = lights_port
    if play_vm_port:
        roles["play_vm"] = play_vm_port

    return {"hub": {"name": hub.hub_name, "address": hub.hub_address}, "roles": roles}


def save_port_map(path: str | Path, port_map: dict[str, Any]) -> None:
    """Replace a saved scan atomically so a failed write keeps the previous map."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    contents = json.dumps(port_map, indent=2) + "\n"
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def load_port_map(path: str | Path) -> dict[str, Any]:
    """Read a port map written by probe_hub."""
    loaded = json.loads(Path(path).read_text(encoding="utf-8"))
    if (
        not isinstance(loaded, dict)
        or not isinstance(loaded.get("hub"), dict)
        or not isinstance(loaded.get("roles"), dict)
    ):
        raise ValueError("Port map must contain hub and roles objects")
    hub = loaded["hub"]
    if not isinstance(hub.get("name"), str) or not hub["name"].strip():
        raise ValueError("Port map hub name must be a nonempty string")
    address = hub.get("address")
    if address is not None and (not isinstance(address, str) or not address.strip()):
        raise ValueError("Port map hub address must be a nonempty string or null")
    for role in loaded["roles"]:
        try:
            port_id(loaded, role)
        except RuntimeError as exc:
            raise ValueError(str(exc)) from exc
    return loaded


def port_id(port_map: dict[str, Any], role: str) -> int:
    """Port number for a role, or an error naming the roles this hub does have."""
    roles = port_map.get("roles")
    if not isinstance(roles, dict):
        raise RuntimeError(f"Hub has no valid '{role}' port map")
    if role not in roles:
        raise RuntimeError(f"Hub has no '{role}' port (has: {', '.join(roles) or 'none'})")
    value = roles[role]
    try:
        if not isinstance(value, str):
            raise ValueError("port ids must be hex strings")
        port = int(value, 16)
        if not 0 <= port <= MAX_PORT_ID:
            raise ValueError("port ids must fit one byte")
    except ValueError as exc:
        raise RuntimeError(f"Hub has invalid '{role}' port: {value!r}") from exc
    return port
