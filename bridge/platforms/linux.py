"""Linux and SteamOS platform readiness hooks."""

from __future__ import annotations

import sys
from pathlib import Path

from .common import BluetoothStatus, run_status_command


def is_current() -> bool:
    """Return whether the current process runs on Linux."""
    return sys.platform.startswith("linux")


def bluetooth_status() -> BluetoothStatus:
    """Check Linux/SteamOS Bluetooth power through BlueZ tools."""
    status = run_status_command(["bluetoothctl", "show"])
    output = status.output_lower
    if "powered: yes" in output:
        return BluetoothStatus(True, "Bluetooth is powered on.")
    if "powered: no" in output:
        return BluetoothStatus(False, "Bluetooth is powered off.")
    if "no default controller available" in output:
        return BluetoothStatus(False, "No default Bluetooth controller is available.")
    if status.missing:
        return LinuxSysfsBluetoothProbe().status()
    if status.returncode != 0:
        return BluetoothStatus(False, f"Could not read Bluetooth status: {status.stderr.strip()}")
    return BluetoothStatus(False, "Could not confirm that Bluetooth is powered on.")


class LinuxSysfsBluetoothProbe:
    """Fallback Linux probe used when bluetoothctl is unavailable."""

    def __init__(self, root: Path = Path("/sys/class/bluetooth")) -> None:
        """Store the sysfs Bluetooth root."""
        self.root = root

    def status(self) -> BluetoothStatus:
        """Return a conservative readiness result from sysfs."""
        adapters = sorted(self.root.glob("hci*"))
        if not adapters:
            return BluetoothStatus(False, "bluetoothctl is unavailable and no Bluetooth adapter was found.")
        return BluetoothStatus(
            True,
            "bluetoothctl is unavailable; found a Bluetooth adapter but could not confirm power state.",
        )
