"""Model terminal byte fragmentation and mode restoration deterministically."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from bridge import keyboard


def test_fragmented_posix_arrow_does_not_cancel_model_selection(monkeypatch):
    now = [10.0]
    monkeypatch.setattr(keyboard.time, "monotonic", lambda: now[0])
    poller = keyboard.TerminalKeyPoller()
    poller._buffer = b"\x1b"
    assert poller._consume_posix_action() is None
    now[0] += 0.01
    poller._buffer += b"["
    assert poller._consume_posix_action() is None
    poller._buffer += b"A\n"
    assert poller._consume_posix_action() == "up"
    assert poller._consume_posix_action() == "confirm"


def test_lone_escape_cancels_after_bounded_sequence_window(monkeypatch):
    now = [10.0]
    monkeypatch.setattr(keyboard.time, "monotonic", lambda: now[0])
    poller = keyboard.TerminalKeyPoller()
    poller._buffer = b"\x1b"
    assert poller._consume_posix_action() is None
    now[0] += keyboard.ESCAPE_SEQUENCE_TIMEOUT_S + 0.01
    assert poller._consume_posix_action() == "cancel"
    assert poller._consume_posix_action() is None


def test_fragmented_windows_extended_key_retains_its_prefix(monkeypatch):
    queued = [b"\xe0"]
    monkeypatch.setattr(keyboard, "msvcrt", SimpleNamespace(kbhit=lambda: bool(queued), getch=lambda: queued.pop(0)))
    poller = keyboard.TerminalKeyPoller()
    assert poller._poll_windows_action() is None
    queued.append(b"H")
    assert poller._poll_windows_action() == "up"
    queued.extend([b"\x00", b"P", b"\r", b"\x1b"])
    assert poller._poll_windows_action() == "down"
    assert poller._poll_windows_action() == "confirm"
    assert poller._poll_windows_action() == "cancel"


@pytest.mark.parametrize("poller_type", [keyboard.TerminalKeyPoller, keyboard.TerminalExitPoller])
def test_repeated_terminal_open_restores_original_mode_once(monkeypatch, poller_type):
    calls = []
    original = [1, 2, 3]
    monkeypatch.setattr(
        keyboard,
        "termios",
        SimpleNamespace(
            tcgetattr=lambda fd: calls.append("read") or original,
            tcsetattr=lambda fd, when, attrs: calls.append(("restore", attrs)),
            TCSADRAIN=1,
        ),
    )
    monkeypatch.setattr(keyboard, "tty", SimpleNamespace(setcbreak=lambda fd: calls.append("cbreak")))
    poller = poller_type(SimpleNamespace(isatty=lambda: True, fileno=lambda: 42))
    poller.open()
    poller.open()
    poller.close()
    poller.close()
    assert calls == ["read", "cbreak", ("restore", original)]


def test_terminal_context_restores_mode_when_body_fails(monkeypatch):
    restored = []
    monkeypatch.setattr(
        keyboard,
        "termios",
        SimpleNamespace(tcgetattr=lambda fd: [1], tcsetattr=lambda *_args: restored.append(True), TCSADRAIN=1),
    )
    monkeypatch.setattr(keyboard, "tty", SimpleNamespace(setcbreak=lambda fd: None))
    with (
        pytest.raises(RuntimeError, match="input failed"),
        keyboard.TerminalKeyPoller(SimpleNamespace(isatty=lambda: True, fileno=lambda: 42)),
    ):
        raise RuntimeError("input failed")
    assert restored == [True]
