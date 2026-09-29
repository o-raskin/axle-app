"""macOS platform readiness and process hooks."""

from __future__ import annotations

import sys

from .common import BluetoothStatus, run_status_command


def is_current() -> bool:
    """Return whether the current process runs on macOS."""
    return sys.platform == "darwin"


def bluetooth_status() -> BluetoothStatus:
    """Check the macOS Bluetooth controller power state."""
    defaults = run_status_command(
        ["defaults", "read", "/Library/Preferences/com.apple.Bluetooth", "ControllerPowerState"]
    )
    value = defaults.stdout.strip()
    if defaults.returncode == 0 and value == "1":
        return BluetoothStatus(True, "Bluetooth is powered on.")
    if defaults.returncode == 0 and value == "0":
        return BluetoothStatus(False, "Bluetooth is powered off in macOS settings.")

    profiler = run_status_command(["system_profiler", "SPBluetoothDataType"])
    output = profiler.output_lower
    if "state: on" in output or "bluetooth power: on" in output:
        return BluetoothStatus(True, "Bluetooth is powered on.")
    if "state: off" in output or "bluetooth power: off" in output:
        return BluetoothStatus(False, "Bluetooth is powered off in macOS settings.")
    if profiler.returncode != 0:
        return BluetoothStatus(False, f"Could not read macOS Bluetooth status: {profiler.stderr.strip()}")
    return BluetoothStatus(False, "Could not confirm that macOS Bluetooth is powered on.")
