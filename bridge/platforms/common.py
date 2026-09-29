"""Shared platform helper types."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass


@dataclass(frozen=True)
class BluetoothStatus:
    """One platform Bluetooth readiness result."""

    ready: bool
    detail: str


@dataclass(frozen=True)
class CommandStatus:
    """Captured command output used by platform status probes."""

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
