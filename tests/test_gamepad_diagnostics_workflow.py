"""Controller inventory and human probing use real workflows over fake SDL boundaries."""

from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from bridge.gamepads import input as gamepad


@pytest.mark.parametrize("failure", ["open", "init", "name", "axes", "close"])
def test_diagnostics_reports_vanished_controller_and_continues_inventory_with_cleanup(
    monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    closed = []
    lifecycle = []

    def init() -> None:
        if failure == "init":
            raise RuntimeError("device disappeared")

    def name() -> str:
        if failure in {"name", "close"}:
            raise RuntimeError("device disappeared")
        return "Vanished fixture"

    def axes() -> int:
        raise RuntimeError("device disappeared")

    def close() -> None:
        closed.append("vanished")
        if failure == "close":
            raise OSError("device already closed")

    def unsupported() -> None:
        raise OSError("driver does not report GUID")

    vanished = SimpleNamespace(init=init, get_name=name, get_numaxes=axes, quit=close)
    available = SimpleNamespace(
        init=lambda: None,
        get_name=lambda: "Steam Virtual Gamepad",
        get_guid=unsupported,
        get_instance_id=lambda: 77,
        get_numaxes=lambda: 6,
        get_numbuttons=lambda: 21,
        get_numhats=lambda: 0,
        quit=lambda: closed.append("available"),
    )
    devices = [vanished, available]

    def open_joystick(index: int) -> SimpleNamespace:
        if index == 0 and failure == "open":
            raise RuntimeError("device disappeared")
        return devices[index]

    joystick_module = SimpleNamespace(
        get_init=lambda: True,
        quit=lambda: lifecycle.append("joystick quit"),
        init=lambda: lifecycle.append("joystick init"),
        get_count=lambda: len(devices),
        Joystick=open_joystick,
    )

    def controller_name(index: int) -> str:
        if index == 0:
            raise RuntimeError("SDL candidate disappeared")
        return "Steam Virtual Gamepad"

    controllers = SimpleNamespace(
        get_init=lambda: True,
        quit=lambda: lifecycle.append("SDL quit"),
        init=lambda: lifecycle.append("SDL init"),
        get_count=lambda: 2,
        name_forindex=controller_name,
        is_controller=lambda index: index == 1,
        Controller=lambda _index: pytest.fail("Inventory must not open game controllers"),
    )
    pygame = SimpleNamespace(
        version=SimpleNamespace(ver="fixture"),
        get_sdl_version=lambda: (2, 28, 4),
        joystick=joystick_module,
        quit=lambda: closed.append("pygame"),
    )
    monkeypatch.setitem(sys.modules, "pygame", pygame)
    monkeypatch.setattr(gamepad, "configure_process_for_platform", lambda: None)
    monkeypatch.setattr(gamepad, "sdl2_controller_module", lambda _pygame: controllers)
    report = gamepad.gamepad_diagnostics()
    assert "pygame=fixture" in report and "sdl=2.28.4" in report
    assert "controller_count=2" in report and "joystick_count=2" in report
    assert "controller[0].name=error:RuntimeError:SDL candidate disappeared" in report
    assert "joystick[0].error=RuntimeError:device disappeared" in report
    assert "joystick[1].name=Steam Virtual Gamepad" in report
    assert "joystick[1].guid=error:OSError:driver does not report GUID" in report
    assert "joystick[1].instance_id=77" in report and "joystick[1].power=unknown" in report
    assert "joystick[1].axes=6" in report and "joystick[1].buttons=21" in report
    assert closed == (["vanished"] if failure != "open" else []) + ["available", "pygame"]
    assert lifecycle == ["SDL quit", "joystick quit", "joystick init", "SDL init"]


def test_diagnostics_releases_pygame_when_subsystem_initialization_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    closed = []
    pygame = SimpleNamespace(
        version=SimpleNamespace(ver="fixture"), get_sdl_version=lambda: (2, 28, 4), quit=lambda: closed.append(True)
    )
    failure = RuntimeError("SDL initialization failed")

    def initialize(_pygame: SimpleNamespace, **_kwargs: bool) -> None:
        raise failure

    monkeypatch.setitem(sys.modules, "pygame", pygame)
    monkeypatch.setattr(gamepad, "configure_process_for_platform", lambda: None)
    monkeypatch.setattr(gamepad, "refresh_joystick_subsystem", initialize)
    with pytest.raises(RuntimeError, match="SDL initialization failed") as error:
        gamepad.gamepad_diagnostics()
    assert error.value is failure and closed == [True]


@pytest.mark.parametrize("interruption", [KeyboardInterrupt, RuntimeError])
def test_human_probe_reports_changed_controls_and_releases_pygame_on_exit(
    capsys: pytest.CaptureFixture[str], interruption: type[BaseException]
) -> None:
    state = {"axis": 0.0, "button": 0, "hat": (0, 0), "polls": 0}
    closed = []
    delays = []

    def poll() -> None:
        state["polls"] += 1
        if state["polls"] == 1:
            state["axis"] = 0.001
        elif state["polls"] == 2:
            state.update(axis=0.75, button=1, hat=(1, 0))
        else:
            raise interruption("controller gone or user exit")

    joystick = SimpleNamespace(
        get_name=lambda: "Probe fixture",
        get_numaxes=lambda: 1,
        get_numbuttons=lambda: 1,
        get_numhats=lambda: 1,
        get_axis=lambda _index: state["axis"],
        get_button=lambda _index: state["button"],
        get_hat=lambda _index: state["hat"],
    )
    pygame = SimpleNamespace(
        event=SimpleNamespace(pump=poll), time=SimpleNamespace(delay=delays.append), quit=lambda: closed.append(True)
    )
    if interruption is RuntimeError:
        with pytest.raises(RuntimeError, match="controller gone"):
            gamepad.run_probe(pygame, joystick)
    else:
        gamepad.run_probe(pygame, joystick)
    output = capsys.readouterr().out
    assert "Gamepad: Probe fixture" in output
    assert "0.001 -> 0.75" in output
    assert "button[0] 0 -> 1" in output and "hat[0] (0, 0) -> (1, 0)" in output
    assert "0.0 -> 0.001" not in output
    assert closed == [True] and delays == [30, 30]


@pytest.mark.parametrize("method", ["get_name", "get_numaxes", "get_axis", "get_button", "get_hat"])
def test_human_probe_initial_metadata_and_snapshot_failures_still_release_pygame(method: str) -> None:
    closed = []
    failure = RuntimeError("controller disappeared before probe started")

    def fail(*_args: int) -> None:
        raise failure

    joystick = SimpleNamespace(
        get_name=lambda: "Probe fixture",
        get_numaxes=lambda: 1,
        get_numbuttons=lambda: 1,
        get_numhats=lambda: 1,
        get_axis=lambda _index: 0.0,
        get_button=lambda _index: 0,
        get_hat=lambda _index: (0, 0),
    )
    setattr(joystick, method, fail)
    pygame = SimpleNamespace(
        event=SimpleNamespace(pump=lambda: pytest.fail("No input polling follows an initialization failure")),
        quit=lambda: closed.append(True),
    )
    with pytest.raises(RuntimeError, match="before probe started") as error:
        gamepad.run_probe(pygame, joystick)
    assert error.value is failure and closed == [True]
