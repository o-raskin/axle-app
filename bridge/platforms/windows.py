"""Windows-specific COM and WinRT hooks used by Bleak and Pygame."""

from __future__ import annotations

import sys
from typing import Any, cast


def is_current() -> bool:
    """Return whether the current process runs on Windows."""
    return sys.platform == "win32"


def configure_com_for_ble() -> None:
    """Set the COM apartment model Bleak needs before WinRT imports initialize COM."""
    if is_current():
        sys.coinit_flags = 0  # type: ignore[attr-defined]


def release_winrt_sta_for_pygame() -> None:
    """Release Bleak's WinRT STA state before pygame starts polling controllers."""
    if not is_current():
        return

    from bleak.backends.winrt.util import allow_sta, uninitialize_sta  # noqa: PLC0415

    cast(Any, uninitialize_sta)()
    cast(Any, allow_sta)()
