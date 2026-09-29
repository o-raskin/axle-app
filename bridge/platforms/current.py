"""Dispatch platform operations to the active target module."""

from __future__ import annotations

import os

from . import linux, macos, steamdeck_platform, windows
from .common import BluetoothStatus


def configure_process_for_platform() -> None:
    """Apply process-wide compatibility settings before pygame or bleak are imported."""
    os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    steamdeck_platform.apply_sdl_hints()
    windows.configure_com_for_ble()


def release_winrt_sta_for_pygame() -> None:
    """Release Windows WinRT STA state before pygame starts polling controllers."""
    windows.release_winrt_sta_for_pygame()


def bluetooth_status() -> BluetoothStatus:
    """Return whether Bluetooth appears enabled on the current platform."""
    if macos.is_current():
        return macos.bluetooth_status()
    if linux.is_current():
        return linux.bluetooth_status()
    return BluetoothStatus(True, "Bluetooth power check is not implemented for this platform; continuing.")


def is_macos() -> bool:
    """Return whether the process is running on macOS."""
    return macos.is_current()


def is_windows() -> bool:
    """Return whether the process is running on Windows."""
    return windows.is_current()
