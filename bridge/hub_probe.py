"""Technic Move Hub probing and report generation."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .paths import HUB_SCHEME_PATH, PORT_MAP_PATH
from .port_map import normalize_port_map, save_port_map
from .transport import DEFAULT_HUB_NAME, TechnicMoveHub


def describe_capabilities(bits: int | None) -> str:
    """Return a readable capability list from the hub's bit field."""
    if bits is None:
        return "<unknown>"

    flags = []
    if bits & 0x01:
        flags.append("output")
    if bits & 0x02:
        flags.append("input")
    if bits & 0x04:
        flags.append("logical-combinable")
    if bits & 0x08:
        flags.append("logical-synchronizable")
    return ", ".join(flags) if flags else "<none>"


def bitmask_to_modes(mask: int | None) -> str:
    """Return the set mode indexes in a 16-bit mode mask."""
    if mask is None:
        return "<unknown>"
    modes = [str(index) for index in range(16) if mask & (1 << index)]
    return ", ".join(modes) if modes else "<none>"


def describe_topology(hub: TechnicMoveHub) -> list[str]:
    """One human-readable line per attached device."""
    lines = []
    for port_id in sorted(hub.attached_devices):
        device = hub.attached_devices[port_id]
        line = f"Port 0x{device.port_id:02X}: {device.io_type_name}"
        if device.virtual_ports:
            line += f" (virtual from 0x{device.virtual_ports[0]:02X} + 0x{device.virtual_ports[1]:02X})"
        lines.append(line)
    return lines


def build_report(hub: TechnicMoveHub, port_map: dict[str, Any]) -> str:
    """Build the text report written beside the generated port map."""
    lines = [
        "LEGO hub scheme probe",
        "",
        f"Hub name hint: {hub.hub_name}",
        f"Hub address hint: {hub.hub_address or '<scan by name>'}",
        "",
        "Detected attached I/O:",
    ]

    topology = describe_topology(hub)
    if topology:
        lines.extend(f"- {line}" for line in topology)
    else:
        lines.append("- No attached devices were reported by the hub")

    lines.append("")
    lines.append("Port information:")

    if hub.port_infos:
        for port_id in sorted(hub.port_infos):
            port_info = hub.port_infos[port_id]
            lines.append(f"- Port 0x{port_id:02X}")
            lines.append(f"  capabilities: {describe_capabilities(port_info.capabilities)}")
            modes = port_info.total_mode_count
            lines.append(f"  total modes: {modes if modes is not None else '<unknown>'}")
            lines.append(f"  input modes: {bitmask_to_modes(port_info.input_modes)}")
            lines.append(f"  output modes: {bitmask_to_modes(port_info.output_modes)}")

            for mode_id in sorted(port_info.mode_infos):
                mode = port_info.mode_infos[mode_id]
                lines.append(
                    f"  mode {mode_id}: "
                    f"name={mode.name or '<unknown>'}, "
                    f"symbol={mode.symbol or '<none>'}, "
                    f"mapping={f'0x{mode.mapping:04X}' if mode.mapping is not None else '<unknown>'}, "
                    f"value_format={mode.value_format or '<unknown>'}"
                )
    else:
        lines.append("- No detailed port information was returned")

    lines.append("")
    lines.append("Normalized port map:")
    if port_map["roles"]:
        for role, port in sorted(port_map["roles"].items()):
            lines.append(f"- {role}: {port}")
    else:
        lines.append("- No roles inferred")

    return "\n".join(lines) + "\n"


async def scan_hub(name: str = DEFAULT_HUB_NAME, address: str | None = None) -> tuple[dict[str, Any], str]:
    """Connect to a hub, inspect it, and return the normalized port map and report."""
    hub = TechnicMoveHub(hub_name=name, hub_address=address)
    await hub.connect()
    try:
        await hub.inspect_ports()
        port_map = normalize_port_map(hub)
        return port_map, build_report(hub, port_map)
    finally:
        await hub.disconnect()


def save_probe_outputs(
    port_map: dict[str, Any],
    report: str,
    port_map_path: str | Path = PORT_MAP_PATH,
    report_path: str | Path = HUB_SCHEME_PATH,
) -> None:
    """Persist the scan outputs, creating the runtime state directory when needed."""
    report_target = Path(report_path)
    report_target.parent.mkdir(parents=True, exist_ok=True)
    report_target.write_text(report, encoding="utf-8")
    save_port_map(port_map_path, port_map)
