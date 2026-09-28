"""Bluetooth readiness checks for startup flows that need BLE."""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class BluetoothStatus:
    """One platform Bluetooth readiness result."""

    ready: bool
    detail: str


def bluetooth_status() -> BluetoothStatus:
    """Return whether Bluetooth appears enabled on this platform."""
    if sys.platform == "darwin":
        return macos_bluetooth_status()
    if sys.platform.startswith("linux"):
        return linux_bluetooth_status()
    return BluetoothStatus(True, "Bluetooth power check is not implemented for this platform; continuing.")


def macos_bluetooth_status() -> BluetoothStatus:
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


def linux_bluetooth_status() -> BluetoothStatus:
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


@dataclass(frozen=True)
class CommandStatus:
    """Captured command output used by platform Bluetooth probes."""

    returncode: int
    stdout: str = ""
    stderr: str = ""
    missing: bool = False

    @property
    def output_lower(self) -> str:
        """Return stdout and stderr in one case-folded string."""
        return f"{self.stdout}\n{self.stderr}".lower()


def run_status_command(command: list[str]) -> CommandStatus:
    """Run one short platform status command, returning captured output."""
    try:
        result = subprocess.run(command, capture_output=True, check=False, text=True, timeout=4)
    except FileNotFoundError:
        return CommandStatus(127, stderr=f"{command[0]} not found", missing=True)
    except subprocess.TimeoutExpired:
        return CommandStatus(124, stderr=f"{command[0]} timed out")
    return CommandStatus(result.returncode, result.stdout, result.stderr)


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
