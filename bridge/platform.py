"""Small platform hooks used before hardware libraries are imported."""

from __future__ import annotations

import os
import sys


def configure_process_for_platform() -> None:
    """Apply process-wide compatibility settings before pygame or bleak are imported."""
    os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    if sys.platform == "win32":
        # Bleak/WinRT needs an MTA. This must be set before bleak imports initialize COM.
        sys.coinit_flags = 0  # type: ignore[attr-defined]


def release_winrt_sta_for_pygame() -> None:
    """Release Bleak's WinRT STA state before pygame starts polling controllers."""
    if sys.platform != "win32":
        return

    from bleak.backends.winrt.util import allow_sta, uninitialize_sta  # noqa: PLC0415

    uninitialize_sta()
    allow_sta()


def is_macos() -> bool:
    """Return whether the process is running on macOS."""
    return sys.platform == "darwin"


def is_windows() -> bool:
    """Return whether the process is running on Windows."""
    return sys.platform == "win32"
