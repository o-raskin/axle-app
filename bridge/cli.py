"""Command-line dispatch for the LEGO Technic gamepad bridge."""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Sequence

from .audio import run_audio_probe
from .dashboard import SetupConsole
from .gamepads.input import gamepad_diagnostics, run_probe
from .gamepads.profile_loader import gamepad_profile_candidates
from .hub_probe import save_probe_outputs, scan_hub
from .paths import HUB_SCHEME_PATH, PORT_MAP_PATH
from .protocol import JsonLineEmitter, profile_catalog_json, run_jsonl_frontend
from .session import run_control, wait_for_bluetooth, wait_for_gamepad
from .transport import DEFAULT_HUB_NAME

__all__ = [
    "argv_requests_jsonl",
    "build_parser",
    "main",
    "profile_catalog_json",
    "run",
    "run_hub_scan",
    "run_human_frontend",
]


async def run_hub_scan(name: str, address: str | None) -> None:
    """Scan a Technic Move Hub and save the generated runtime port map."""
    print(f"Scanning for hub: {address or name}. Press the hub power/connect button now.")
    port_map, report = await scan_hub(name, address)
    save_probe_outputs(port_map, report)
    print(report, end="")
    print(f"Saved report to {HUB_SCHEME_PATH}")
    print(f"Saved port map to {PORT_MAP_PATH}")


def build_parser() -> argparse.ArgumentParser:
    """Build the shared human/protocol frontend argument parser."""
    parser = argparse.ArgumentParser(
        description="LEGO Technic gamepad bridge. Run with no arguments to start live control."
    )
    parser.add_argument("--arm", action="store_true", help="Live control with hub (default)")
    parser.add_argument("--probe", action="store_true", help="Log gamepad axes/buttons without connecting to the hub")
    parser.add_argument("--gamepad-devices", action="store_true", help="Print SDL/Pygame gamepad diagnostics and exit")
    parser.add_argument("--scan-hub", action="store_true", help="Scan the hub and save the car port map")
    parser.add_argument(
        "--discover", action="store_true", help="Passively detect nearby hardware (JSONL frontend only)"
    )
    parser.add_argument("--profiles-json", action="store_true", help="Print available profiles as JSON and exit")
    parser.add_argument(
        "--audio-devices",
        action="store_true",
        help="List audio outputs and selected reverse beep device",
    )
    parser.add_argument(
        "--frontend",
        choices=("human", "jsonl"),
        default="human",
        help="Output frontend: human terminal UI or JSON Lines protocol",
    )
    parser.add_argument("--model", default=None, help="Model profile in config/models/; skips startup selector")
    parser.add_argument("--gamepad", default="auto", help="Gamepad profile in config/gamepads/ or 'auto'")
    parser.add_argument("--name", default=DEFAULT_HUB_NAME, help="Technic hub name to scan/connect")
    parser.add_argument("--address", default=None, help="Exact BLE address for a specific Technic hub")
    return parser


async def main(argv: Sequence[str] | None = None) -> int:
    """Parse CLI arguments and dispatch the requested bridge mode."""
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.discover and args.frontend != "jsonl":
        parser.error("--discover requires --frontend jsonl")

    if args.frontend == "jsonl":
        return await run_jsonl_frontend(args, control_stream=sys.stdin)

    await run_human_frontend(args)
    return 0


async def run_human_frontend(args: argparse.Namespace) -> None:
    """Dispatch the existing human terminal frontend."""
    if args.profiles_json:
        print(profile_catalog_json())
    elif args.audio_devices:
        run_audio_probe()
    elif args.gamepad_devices:
        print(gamepad_diagnostics())
    elif args.scan_hub:
        setup = SetupConsole()
        await wait_for_bluetooth(setup)
        setup.stop()
        await run_hub_scan(args.name, args.address)
    elif args.probe:
        setup = SetupConsole()
        pad_candidates = gamepad_profile_candidates(args.gamepad)
        pygame_mod, joystick, _pad = await wait_for_gamepad(setup, pad_candidates)
        setup.stop()
        run_probe(pygame_mod, joystick)
    else:
        await run_control(args.model, args.gamepad, args.name, args.address)


def argv_requests_jsonl(argv: Sequence[str]) -> bool:
    """Return whether raw argv selected the JSONL frontend."""
    for index, value in enumerate(argv):
        if value == "--frontend" and index + 1 < len(argv):
            return argv[index + 1] == "jsonl"
        if value.startswith("--frontend="):
            return value.split("=", 1)[1] == "jsonl"
    return False


def run(argv: Sequence[str] | None = None) -> int:
    """Run the CLI with frontend-aware KeyboardInterrupt handling."""
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    try:
        return asyncio.run(main(raw_argv))
    except KeyboardInterrupt:
        if argv_requests_jsonl(raw_argv):
            emitter = JsonLineEmitter()
            emitter.emit("process/status", status="stopping")
            emitter.emit("exit", reason="interrupted", exitCode=130)
        else:
            print("\nExited.")
        return 130
