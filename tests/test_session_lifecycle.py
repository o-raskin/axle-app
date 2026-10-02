"""Verify failure cleanup and handoff ownership without physical hardware."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from bleak.exc import BleakError

from bridge import hub_probe, session
from bridge.cars.model_profiles import ModelProfile
from bridge.gamepads.profile_loader import GamepadProfile
from bridge.settings import SESSION_EXIT


@pytest.mark.parametrize("failure", ["led", "log", "stop", "disconnect"])
def test_shutdown_releases_all_resources_even_when_one_step_fails(failure):
    calls = []

    def step(name):
        calls.append(name)
        if failure == name:
            raise RuntimeError(f"{name} failed")

    async def drive(*args, **kwargs):
        assert args == (0, 0) and kwargs == {"lights": False}
        step("stop")

    async def disconnect():
        step("disconnect")

    hub = SimpleNamespace(is_connected=True, disconnect=disconnect)
    asyncio.run(
        session.safe_shutdown(
            SimpleNamespace(drive=drive),
            hub,
            SimpleNamespace(quit=lambda: step("pygame")),
            SimpleNamespace(close=lambda: step("led")),
            log=lambda _: step("log"),
        )
    )
    assert all(name in calls for name in ("stop", "disconnect", "led", "pygame"))
    assert calls.index("stop") < calls.index("disconnect") < calls.index("pygame")


@pytest.mark.parametrize("stalled_step", ["stop", "disconnect"])
def test_shutdown_times_out_stalled_ble_io_and_still_quits_pygame(monkeypatch, stalled_step):
    monkeypatch.setattr(session, "SHUTDOWN_TIMEOUT_S", 0.01)
    calls = []

    async def step(name):
        calls.append(name)
        if name == stalled_step:
            try:
                await asyncio.Event().wait()
            finally:
                calls.append(f"cancelled {name}")

    async def drive(*_args, **_kwargs):
        await step("stop")

    async def disconnect():
        await step("disconnect")

    asyncio.run(
        session.safe_shutdown(
            SimpleNamespace(drive=drive),
            SimpleNamespace(is_connected=True, disconnect=disconnect),
            SimpleNamespace(quit=lambda: calls.append("pygame")),
            log=lambda _: None,
        )
    )
    assert calls == [
        "stop",
        *(["cancelled stop"] if stalled_step == "stop" else []),
        "disconnect",
        *(["cancelled disconnect"] if stalled_step == "disconnect" else []),
        "pygame",
    ]


def test_invalid_live_session_initialization_still_releases_hardware():
    calls = []

    async def disconnect():
        calls.append("disconnect")

    hub = SimpleNamespace(is_connected=True, disconnect=disconnect, attached_devices={}, hub_name="Hub")
    hardware = session.ConnectedHardware(hub, SimpleNamespace(quit=lambda: calls.append("pygame")), None)
    console = SimpleNamespace(log=lambda _: None, stop=lambda: None)
    asyncio.run(
        session.run_live_session(
            ModelProfile.load("tumbler"),
            GamepadProfile.load("dualsense"),
            {"roles": {"drive_left": "invalid"}},
            hardware,
            console,
        )
    )
    assert calls == ["disconnect", "pygame"]


@pytest.mark.parametrize("failed_cleanup", ["wheels", "rumble", "beep", "console"])
def test_optional_live_feedback_cleanup_cannot_skip_motor_shutdown(monkeypatch, failed_cleanup):
    calls = []
    messages = []

    def fail(name):
        calls.append(name)
        if name == failed_cleanup:
            raise RuntimeError(f"{name} cleanup failed")

    class Control:
        def __init__(self, *_args):
            pass

        async def start_play_vm(self):
            return 0x14, 0x100, ["success"]

        async def drive(self, *_args, **_kwargs):
            calls.append("stop")

    class Wheels:
        def __init__(self, *_args, **_kwargs):
            pass

        async def start(self):
            pass

        async def close(self):
            fail("wheels")

    async def disconnect():
        calls.append("disconnect")

    monkeypatch.setattr(session, "LowLevelControl", Control)
    monkeypatch.setattr(session, "WheelFeedback", Wheels)
    monkeypatch.setattr(session, "release_winrt_sta_for_pygame", lambda: None)
    monkeypatch.setattr(session.ControllerLed, "open", lambda _: session.ControllerLed())
    monkeypatch.setattr(
        session.ReverseBeep, "open", lambda *_args, **_kwargs: SimpleNamespace(stop=lambda: fail("beep"))
    )
    monkeypatch.setattr(session, "poll_controller_events", lambda *_args: (False, True))
    monkeypatch.setattr(session.BoostRumble, "stop", lambda *_args: fail("rumble"))
    joystick = SimpleNamespace(get_name=lambda: "Pad", get_numaxes=lambda: 6, get_numbuttons=lambda: 16)
    hub = SimpleNamespace(is_connected=True, disconnect=disconnect, attached_devices={}, hub_name="Hub")
    hardware = session.ConnectedHardware(hub, SimpleNamespace(quit=lambda: calls.append("pygame")), joystick)
    console = SimpleNamespace(log=messages.append, start=lambda _: None, stop=lambda: fail("console"))
    result = asyncio.run(
        session.run_live_session(
            ModelProfile.load("tumbler"),
            GamepadProfile.load("dualsense"),
            {"roles": {"drive_left": "0x32", "drive_right": "0x33"}},
            hardware,
            console,
        )
    )
    assert result == SESSION_EXIT
    assert calls[-3:] == ["stop", "disconnect", "pygame"]
    assert any(f"RuntimeError: {failed_cleanup} cleanup failed" in message for message in messages)


def test_scan_releases_hub_when_connect_partially_fails(monkeypatch):
    calls = []

    class Hub:
        def __init__(self, **_kwargs):
            pass

        async def connect(self):
            raise RuntimeError("notification setup failed")

        async def disconnect(self):
            calls.append("disconnect")

    monkeypatch.setattr(hub_probe, "TechnicMoveHub", Hub)
    with pytest.raises(RuntimeError, match="notification setup"):
        asyncio.run(hub_probe.scan_hub())
    assert calls == ["disconnect"]


def test_repeated_cancellation_waits_for_motor_cleanup_before_propagating():
    calls = []

    async def run():
        started, finish = asyncio.Event(), asyncio.Event()

        async def drive(*_args, **_kwargs):
            started.set()
            await finish.wait()
            calls.append("stopped")

        async def disconnect():
            calls.append("disconnect")

        shutdown = asyncio.create_task(
            session.safe_shutdown(
                SimpleNamespace(drive=drive),
                SimpleNamespace(is_connected=True, disconnect=disconnect),
                SimpleNamespace(quit=lambda: calls.append("pygame")),
                log=lambda _: None,
            )
        )
        await started.wait()
        shutdown.cancel()
        await asyncio.sleep(0)
        shutdown.cancel()
        finish.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(shutdown, timeout=1)

    asyncio.run(run())
    assert calls == ["stopped", "disconnect", "pygame"]


@pytest.mark.parametrize("ready_resource", ["controller", "hub"])
def test_cancelled_hardware_wait_releases_ready_resources_and_pending_tasks(monkeypatch, ready_resource):
    calls = []
    pad = GamepadProfile.load("dualsense")
    monkeypatch.setattr(session, "STARTUP_RETRY_DELAY_S", 0)

    async def run():
        observed = asyncio.Event()

        async def disconnect():
            calls.append("hub closed")

        hub = SimpleNamespace(is_connected=True, disconnect=disconnect, hub_name="Hub")

        async def connect(*_args):
            if ready_resource == "hub":
                return hub
            try:
                await asyncio.Event().wait()
            finally:
                calls.append("pending connection cancelled")

        pygame = SimpleNamespace(quit=lambda: calls.append("controller closed"))
        controller = session.GamepadConnection(pygame, SimpleNamespace(get_name=lambda: "Pad"), pad)
        monkeypatch.setattr(session, "connect_hub_for_drive", connect)
        monkeypatch.setattr(session, "poll_controller_events", lambda *_args: (False, False))
        monkeypatch.setattr(
            session,
            "try_init_gamepad_candidates",
            lambda _: (controller, "") if ready_resource == "controller" else (None, "missing"),
        )

        def show(_title, _message, steps, *_args):
            if dict(steps)["Technic Move Hub connected"] == (ready_resource == "hub"):
                observed.set()

        setup = SimpleNamespace(show=show)
        task = asyncio.create_task(session.wait_for_drive_hardware(setup, {"hub": {"name": "Hub"}}, [pad]))
        await asyncio.wait_for(observed.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=1)
        assert len(asyncio.all_tasks()) == 1

    asyncio.run(run())
    assert ("controller closed" if ready_resource == "controller" else "hub closed") in calls
    if ready_resource == "controller":
        assert "pending connection cancelled" in calls


def test_controller_lost_while_waiting_for_hub_is_replaced_before_handoff(monkeypatch):
    pad = GamepadProfile.load("dualsense")
    calls = []
    attached = [True]
    monkeypatch.setattr(session, "STARTUP_RETRY_DELAY_S", 0)

    def make_controller(name):
        joystick = SimpleNamespace(get_name=lambda: name, get_init=lambda: attached[0] if name == "old" else True)
        pygame = SimpleNamespace(
            event=SimpleNamespace(pump=lambda: None, get=list),
            joystick=SimpleNamespace(get_count=lambda: 1),
            quit=lambda: calls.append(f"close {name}"),
        )
        return session.GamepadConnection(pygame, joystick, pad)

    old, new = make_controller("old"), make_controller("new")
    candidates = [old, new]
    monkeypatch.setattr(session, "try_init_gamepad_candidates", lambda _: (candidates.pop(0), ""))

    async def run():
        continue_connect = asyncio.Event()

        async def connect(*_args):
            await continue_connect.wait()
            return SimpleNamespace(is_connected=True, hub_name="Hub")

        def show(_title, _message, _steps, detail=""):
            if "ready: old" in detail:
                attached[0] = False
                continue_connect.set()

        monkeypatch.setattr(session, "connect_hub_for_drive", connect)
        result = await asyncio.wait_for(
            session.wait_for_drive_hardware(SimpleNamespace(show=show), {"hub": {"name": "Hub"}}, [pad]), timeout=1
        )
        assert result is not None and result[1].joystick is new.joystick

    asyncio.run(run())
    assert calls == ["close old"]


def test_real_bleak_write_error_returns_to_hub_reconnect(monkeypatch):
    async def disconnect():
        pass

    class Control:
        def __init__(self, *_args):
            pass

        async def start_play_vm(self):
            raise BleakError("Bluetooth vanished during calibration")

        async def drive(self, *_args, **_kwargs):
            pass

    monkeypatch.setattr(session, "LowLevelControl", Control)
    console = SimpleNamespace(log=lambda _: None, stop=lambda: None)
    hub = SimpleNamespace(is_connected=True, disconnect=disconnect, attached_devices={}, hub_name="Hub")
    hardware = session.ConnectedHardware(hub, SimpleNamespace(quit=lambda: None), None)
    model = ModelProfile.load("tumbler")
    # A non-Tumbler display name avoids the optional encoder reader in this calibration test.
    model.name = "Test car"
    assert asyncio.run(session.run_live_session(model, GamepadProfile.load("dualsense"), {}, hardware, console)) == (
        session.RECONNECT_HUB
    )
