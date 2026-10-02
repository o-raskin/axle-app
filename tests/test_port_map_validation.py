"""Keep corrupt persisted hub maps away from live motor commands."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from bridge import port_map, session
from bridge.transport import IO_DRIVE_MOTOR, IO_LIGHTS, AttachedDevice


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        7,
        {"hub": {}, "roles": {}},
        {"hub": {"name": "Hub", "address": 9}, "roles": {}},
        {"hub": {"name": "Hub"}, "roles": {"drive_left": "0x100"}},
        {"hub": {"name": "Hub"}, "roles": {"drive_left": "-1"}},
        {"hub": {"name": "Hub"}, "roles": {"drive_left": True}},
        {"hub": {"name": "Hub"}, "roles": {"drive_left": []}},
    ],
)
def test_invalid_saved_map_requests_rescan_instead_of_crashing(tmp_path, monkeypatch, value):
    path = tmp_path / "port_map.json"
    path.write_text(json.dumps(value))
    monkeypatch.setattr(session, "PORT_MAP_PATH", path)
    messages = []
    setup = SimpleNamespace(show=lambda *args: messages.append(args))
    assert session.load_port_map_for_drive(setup) is None
    assert messages and "scan" in str(messages).lower()


@pytest.mark.parametrize("value", [None, True, [], "0x100", "-0x01", "wrong"])
def test_invalid_role_port_has_actionable_error(value):
    with pytest.raises(RuntimeError, match="drive_left"):
        port_map.port_id({"roles": {"drive_left": value}}, "drive_left")


def test_map_rejects_wrong_device_type_for_drive_role():
    device = AttachedDevice(0x32, 1, IO_LIGHTS, "Lights")
    hub = SimpleNamespace(attached_devices={0x32: device})
    issue = session.required_hub_port_issue(hub, {"roles": {"drive_left": "0x32"}}, ["drive_left"])
    assert issue is not None and "drive_left" in issue


def test_map_rejects_two_drive_roles_using_one_motor():
    device = AttachedDevice(0x32, 1, IO_DRIVE_MOTOR, "Drive")
    hub = SimpleNamespace(attached_devices={0x32: device})
    issue = session.required_hub_port_issue(
        hub, {"roles": {"drive_left": "0x32", "drive_right": "0x32"}}, ["drive_left", "drive_right"]
    )
    assert issue is not None


def test_failed_atomic_map_replace_preserves_previous_scan(tmp_path, monkeypatch):
    path = tmp_path / "port_map.json"
    original = {"hub": {"name": "First"}, "roles": {}}
    port_map.save_port_map(path, original)

    def fail_replace(*_args):
        raise OSError("disk write failed")

    monkeypatch.setattr(port_map.os, "replace", fail_replace)
    with pytest.raises(OSError, match="disk write"):
        port_map.save_port_map(path, {"hub": {"name": "Second"}, "roles": {}})
    assert port_map.load_port_map(path) == original
    assert list(tmp_path.iterdir()) == [path]
