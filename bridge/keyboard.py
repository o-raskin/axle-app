"""Small terminal keyboard poller for live-session exit shortcuts."""

from __future__ import annotations

import os
import select
import sys
from types import TracebackType
from typing import IO, Any, Type, cast

try:
    import msvcrt
except ImportError:  # pragma: no cover - exercised only on Windows
    msvcrt = None  # type: ignore[assignment]

try:
    import termios
    import tty
except ImportError:  # pragma: no cover - exercised only on non-POSIX platforms
    termios = None  # type: ignore[assignment]
    tty = None  # type: ignore[assignment]

ESCAPE = b"\x1b"


class TerminalExitPoller:
    """Read ESC from a TTY without blocking the control loop."""

    def __init__(self, stream: IO[str] | None = None) -> None:
        """Store the input stream and terminal state placeholders."""
        self.stream = stream or sys.stdin
        self._fd: int | None = None
        self._original_attrs: list[int | list[bytes | int]] | None = None

    def __enter__(self) -> "TerminalExitPoller":
        """Start polling and return this poller."""
        self.open()
        return self

    def __exit__(
        self,
        _exc_type: Type[BaseException] | None,
        _exc: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        """Restore terminal state when leaving the live loop."""
        self.close()

    def open(self) -> None:
        """Put the input TTY into cbreak mode when possible."""
        if termios is None or tty is None:
            return
        if not hasattr(self.stream, "isatty") or not self.stream.isatty():
            return
        try:
            self._fd = self.stream.fileno()
            self._original_attrs = termios.tcgetattr(self._fd)
            tty.setcbreak(self._fd)
        except OSError:
            self._fd = None
            self._original_attrs = None

    def close(self) -> None:
        """Restore the original terminal mode."""
        if termios is None or self._fd is None or self._original_attrs is None:
            return
        try:
            termios.tcsetattr(self._fd, termios.TCSADRAIN, self._original_attrs)
        except OSError:
            pass
        finally:
            self._fd = None
            self._original_attrs = None

    def exit_requested(self) -> bool:
        """Return whether ESC was pressed since the previous poll."""
        if msvcrt is not None:
            msvcrt_mod = cast(Any, msvcrt)
            while msvcrt_mod.kbhit():
                if msvcrt_mod.getch() == ESCAPE:
                    return True
            return False
        if self._fd is None:
            return False
        try:
            readable, _, _ = select.select([self._fd], [], [], 0)
            if not readable:
                return False
            return ESCAPE in os.read(self._fd, 32)
        except OSError:
            return False
