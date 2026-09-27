"""Name the ports a hub reports, so the bridge can find the ones it drives."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .transport import IO_DRIVE_MOTOR, IO_LIGHTS, IO_PLAY_VM, IO_STEERING_MOTOR, TechnicMoveHub

DRIVE_MOTORS_EXPECTED = 2


def normalize_port_map(hub: TechnicMoveHub) -> dict[str, Any]:
    """Map device types to roles. Everything else the hub said lives in the probe's report."""
    drive_ports = []
    steering_port = None
    lights_port = None
    play_vm_port = None

    for port_id in sorted(hub.attached_devices):
        device = hub.attached_devices[port_id]
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
    """Write the port map as JSON."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(port_map, indent=2) + "\n", encoding="utf-8")


def load_port_map(path: str | Path) -> dict[str, Any]:
    """Read a port map written by probe_hub."""
    loaded: dict[str, Any] = json.loads(Path(path).read_text(encoding="utf-8"))
    return loaded


def port_id(port_map: dict[str, Any], role: str) -> int:
    """Port number for a role, or an error naming the roles this hub does have."""
    roles = port_map["roles"]
    if role not in roles:
        raise RuntimeError(f"Hub has no '{role}' port (has: {', '.join(roles) or 'none'})")
    return int(roles[role], 16)
