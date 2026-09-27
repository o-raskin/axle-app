"""Compatibility entry point for scanning a Technic Move Hub."""

from __future__ import annotations

import argparse
import asyncio

from bridge.hub_probe import (
    bitmask_to_modes,
    build_report,
    describe_capabilities,
    describe_topology,
    save_probe_outputs,
    scan_hub,
)
from bridge.paths import HUB_SCHEME_PATH, PORT_MAP_PATH
from bridge.transport import DEFAULT_HUB_NAME

OUTPUT_PATH = HUB_SCHEME_PATH

__all__ = [
    "OUTPUT_PATH",
    "bitmask_to_modes",
    "build_report",
    "describe_capabilities",
    "describe_topology",
    "main",
]


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", default=DEFAULT_HUB_NAME)
    parser.add_argument("--address", default=None)
    args = parser.parse_args()

    print(f"Scanning for hub: {args.address or args.name}. Press the hub power/connect button now.")
    port_map, report = await scan_hub(args.name, args.address)
    save_probe_outputs(port_map, report)
    print(report, end="")
    print(f"Saved report to {HUB_SCHEME_PATH}")
    print(f"Saved port map to {PORT_MAP_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
