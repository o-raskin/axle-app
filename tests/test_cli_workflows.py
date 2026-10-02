"""Verify mode selection, dispatch, and machine-readable failure contracts."""

from __future__ import annotations

import asyncio
import json
from io import StringIO

import pytest

from bridge import cli, protocol


@pytest.mark.parametrize(
    "first,second",
    [
        ("--discover", "--audio-devices"),
        ("--probe", "--scan-hub"),
        ("--arm", "--profiles-json"),
        ("--gamepad-devices", "--audio-devices"),
    ],
)
def test_conflicting_operations_are_rejected_before_touching_hardware(first, second):
    with pytest.raises(SystemExit) as exc:
        cli.build_parser().parse_args([first, second])
    assert exc.value.code == 2


@pytest.mark.parametrize(
    "argv, expected",
    [
        (["--frontend", "human", "--frontend", "jsonl"], True),
        (["--frontend=jsonl", "--frontend=human"], False),
        (["--model", "tumbler"], False),
    ],
)
def test_interrupt_frontend_matches_last_parsed_frontend_option(argv, expected):
    assert cli.argv_requests_jsonl(argv) is expected


def test_passive_discovery_requires_protocol_frontend():
    with pytest.raises(SystemExit) as exc:
        asyncio.run(cli.main(["--discover"]))
    assert exc.value.code == 2


@pytest.mark.parametrize(
    "mode, expected",
    [
        ("--profiles-json", "profiles"),
        ("--audio-devices", "audioDevices"),
        ("--gamepad-devices", "gamepadDevices"),
        ("--discover", "discover"),
        ("--scan-hub", "scanHub"),
        ("--probe", "probeGamepad"),
        ("--arm", "live"),
    ],
)
def test_each_protocol_operation_dispatches_and_reports_complete(monkeypatch, mode, expected):
    output = StringIO()
    calls = []

    async def operation(*_args):
        calls.append(expected)

    monkeypatch.setattr(protocol, "run_protocol_live_control", operation)
    monkeypatch.setattr(protocol, "run_protocol_gamepad_probe", operation)
    monkeypatch.setattr(protocol, "run_protocol_hub_scan", operation)
    monkeypatch.setattr(protocol, "discover_hardware", operation)
    monkeypatch.setattr(protocol, "audio_probe_report", lambda: "audio fixture")
    monkeypatch.setattr(protocol, "audio_probe_payload", lambda report: {"report": report})
    monkeypatch.setattr(protocol, "gamepad_diagnostics", lambda: "controller fixture")
    args = cli.build_parser().parse_args([mode, "--frontend", "jsonl"])
    assert asyncio.run(protocol.run_jsonl_frontend(args, protocol.JsonLineEmitter(output))) == 0
    records = [json.loads(line) for line in output.getvalue().splitlines()]
    assert records[0]["operation"] == expected
    assert records[-1]["type"] == "exit" and records[-1]["reason"] == "complete"
    if expected in {"profiles", "audioDevices", "gamepadDevices"}:
        result = next(record for record in records if record["type"] == "command/result")
        assert result["command"] == expected and result["ok"] is True
    else:
        assert calls == [expected]


@pytest.mark.parametrize(
    "failure, code, reason",
    [(RuntimeError, 1, "error"), (asyncio.CancelledError, 130, "cancelled"), (KeyboardInterrupt, 130, "interrupted")],
)
def test_protocol_dependency_failures_have_one_terminal_exit(monkeypatch, failure, code, reason):
    async def fail(*_args):
        raise failure("fixture failure")

    monkeypatch.setattr(protocol, "run_protocol_live_control", fail)
    output = StringIO()
    args = cli.build_parser().parse_args(["--frontend=jsonl", "--model=tumbler"])
    assert asyncio.run(protocol.run_jsonl_frontend(args, protocol.JsonLineEmitter(output))) == code
    records = [json.loads(line) for line in output.getvalue().splitlines()]
    exits = [record for record in records if record["type"] == "exit"]
    assert len(exits) == 1 and exits[0]["reason"] == reason and exits[0]["exitCode"] == code
    assert any(record["type"] == "error" for record in records) == (failure is RuntimeError)


def test_human_diagnostics_dispatch_without_bluetooth(monkeypatch, capsys):
    monkeypatch.setattr(cli, "gamepad_diagnostics", lambda: "inventory without hardware connection")
    assert asyncio.run(cli.main(["--gamepad-devices"])) == 0
    assert capsys.readouterr().out == "inventory without hardware connection\n"
