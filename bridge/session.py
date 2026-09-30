"""High-level startup, reconnect, and live-control orchestration."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Callable

from .audio import ReverseBeep, reverse_beep_status
from .cars.model_profiles import DEFAULT_REQUIRED_PORT_ROLES, ModelProfile, ModelProfileChoice, available_model_choices
from .cars.tumbler.low_level_control import LowLevelControl
from .cars.tumbler.runtime import TumblerDriveRuntime
from .dashboard import CarTelemetry, LiveConsole, SetupConsole
from .feedback import (
    BoostRumble,
    ControllerLed,
    boost_led_color,
    boost_led_feedback_active,
    boost_rumble_strength,
    drive_rumble_strength,
    update_gamepad_led,
)
from .gamepads.input import (
    button_held,
    poll_controller_events,
    try_init_gamepad,
)
from .gamepads.profile_loader import GamepadProfile, gamepad_profile_candidates
from .hub_probe import save_probe_outputs, scan_hub
from .keyboard import TerminalExitPoller, TerminalKeyPoller
from .paths import HUB_SCHEME_PATH, PORT_MAP_PATH
from .platforms.current import bluetooth_status, release_winrt_sta_for_pygame
from .port_map import load_port_map, port_id
from .safety import SafetyLimits
from .settings import (
    CRASH_RUMBLE_STRENGTH,
    LOOP_INTERVAL_S,
    RECONNECT_DUALSENSE,
    RECONNECT_HUB,
    SESSION_EXIT,
    STARTUP_RETRY_DELAY_S,
)
from .transport import DEFAULT_HUB_NAME, TechnicMoveHub

DEFAULT_MODEL_PROFILE = "tumbler"
MODEL_SELECTION_POLL_INTERVAL_S = 0.05


@dataclass(frozen=True)
class ConnectedHardware:
    """Hardware handles required for one live session."""

    hub: TechnicMoveHub
    pygame_mod: Any
    joystick: Any


@dataclass(frozen=True)
class GamepadConnection:
    """A matched gamepad profile and its open pygame handles."""

    pygame_mod: Any
    joystick: Any
    profile: GamepadProfile


@dataclass(frozen=True)
class HubTarget:
    """Optional command-line hub target overrides."""

    name: str | None = None
    address: str | None = None


class HubPortMismatch(RuntimeError):
    """Raised when a reachable hub does not match the saved car port map."""


def startup_steps(dualsense: bool, hub: bool, ready: bool, bluetooth: bool = True) -> list[tuple[str, bool]]:
    """Checklist shared by startup panels."""
    return [
        ("Bluetooth enabled", bluetooth),
        ("Gamepad controller detected", dualsense),
        ("Technic Move Hub connected", hub),
        ("Live drive session ready", ready),
    ]


def model_selection_steps(gamepad_ready: bool) -> list[tuple[str, bool]]:
    """Checklist for the model-selection screen."""
    return [
        ("Model profile selected", False),
        ("Keyboard arrows ready", True),
        ("Gamepad arrows ready", gamepad_ready),
        ("Live drive session ready", False),
    ]


def model_selection_detail(
    choices: list[ModelProfileChoice],
    selected_index: int,
    gamepad_detail: str,
) -> str:
    """Render the selectable model list for the setup panel detail area."""
    lines = ["Keyboard: Up/Down + Enter | Gamepad: D-pad Up/Down + A/Cross"]
    for index, choice in enumerate(choices):
        marker = ">" if index == selected_index else " "
        lines.append(f"{marker} {choice.profile_id:<16} {choice.name}")
    lines.append(f"Gamepad: {gamepad_detail}")
    return "\n".join(lines)


def apply_model_selection_action(selected_index: int, choice_count: int, action: str | None) -> tuple[int, bool, bool]:
    """Apply one model-selection action and return index, confirmed, cancelled."""
    if choice_count <= 0:
        raise RuntimeError("No model profiles are available")
    if action == "up":
        return (selected_index - 1) % choice_count, False, False
    if action == "down":
        return (selected_index + 1) % choice_count, False, False
    if action == "confirm":
        return selected_index, True, False
    if action == "cancel":
        return selected_index, False, True
    return selected_index, False, False


def try_init_gamepad_candidates(profiles: list[GamepadProfile]) -> tuple[GamepadConnection | None, str]:
    """Try all allowed gamepad profiles once, returning either a match or combined diagnostics."""
    issues = []
    for profile in profiles:
        pygame_mod, joystick, issue = try_init_gamepad(profile)
        if pygame_mod is not None and joystick is not None:
            return GamepadConnection(pygame_mod, joystick, profile), ""
        issues.append(f"{profile.name}: {issue}")
    return None, "; ".join(issues)


async def select_model_for_startup(
    setup: SetupConsole,
    profiles: list[GamepadProfile],
    preferred_model: str = DEFAULT_MODEL_PROFILE,
) -> str:
    """Let the user choose a model profile with keyboard or gamepad navigation."""
    choices = available_model_choices()
    selected_index = next((index for index, choice in enumerate(choices) if choice.profile_id == preferred_model), 0)
    gamepad: GamepadConnection | None = None
    gamepad_detail = "connect a gamepad for D-pad selection"
    next_gamepad_check = 0.0
    previous_up = False
    previous_down = False
    previous_confirm = False
    loop = asyncio.get_running_loop()

    try:
        with TerminalKeyPoller() as keys:
            while True:
                now = loop.time()
                if gamepad is None and now >= next_gamepad_check:
                    gamepad, issue = try_init_gamepad_candidates(profiles)
                    if gamepad is None:
                        gamepad_detail = f"waiting ({issue})" if issue else "waiting"
                    else:
                        gamepad_detail = f"ready: {gamepad.joystick.get_name()} ({gamepad.profile.name})"
                    next_gamepad_check = now + STARTUP_RETRY_DELAY_S

                action = keys.poll_action()
                if action is None and gamepad is not None:
                    action, previous_up, previous_down, previous_confirm = _gamepad_model_selection_action(
                        gamepad,
                        previous_up,
                        previous_down,
                        previous_confirm,
                    )
                    if action == "disconnected":
                        with suppress(Exception):
                            gamepad.pygame_mod.quit()
                        gamepad = None
                        gamepad_detail = "disconnected; keyboard still works"
                        previous_up = False
                        previous_down = False
                        previous_confirm = False
                        action = None

                selected_index, confirmed, cancelled = apply_model_selection_action(
                    selected_index,
                    len(choices),
                    action,
                )
                setup.show(
                    "Choose LEGO Technic model",
                    "Select the car profile to drive.",
                    model_selection_steps(gamepad is not None),
                    model_selection_detail(choices, selected_index, gamepad_detail),
                )
                if confirmed:
                    return choices[selected_index].profile_id
                if cancelled:
                    raise RuntimeError("Model selection cancelled")
                await asyncio.sleep(MODEL_SELECTION_POLL_INTERVAL_S)
    finally:
        if gamepad is not None:
            with suppress(Exception):
                gamepad.pygame_mod.quit()


def _gamepad_model_selection_action(
    gamepad: GamepadConnection,
    previous_up: bool,
    previous_down: bool,
    previous_confirm: bool,
) -> tuple[str | None, bool, bool, bool]:
    """Return one edge-triggered gamepad menu action."""
    disconnected, _exit_requested = poll_controller_events(gamepad.pygame_mod, gamepad.joystick)
    if disconnected:
        return "disconnected", previous_up, previous_down, previous_confirm

    up = button_held(gamepad.joystick, gamepad.profile.button("speed_up"))
    down = button_held(gamepad.joystick, gamepad.profile.button("speed_down"))
    confirm_button = gamepad.profile.optional_button("confirm")
    confirm = confirm_button is not None and button_held(gamepad.joystick, confirm_button)

    action = None
    if up and not previous_up:
        action = "up"
    elif down and not previous_down:
        action = "down"
    elif confirm and not previous_confirm:
        action = "confirm"
    return action, up, down, confirm


async def wait_for_gamepad(
    setup: SetupConsole,
    profiles: list[GamepadProfile],
    reconnect: bool = False,
) -> tuple[Any, Any, GamepadProfile]:
    """Wait until the requested gamepad is available, keeping the user informed."""
    controller_name = " / ".join(profile.name for profile in profiles)
    title = f"{controller_name} disconnected" if reconnect else f"Connect {controller_name}"
    message = (
        "Reconnect the controller with USB or Bluetooth. Live control is paused."
        if reconnect
        else f"Connect {controller_name} with USB or Bluetooth before the bridge can arm."
    )
    detail = "macOS, SteamOS, and Windows may expose the same controller under different names."
    while True:
        gamepad, issue = try_init_gamepad_candidates(profiles)
        if gamepad is not None:
            setup.show(
                "Controller ready",
                f"Controller detected: {gamepad.joystick.get_name()} ({gamepad.profile.name})",
                startup_steps(dualsense=True, hub=False, ready=False),
            )
            return gamepad.pygame_mod, gamepad.joystick, gamepad.profile

        issue_detail = f"{detail} Last check: {issue}" if issue else detail
        setup.show(
            title,
            message,
            startup_steps(dualsense=False, hub=False, ready=False),
            issue_detail,
        )
        await asyncio.sleep(STARTUP_RETRY_DELAY_S)


async def wait_for_dualsense(setup: SetupConsole, reconnect: bool = False) -> tuple[Any, Any]:
    """Compatibility wrapper for callers that explicitly wait for a DualSense."""
    pygame_mod, joystick, _profile = await wait_for_gamepad(setup, [GamepadProfile.load("dualsense")], reconnect)
    return pygame_mod, joystick


async def wait_for_bluetooth(setup: SetupConsole) -> None:
    """Block startup until Bluetooth appears ready for BLE scanning."""
    while True:
        status = bluetooth_status()
        if status.ready:
            setup.show(
                "Bluetooth ready",
                "Bluetooth is available for controller and hub discovery.",
                startup_steps(dualsense=False, hub=False, ready=False, bluetooth=True),
                status.detail,
            )
            return
        setup.show(
            "Enable Bluetooth",
            "Turn Bluetooth on before the bridge scans for the gamepad or Technic Move Hub.",
            startup_steps(dualsense=False, hub=False, ready=False, bluetooth=False),
            status.detail,
        )
        await asyncio.sleep(STARTUP_RETRY_DELAY_S)


def load_port_map_for_drive(setup: SetupConsole) -> dict[str, Any] | None:
    """Load the generated port map, explaining the required action when it is missing or invalid."""
    try:
        port_map = load_port_map(PORT_MAP_PATH)
    except FileNotFoundError:
        setup.show(
            "Hub scan required",
            "The bridge needs a generated port map before live driving.",
            startup_steps(dualsense=False, hub=False, ready=False),
            "Start a hub scan, press the hub button when prompted, then live driving can continue.",
        )
        return None
    except ValueError as exc:
        setup.show(
            "Port map is unreadable",
            f"{PORT_MAP_PATH} could not be parsed.",
            startup_steps(dualsense=False, hub=False, ready=False),
            f"Run a hub scan again. Parser detail: {exc}",
        )
        return None

    if not isinstance(port_map.get("hub"), dict) or not isinstance(port_map.get("roles"), dict):
        setup.show(
            "Port map is incomplete",
            f"{PORT_MAP_PATH} does not contain the expected hub and role information.",
            startup_steps(dualsense=False, hub=False, ready=False),
            "Run a hub scan again so the bridge can learn this car.",
        )
        return None
    return port_map


async def scan_port_map_for_drive(
    setup: SetupConsole,
    hub_name: str = DEFAULT_HUB_NAME,
    hub_address: str | None = None,
) -> dict[str, Any]:
    """Run the hub scan from the guided startup flow until a port map is saved."""
    target = hub_address or hub_name
    detail = f"Looking for hub: {target}"
    while True:
        setup.show(
            "Scan the car",
            "Press the Technic Move Hub power/connect button now so the bridge can learn this car.",
            startup_steps(dualsense=False, hub=False, ready=False),
            detail,
        )
        try:
            port_map, report = await scan_hub(hub_name, hub_address)
            save_probe_outputs(port_map, report)
            setup.show(
                "Hub scan complete",
                "The car port map has been saved. Live startup can continue.",
                startup_steps(dualsense=False, hub=True, ready=False),
                f"Saved port map to {PORT_MAP_PATH}; saved report to {HUB_SCHEME_PATH}",
            )
            return port_map
        except Exception as exc:
            detail = (
                f"Still looking for {target}. Press the hub button if the LED is not blinking. "
                f"Last check: {type(exc).__name__}: {exc}"
            )
            await asyncio.sleep(STARTUP_RETRY_DELAY_S)


async def prepare_port_map_for_drive(
    setup: SetupConsole,
    hub_name: str = DEFAULT_HUB_NAME,
    hub_address: str | None = None,
) -> dict[str, Any]:
    """Load the saved port map, scanning the hub automatically when it is missing or invalid."""
    port_map = load_port_map_for_drive(setup)
    if port_map is not None:
        return port_map
    return await scan_port_map_for_drive(setup, hub_name, hub_address)


def required_hub_port_issue(
    hub: TechnicMoveHub,
    port_map: dict[str, Any],
    required_port_roles: Iterable[str] | None = None,
) -> str | None:
    """Return a user-facing issue when the connected hub does not match the saved port map."""
    for role in tuple(required_port_roles or DEFAULT_REQUIRED_PORT_ROLES):
        try:
            port = port_id(port_map, role)
        except RuntimeError as exc:
            return f"{exc}. Run a hub scan again so the bridge can learn this car."
        if port not in hub.attached_devices:
            return (
                f"The saved {role} port {port:#04x} was not reported by the hub. "
                "Check the model, then run a hub scan again if the wiring changed."
            )
    return None


async def connect_hub_for_drive(
    port_map: dict[str, Any],
    hub_name_override: str | None = None,
    hub_address_override: str | None = None,
    required_port_roles: Iterable[str] | None = None,
) -> TechnicMoveHub:
    """Connect and validate one hub attempt against the saved drive port map."""
    hub_name = hub_name_override or port_map["hub"]["name"]
    hub_address = hub_address_override or port_map["hub"].get("address")
    hub = TechnicMoveHub(hub_name=hub_name, hub_address=hub_address)
    try:
        await hub.connect()
        await hub.wait_for_topology()
        if required_port_roles is None:
            issue = required_hub_port_issue(hub, port_map)
        else:
            issue = required_hub_port_issue(hub, port_map, required_port_roles)
        if issue is not None:
            raise HubPortMismatch(issue)
        return hub
    except BaseException:
        with suppress(Exception):
            await hub.disconnect()
        raise


async def wait_for_hub(
    setup: SetupConsole,
    port_map: dict[str, Any],
    reconnect: bool = False,
    hub_name_override: str | None = None,
    hub_address_override: str | None = None,
    *,
    required_port_roles: Iterable[str] | None = None,
) -> TechnicMoveHub | None:
    """Wait until the Technic hub is online and matches the saved port map."""
    hub_name = hub_name_override or port_map["hub"]["name"]
    hub_address = hub_address_override or port_map["hub"].get("address")
    target = hub_address or hub_name
    title = "Car disconnected" if reconnect else "Connect the car"
    message = (
        "Press the Technic Move Hub button again. Live control is paused until the car reconnects."
        if reconnect
        else "Press the Technic Move Hub power/connect button now. The hub LED should blink while it is discoverable."
    )
    detail = f"Looking for hub: {target}"

    while True:
        setup.show(
            title,
            message,
            startup_steps(dualsense=True, hub=False, ready=False),
            detail,
        )
        try:
            hub = await connect_hub_for_drive(port_map, hub_name, hub_address, required_port_roles)
            setup.show(
                "Car ready",
                f"Hub connected: {hub.hub_name}. Required ports are online.",
                startup_steps(dualsense=True, hub=True, ready=True),
            )
            return hub
        except HubPortMismatch as exc:
            setup.show(
                "Hub connected, but this is not ready to drive",
                "The bridge connected to a hub, but the expected model ports are missing.",
                startup_steps(dualsense=True, hub=True, ready=False),
                str(exc),
            )
            return None
        except Exception as exc:
            detail = (
                f"Still looking for {target}. Press the hub button if the LED is not blinking. "
                f"Last check: {type(exc).__name__}: {exc}"
            )
            await asyncio.sleep(STARTUP_RETRY_DELAY_S)


async def wait_for_drive_hardware(
    setup: SetupConsole,
    port_map: dict[str, Any],
    profiles: list[GamepadProfile],
    reconnect_reason: str | None = None,
    hub_target: HubTarget | None = None,
    *,
    required_port_roles: Iterable[str] | None = None,
) -> tuple[GamepadProfile, ConnectedHardware] | None:
    """Connect the gamepad and Technic hub in parallel before arming live control."""
    controller_name = " / ".join(profile.name for profile in profiles)
    hub_target = hub_target or HubTarget()
    hub_name = hub_target.name or port_map["hub"]["name"]
    hub_address = hub_target.address or port_map["hub"].get("address")
    target = hub_address or hub_name
    reconnecting_gamepad = reconnect_reason == RECONNECT_DUALSENSE
    reconnecting_hub = reconnect_reason == RECONNECT_HUB
    title = "Reconnect controller and car" if reconnecting_gamepad or reconnecting_hub else "Connect controller and car"
    message = (
        f"Reconnect {controller_name} and press the Technic Move Hub button; both are scanned in parallel."
        if reconnecting_gamepad or reconnecting_hub
        else f"Connect {controller_name} and press the Technic Move Hub button; both are scanned in parallel."
    )
    gamepad_detail = "waiting"
    hub_detail = f"Looking for hub: {target}"
    gamepad: GamepadConnection | None = None
    hub: TechnicMoveHub | None = None
    hub_task: asyncio.Task[TechnicMoveHub] | None = None
    handoff_complete = False

    try:
        while True:
            if hub is None and hub_task is None:
                hub_task = asyncio.create_task(
                    connect_hub_for_drive(port_map, hub_name, hub_address, required_port_roles)
                )
                await asyncio.sleep(0)

            if gamepad is None:
                gamepad, issue = try_init_gamepad_candidates(profiles)
                if gamepad is not None:
                    gamepad_detail = f"ready: {gamepad.joystick.get_name()} ({gamepad.profile.name})"
                elif issue:
                    gamepad_detail = f"Last check: {issue}"

            if hub_task is not None and hub_task.done():
                try:
                    hub = hub_task.result()
                    hub_detail = f"ready: {hub.hub_name}"
                except HubPortMismatch as exc:
                    setup.show(
                        "Hub connected, but this is not ready to drive",
                        "The bridge connected to a hub, but the expected model ports are missing.",
                        startup_steps(dualsense=gamepad is not None, hub=True, ready=False),
                        str(exc),
                    )
                    return None
                except Exception as exc:
                    hub_detail = (
                        f"Still looking for {target}. Press the hub button if the LED is not blinking. "
                        f"Last check: {type(exc).__name__}: {exc}"
                    )
                    hub_task = None
                else:
                    hub_task = None

            setup.show(
                title,
                message,
                startup_steps(dualsense=gamepad is not None, hub=hub is not None, ready=False),
                f"Gamepad: {gamepad_detail} | Hub: {hub_detail}",
            )

            if gamepad is not None and hub is not None:
                setup.show(
                    "Hardware ready",
                    (
                        f"Controller detected: {gamepad.joystick.get_name()} ({gamepad.profile.name}); "
                        f"hub connected: {hub.hub_name}."
                    ),
                    startup_steps(dualsense=True, hub=True, ready=True),
                )
                handoff_complete = True
                return gamepad.profile, ConnectedHardware(hub, gamepad.pygame_mod, gamepad.joystick)

            await asyncio.sleep(STARTUP_RETRY_DELAY_S)
    finally:
        if hub_task is not None:
            if not hub_task.done():
                hub_task.cancel()
            with suppress(Exception, asyncio.CancelledError):
                task_hub = await hub_task
                if not handoff_complete and task_hub is not hub:
                    with suppress(Exception):
                        await task_hub.disconnect()
        if not handoff_complete:
            if hub is not None:
                with suppress(Exception):
                    await hub.disconnect()
            if gamepad is not None:
                with suppress(Exception):
                    gamepad.pygame_mod.quit()


async def safe_shutdown(
    control: LowLevelControl | None,
    hub: TechnicMoveHub,
    pygame_mod: Any,
    gamepad_led: ControllerLed | None = None,
    log: Callable[[str], None] | None = None,
) -> None:
    """Stop the car, drop the link and close pygame, from whatever state we are in."""
    log_message = log or print
    log_message("Stopping motors...")
    try:
        if control is not None and hub.is_connected:
            await control.drive(0, 0, lights=False)
    except Exception as exc:
        log_message(f"Stop command failed: {exc}")
    try:
        await hub.disconnect()
    except Exception as exc:
        log_message(f"Disconnect failed: {exc}")
    try:
        if gamepad_led is not None:
            gamepad_led.close()
        if pygame_mod is not None:
            pygame_mod.quit()
    except Exception:
        pass
    log_message("Safe exit.")


async def run_live_session(
    model: ModelProfile,
    pad: GamepadProfile,
    port_map: dict[str, Any],
    hardware: ConnectedHardware,
    live_console: Any | None = None,
) -> str:
    """Run one armed driving session, returning what should be reconnected next."""
    hub = hardware.hub
    pygame_mod = hardware.pygame_mod
    joystick = hardware.joystick
    limits = SafetyLimits(max_drive_power=model.max_drive, max_steering_power=model.max_steering)
    control = None
    gamepad_led = None
    reverse_beep = None
    console = live_console or LiveConsole()
    reconnect_reason = SESSION_EXIT
    boost_rumble = BoostRumble()

    try:
        console.log(f"Hub ready: {len(hub.attached_devices)} ports attached")

        control = LowLevelControl(hub, port_map, model, limits)
        console.log("Starting PLAYVM (link rears, subscribe, calibrate)...")
        virtual_port, status, flags = await control.start_play_vm()
        console.log(f"  calibration status {status:#07x}: {', '.join(flags)}")
        console.log(f"  rears mixed on virtual port {virtual_port:#04x}")

        release_winrt_sta_for_pygame()

        gamepad_led = ControllerLed.open(pygame_mod) if pad.supports_led else ControllerLed()
        reverse_beep = ReverseBeep.open(pygame_mod, log=console.log)
        console.log(
            f"Gamepad: {joystick.get_name()} (axes={joystick.get_numaxes()}, buttons={joystick.get_numbuttons()})"
        )
        console.log(f"Drive +/-{model.max_drive}, steering +/-{model.max_steering}")
        console.log(pad.controls)
        console.log("Ctrl+C, Esc, or Start/Menu: safe stop and exit")

        exit_button = pad.optional_button("exit")
        runtime = TumblerDriveRuntime(model, pad)
        last_cmd = None
        loop = asyncio.get_running_loop()
        led_color = update_gamepad_led(gamepad_led, runtime.speed_mode, boost_feedback=False)
        console.start(
            CarTelemetry(
                model_name=model.name,
                hub_name=hub.hub_name,
                max_drive=model.max_drive,
                max_steering=model.max_steering,
                speed_mode=runtime.speed_mode,
                led_color=led_color,
            )
        )
        console.log("Ready.")

        with TerminalExitPoller() as keyboard_exit:
            while True:
                disconnected, controller_exit_requested = poll_controller_events(pygame_mod, joystick, exit_button)
                if keyboard_exit.exit_requested() or controller_exit_requested:
                    reconnect_reason = SESSION_EXIT
                    console.log("Exit requested. Motors are stopping.")
                    break
                if disconnected:
                    reconnect_reason = RECONNECT_DUALSENSE
                    console.log("Controller disconnected. Motors are stopping; reconnect the controller to continue.")
                    break
                if not hub.is_connected:
                    reconnect_reason = RECONNECT_HUB
                    console.log("Car hub disconnected. Motors are stopping; press the hub button to reconnect.")
                    break

                now = loop.time()
                frame = await runtime.sample(joystick, control, now, console.log)
                reverse_beep.update(frame.reverse_active, now)

                boost_led_feedback = boost_led_feedback_active(frame.boost_feedback_at, frame.boost_until, now)
                if frame.crash:
                    rumble_strength = CRASH_RUMBLE_STRENGTH
                    boost_rumble.update(joystick, rumble_strength)
                else:
                    rumble_strength = boost_rumble_strength(frame.boost_feedback_at, frame.boost_until, now)
                    if rumble_strength > 0.0 or now >= frame.drive_rumble_paused_until:
                        if rumble_strength == 0.0:
                            rumble_strength = drive_rumble_strength(frame.trigger_pressure, frame.speed_mode)
                        boost_rumble.update(joystick, rumble_strength)
                led_color = update_gamepad_led(
                    gamepad_led,
                    frame.speed_mode,
                    boost_led_feedback,
                    boost_color=boost_led_color(frame.boost_feedback_at, frame.boost_until, now),
                    boost_unavailable_feedback=runtime.boost_unavailable_feedback,
                    crash_feedback=frame.crash,
                    reverse_started_at=frame.reverse_led_started_at,
                    now=now,
                )

                console.update(
                    CarTelemetry(
                        model_name=model.name,
                        hub_name=hub.hub_name,
                        max_drive=model.max_drive,
                        max_steering=model.max_steering,
                        throttle=frame.throttle,
                        steering=frame.steering,
                        speed_mode=frame.speed_mode,
                        trigger_pressure=frame.trigger_pressure,
                        forward_pressure=frame.forward_pressure,
                        reverse_pressure=frame.reverse_pressure,
                        brake=frame.brake,
                        boost=frame.boost,
                        boost_ready_in=frame.boost_ready_in,
                        crash=frame.crash,
                        crash_lockout_left=frame.crash_lockout_left,
                        front_lights_on=frame.front_lights_on,
                        manual_front_lights_on=frame.manual_front_lights_on,
                        rocket_lights_on=frame.rocket_lights_on,
                        flicker=frame.flicker,
                        led_color=led_color,
                        rumble_strength=rumble_strength,
                        reverse_beep=reverse_beep_status(reverse_beep, frame.reverse_active, now),
                        speed_up_pressed=frame.speed_up_pressed,
                        speed_down_pressed=frame.speed_down_pressed,
                        boost_pressed=frame.boost_pressed,
                        front_lights_pressed=frame.front_lights_pressed,
                        attack_pressed=frame.attack_pressed,
                    )
                )

                cmd = frame.command
                if cmd != last_cmd:
                    console.log(
                        f"cmd speed={frame.throttle} steer={frame.steering} brake={frame.brake} "
                        f"boost={frame.boost} mode={frame.speed_mode} "
                        f"front_lights={frame.front_lights_on} "
                        f"rocket_lights={frame.rocket_lights_on} flicker={frame.flicker}"
                    )
                    await control.drive(
                        frame.throttle,
                        frame.steering,
                        brake=frame.brake,
                        boost=frame.boost,
                        lights=frame.front_lights_on,
                        rocket_lights=frame.rocket_lights_on,
                        flicker=frame.flicker,
                    )
                    last_cmd = cmd
                await asyncio.sleep(LOOP_INTERVAL_S)
    except (KeyboardInterrupt, asyncio.CancelledError):
        reconnect_reason = SESSION_EXIT
        console.log("Interrupt - shutting down...")
    except (OSError, RuntimeError) as exc:
        reconnect_reason = RECONNECT_HUB
        console.log(f"Link lost: {type(exc).__name__}: {exc}")
    except Exception as exc:
        reconnect_reason = RECONNECT_DUALSENSE
        console.log(f"Controller input stopped: {type(exc).__name__}: {exc}")
    finally:
        if joystick is not None:
            boost_rumble.stop(joystick)
        if reverse_beep is not None:
            reverse_beep.stop()
        console.stop()
        await safe_shutdown(control, hub, pygame_mod, gamepad_led, log=console.log)
    return reconnect_reason


async def run_control(
    model_name: str | None,
    gamepad_name: str,
    hub_name: str = DEFAULT_HUB_NAME,
    hub_address: str | None = None,
) -> None:
    """Run the guided live-control flow for one model and gamepad profile."""
    setup = SetupConsole()
    try:
        pad_candidates = gamepad_profile_candidates(gamepad_name)
        selected_model_name = model_name or await select_model_for_startup(setup, pad_candidates)
        model = ModelProfile.load(selected_model_name)
    except RuntimeError as exc:
        setup.show(
            "Profile configuration problem",
            "The selected model or gamepad profile could not be loaded.",
            startup_steps(dualsense=False, hub=False, ready=False),
            str(exc),
        )
        return

    await wait_for_bluetooth(setup)
    port_map = await prepare_port_map_for_drive(setup, hub_name, hub_address)

    reconnect_reason: str | None = None
    while True:
        hardware_result = await wait_for_drive_hardware(
            setup,
            port_map,
            pad_candidates,
            reconnect_reason=reconnect_reason,
            hub_target=HubTarget(hub_name, hub_address),
            required_port_roles=model.required_port_roles,
        )
        if hardware_result is None:
            return
        pad, hardware = hardware_result

        setup.show(
            "Starting live control",
            f"All checks passed for {model.name} with {pad.name}. Keep the wheels clear.",
            startup_steps(dualsense=True, hub=True, ready=True),
        )
        setup.stop()
        reconnect_reason = await run_live_session(model, pad, port_map, hardware)
        if reconnect_reason == SESSION_EXIT:
            return
