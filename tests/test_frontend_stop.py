from __future__ import annotations

import asyncio
import json
import os
from io import StringIO
from types import SimpleNamespace

import pytest

from bridge import protocol


@pytest.mark.parametrize("stop_mode", ["command", "parent-eof"])
def test_frontend_stop_awaits_cleanup_before_exiting(monkeypatch: pytest.MonkeyPatch, stop_mode: str) -> None:
    output = StringIO()
    cleaned = []
    read_fd, write_fd = os.pipe()

    async def scenario() -> int:
        started = asyncio.Event()

        async def live(*args: object) -> None:
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0.01)
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
                await asyncio.sleep(0.02)
                assert not task.done()
                message = json.dumps({"protocol": protocol.PROTOCOL_NAME, "version": 1, "type": "control/stop"})
                os.write(write_fd, message[:10].encode())
                os.write(write_fd, message[10:].encode() + b"\n")
            else:
                os.close(write_fd)
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
