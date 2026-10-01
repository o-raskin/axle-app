"""Passive startup discovery: never connect to a hub or arm its motors."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

from .gamepads.profile_loader import AUTO_GAMEPAD_PROFILE, gamepad_profile_candidates
from .platforms.current import bluetooth_status
from .session import try_init_gamepad_candidates
from .transport import find_advertised_hub


def detect_controller() -> dict[str, str] | None:
    """Recognize an available controller and immediately release its SDL handles."""
    connection, _issue = try_init_gamepad_candidates(gamepad_profile_candidates(AUTO_GAMEPAD_PROFILE))
    if connection is None:
        return None
    try:
        return {"name": connection.joystick.get_name(), "profile": connection.profile.profile_id}
    finally:
        connection.pygame_mod.quit()


async def discover_hardware(out: Any, name: str, address: str | None) -> None:
    """Publish fresh device observations while scanning Bluetooth and SDL independently."""
    state: dict[str, Any] = {"bluetoothReady": False, "vehicle": None, "detail": ""}

    async def watch_vehicle() -> None:
        while True:
            try:
                status = await asyncio.to_thread(bluetooth_status)
                state["bluetoothReady"] = status.ready
                state["detail"] = status.detail
                if status.ready:
                    device = await find_advertised_hub(name, address)
                    state["vehicle"] = {"name": device.name or name, "address": device.address} if device else None
                else:
                    state["vehicle"] = None
            except Exception as exc:
                state.update(bluetoothReady=False, vehicle=None, detail=f"{type(exc).__name__}: {exc}")
            await asyncio.sleep(1.0)

    scanner = asyncio.create_task(watch_vehicle())
    try:
        out.emit("process/status", status="running", operation="discover")
        while True:
            try:
                controller = detect_controller()
            except Exception as exc:
                controller = None
                out.emit("log", level="warning", message=f"Controller discovery: {exc}")
            out.emit("telemetry", telemetry={"kind": "hardwareDiscovery", "controller": controller, **state})
            await asyncio.sleep(1.0)
    finally:
        scanner.cancel()
        with suppress(asyncio.CancelledError):
            await scanner
