"""Test frontend probe ownership and long-running protocol behavior."""

from __future__ import annotations

import asyncio
import json
from io import StringIO
from types import SimpleNamespace

import pytest

from bridge import protocol


@pytest.mark.parametrize("failure", ["metadata", "snapshot", "emit"])
def test_gamepad_probe_releases_pygame_if_initial_publication_fails(monkeypatch, failure):
    closed = []

    def fail(name):
        if name == failure:
            raise RuntimeError(f"{name} unavailable")
        return 6

    joystick = SimpleNamespace(
        get_name=lambda: "Pad", get_numaxes=lambda: fail("metadata"), get_numbuttons=lambda: 16, get_numhats=lambda: 0
    )

    async def wait(*_args):
        return (
            SimpleNamespace(quit=lambda: closed.append(True)),
            joystick,
            SimpleNamespace(name="Pad", profile_id="pad"),
        )

    def take_snapshot(*_args):
        fail("snapshot")
        return {"axes": [], "buttons": [], "hats": []}

    def emit(*_args, **_kwargs):
        fail("emit")

    monkeypatch.setattr(protocol, "wait_for_gamepad", wait)
    monkeypatch.setattr(protocol, "snapshot", take_snapshot)
    out = SimpleNamespace(stream=StringIO(), emit=emit)
    with pytest.raises(RuntimeError, match=failure):
        asyncio.run(protocol.run_protocol_gamepad_probe(out, "auto"))
    assert closed == [True]


def test_live_protocol_logs_remain_bounded_without_dropping_stream_events():
    output = StringIO()
    console = protocol.ProtocolLiveConsole(protocol.JsonLineEmitter(output))
    for index in range(1000):
        console.log(f"command {index}")
    assert len(console.logs) <= 120
    assert console.logs[-1] == "command 999"
    records = [json.loads(line) for line in output.getvalue().splitlines()]
    assert len(records) == 1000
    assert records[0]["message"] == "command 0"


def test_telemetry_throttle_uses_clock_and_start_always_publishes(monkeypatch):
    output = StringIO()
    now = [10.0]
    monkeypatch.setattr(protocol.time, "monotonic", lambda: now[0])
    console = protocol.ProtocolLiveConsole(protocol.JsonLineEmitter(output), 0.1)
    state = protocol.CarTelemetry("Model", "Hub", 100, 100)
    console.start(state)
    now[0] += 0.05
    console.update(state)
    now[0] += 0.06
    console.update(state)
    console.start(state)
    assert len(output.getvalue().splitlines()) == 3
