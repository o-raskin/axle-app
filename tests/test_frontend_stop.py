from __future__ import annotations

import asyncio
import json
import os
import threading
from io import StringIO
from types import SimpleNamespace

import pytest

from bridge import protocol


@pytest.mark.parametrize("stop_mode", ["command", "parent-eof"])
def test_frontend_stop_awaits_cleanup_before_exiting(monkeypatch: pytest.MonkeyPatch, stop_mode: str) -> None:
    output = StringIO()
    cleaned = []
    read_fd, write_fd = os.pipe()
    invalid_processed = threading.Event()
    original_read = os.read
    read_calls = 0

    def read_control(fd: int, size: int) -> bytes:
        nonlocal read_calls
        if fd == read_fd:
            read_calls += 1
            if read_calls == 2:
                invalid_processed.set()
        return original_read(fd, size)

    monkeypatch.setattr(protocol.os, "read", read_control)

    async def scenario() -> int:
        started = asyncio.Event()
        cleanup_started = asyncio.Event()
        cleanup_release = asyncio.Event()

        async def live(*args: object) -> None:
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleanup_started.set()
                await cleanup_release.wait()
                cleaned.append(True)

        monkeypatch.setattr(protocol, "run_protocol_live_control", live)
        args = SimpleNamespace(
            profiles_json=False,
            audio_devices=False,
            gamepad_devices=False,
            scan_hub=False,
            probe=False,
            model="tumbler",
            gamepad="auto",
            name="hub",
            address=None,
        )
        with os.fdopen(read_fd, "r", encoding="utf-8") as control:
            task = asyncio.create_task(protocol.run_jsonl_frontend(args, protocol.JsonLineEmitter(output), control))
            await started.wait()
            if stop_mode == "command":
                os.write(write_fd, b'{"type":"control/stop"}\n')  # Invalid envelope must be ignored.
                assert await asyncio.to_thread(invalid_processed.wait, 1)
                assert not task.done()
                message = json.dumps({"protocol": protocol.PROTOCOL_NAME, "version": 1, "type": "control/stop"})
                os.write(write_fd, message[:10].encode())
                os.write(write_fd, message[10:].encode() + b"\n")
            else:
                os.close(write_fd)
            await asyncio.wait_for(cleanup_started.wait(), timeout=3)
            assert not task.done(), "Frontend exit must wait for asynchronous cleanup"
            cleanup_release.set()
            return await asyncio.wait_for(task, timeout=3)

    try:
        assert asyncio.run(scenario()) == 130
    finally:
        if stop_mode == "command":
            os.close(write_fd)
    assert cleaned == [True]
    events = [json.loads(line) for line in output.getvalue().splitlines()]
    assert events[-1]["type"] == "exit"
    assert events[-1]["reason"] == "cancelled"
    assert not any(event["type"] == "error" for event in events)
