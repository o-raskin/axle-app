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
ENTER_KEYS = {b"\r", b"\n"}
POSIX_UP = b"\x1b[A"
POSIX_DOWN = b"\x1b[B"
POSIX_ARROW_PREFIX = b"\x1b["
POSIX_ARROW_SEQUENCE_LEN = 3
WINDOWS_EXTENDED_PREFIXES = {b"\x00", b"\xe0"}
WINDOWS_UP = b"H"
WINDOWS_DOWN = b"P"


class TerminalKeyPoller:
    """Read menu navigation keys from a TTY without blocking."""

    def __init__(self, stream: IO[str] | None = None) -> None:
        """Store the input stream and terminal state placeholders."""
        self.stream = stream or sys.stdin
        self._fd: int | None = None
        self._original_attrs: list[int | list[bytes | int]] | None = None
        self._buffer = b""

    def __enter__(self) -> "TerminalKeyPoller":
        """Start polling and return this poller."""
        self.open()
        return self

    def __exit__(
        self,
        _exc_type: Type[BaseException] | None,
        _exc: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        """Restore terminal state when leaving the menu."""
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

    def poll_action(self) -> str | None:
        """Return up, down, confirm, cancel, or None for no menu input."""
        if msvcrt is not None:
            return self._poll_windows_action()
        if self._fd is None:
            return None
        try:
            readable, _, _ = select.select([self._fd], [], [], 0)
            if readable:
                self._buffer += os.read(self._fd, 32)
        except OSError:
            return None
        return self._consume_posix_action()

    def _poll_windows_action(self) -> str | None:
        msvcrt_mod = cast(Any, msvcrt)
        while msvcrt_mod.kbhit():
            key = msvcrt_mod.getch()
            if key in ENTER_KEYS:
                return "confirm"
            if key == ESCAPE:
                return "cancel"
            if key in WINDOWS_EXTENDED_PREFIXES and msvcrt_mod.kbhit():
                extended = msvcrt_mod.getch()
                if extended == WINDOWS_UP:
                    return "up"
                if extended == WINDOWS_DOWN:
                    return "down"
        return None

    def _consume_posix_action(self) -> str | None:
        action = None
        if not self._buffer:
            return action
        if self._buffer.startswith(POSIX_ARROW_PREFIX) and len(self._buffer) < POSIX_ARROW_SEQUENCE_LEN:
            return action
        if self._buffer.startswith(POSIX_UP):
            self._buffer = self._buffer[len(POSIX_UP) :]
            action = "up"
        elif self._buffer.startswith(POSIX_DOWN):
            self._buffer = self._buffer[len(POSIX_DOWN) :]
            action = "down"
        else:
            key = self._buffer[:1]
            self._buffer = self._buffer[1:]
            if key in ENTER_KEYS:
                action = "confirm"
            elif key == ESCAPE:
                action = "cancel"
        return action


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
