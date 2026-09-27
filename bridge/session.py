"""High-level startup, reconnect, and live-control orchestration."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from .audio import ReverseBeep, reverse_beep_status
from .controller import (
    axis_to_percent,
    button_held,
    gamepad_was_disconnected,
    read_drive_state,
    read_trigger_pressures,
    try_init_gamepad,
)
from .dashboard import CarTelemetry, LiveConsole, SetupConsole
from .feedback import (
    BoostRumble,
    BoostUnavailableFeedback,
    ControllerLed,
    CrashLockout,
    boost_led_color,
    boost_led_feedback_active,
    boost_rumble_strength,
    change_speed_mode_with_feedback,
    drive_rumble_strength,
    update_gamepad_led,
)
from .hub_probe import save_probe_outputs, scan_hub
from .lighting import AttackSignal, AutomaticLights
from .low_level_control import LowLevelControl
from .paths import HUB_SCHEME_PATH, PORT_MAP_PATH
from .platform import release_winrt_sta_for_pygame
from .port_map import load_port_map, port_id
from .profiles import GamepadProfile, ModelProfile
from .safety import SafetyLimits, require_user_acknowledgement
from .settings import (
    BOOST_FEEDBACK_DELAY_S,
    CRASH_LOCKOUT_S,
    CRASH_RUMBLE_STRENGTH,
    DEFAULT_SPEED_MODE,
    LOOP_INTERVAL_S,
    RECONNECT_DUALSENSE,
    RECONNECT_HUB,
    SESSION_EXIT,
    SPEED_MODE_RATIOS,
    SPEED_RUMBLE_DURATION_MS,
    STARTUP_RETRY_DELAY_S,
)
from .transport import DEFAULT_HUB_NAME, TechnicMoveHub


@dataclass(frozen=True)
class ConnectedHardware:
    """Hardware handles required for one live session."""

    hub: TechnicMoveHub
    pygame_mod: Any
    joystick: Any


def startup_steps(dualsense: bool, hub: bool, ready: bool) -> list[tuple[str, bool]]:
    """Checklist shared by startup panels."""
    return [
        ("Gamepad controller detected", dualsense),
        ("Technic Move Hub connected", hub),
        ("Live drive session ready", ready),
    ]


async def wait_for_gamepad(
    setup: SetupConsole,
    profile: GamepadProfile | None = None,
    reconnect: bool = False,
) -> tuple[Any, Any]:
    """Wait until the requested gamepad is available, keeping the user informed."""
    controller_name = profile.name if profile is not None else "Sony DualSense"
    title = f"{controller_name} disconnected" if reconnect else f"Connect {controller_name}"
    message = (
        "Reconnect the controller with USB or Bluetooth. Live control is paused."
        if reconnect
        else f"Connect {controller_name} with USB or Bluetooth before the bridge can arm."
    )
    detail = "macOS and Windows may expose the same controller under different Bluetooth names."
    while True:
        pygame_mod, joystick, issue = try_init_gamepad(profile)
        if pygame_mod is not None and joystick is not None:
            setup.show(
                "Controller ready",
                f"Controller detected: {joystick.get_name()}",
                startup_steps(dualsense=True, hub=False, ready=False),
            )
            return pygame_mod, joystick

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
    return await wait_for_gamepad(setup, GamepadProfile.load("dualsense"), reconnect)


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


def required_hub_port_issue(hub: TechnicMoveHub, port_map: dict[str, Any]) -> str | None:
    """Return a user-facing issue when the connected hub does not match the saved port map."""
    for role in ("steering", "drive_left", "drive_right", "play_vm"):
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


async def wait_for_hub(
    setup: SetupConsole,
    port_map: dict[str, Any],
    reconnect: bool = False,
    hub_name_override: str | None = None,
    hub_address_override: str | None = None,
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
        hub = TechnicMoveHub(hub_name=hub_name, hub_address=hub_address)
        try:
            await hub.connect()
            await hub.wait_for_topology()
            issue = required_hub_port_issue(hub, port_map)
            if issue is not None:
                await hub.disconnect()
                setup.show(
                    "Hub connected, but this is not ready to drive",
                    "The bridge connected to a hub, but the expected model ports are missing.",
                    startup_steps(dualsense=True, hub=True, ready=False),
                    issue,
                )
                return None

            setup.show(
                "Car ready",
                f"Hub connected: {hub.hub_name}. Required ports are online.",
                startup_steps(dualsense=True, hub=True, ready=True),
            )
            return hub
        except Exception as exc:
            try:
                await hub.disconnect()
            except Exception:
                pass
            detail = (
                f"Still looking for {target}. Press the hub button if the LED is not blinking. "
                f"Last check: {type(exc).__name__}: {exc}"
            )
            await asyncio.sleep(STARTUP_RETRY_DELAY_S)


async def safe_shutdown(
    control: LowLevelControl | None,
    hub: TechnicMoveHub,
    pygame_mod: Any,
    gamepad_led: ControllerLed | None = None,
) -> None:
    """Stop the car, drop the link and close pygame, from whatever state we are in."""
    print("Stopping motors...")
    try:
        if control is not None and hub.is_connected:
            await control.drive(0, 0, lights=False)
    except Exception as exc:
        print(f"Stop command failed: {exc}")
    try:
        await hub.disconnect()
    except Exception as exc:
        print(f"Disconnect failed: {exc}")
    try:
        if gamepad_led is not None:
            gamepad_led.close()
        if pygame_mod is not None:
            pygame_mod.quit()
    except Exception:
        pass
    print("Safe exit.")


async def run_live_session(
    model: ModelProfile,
    pad: GamepadProfile,
    port_map: dict[str, Any],
    hardware: ConnectedHardware,
) -> str:
    """Run one armed driving session, returning what should be reconnected next."""
    hub = hardware.hub
    pygame_mod = hardware.pygame_mod
    joystick = hardware.joystick
    limits = SafetyLimits(max_drive_power=model.max_drive, max_steering_power=model.max_steering)
    control = None
    gamepad_led = None
    reverse_beep = None
    console = LiveConsole()
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

        gamepad_led = ControllerLed.open(pygame_mod)
        reverse_beep = ReverseBeep.open(pygame_mod, log=console.log)
        console.log(
            f"Gamepad: {joystick.get_name()} (axes={joystick.get_numaxes()}, buttons={joystick.get_numbuttons()})"
        )
        console.log(f"Drive +/-{model.max_drive}, steering +/-{model.max_steering}")
        console.log(pad.controls)
        console.log("Ctrl+C: safe stop and exit")

        brake_button = pad.button("brake")
        boost_button = pad.button("boost")
        speed_up_button = pad.button("speed_up")
        speed_down_button = pad.button("speed_down")
        front_lights_button = pad.button("front_lights")
        attack_button = pad.button("attack")
        steer_axis = pad.axis("steer")
        boost_hold = model.boost["hold_s"]
        boost_cooldown = model.boost["cooldown_s"]

        lights = AutomaticLights()
        attack_signal = AttackSignal()
        boost_unavailable_feedback = BoostUnavailableFeedback()
        crash_lockout = CrashLockout()
        speed_mode = DEFAULT_SPEED_MODE
        drive_rumble_paused_until = 0.0
        front_lights_prev = False
        attack_prev = False
        speed_up_prev = False
        speed_down_prev = False
        boost_prev = False
        boost_until = 0.0
        boost_feedback_at = 0.0
        boost_ready_at = 0.0
        reverse_led_started_at: float | None = None
        last_cmd = None
        loop = asyncio.get_running_loop()
        led_color = update_gamepad_led(gamepad_led, speed_mode, boost_feedback=False)
        console.start(
            CarTelemetry(
                model_name=model.name,
                hub_name=hub.hub_name,
                max_drive=model.max_drive,
                max_steering=model.max_steering,
                speed_mode=speed_mode,
                led_color=led_color,
            )
        )
        console.log("Ready.")

        while True:
            if gamepad_was_disconnected(pygame_mod, joystick):
                reconnect_reason = RECONNECT_DUALSENSE
                console.log("Controller disconnected. Motors are stopping; reconnect the controller to continue.")
                break
            if not hub.is_connected:
                reconnect_reason = RECONNECT_HUB
                console.log("Car hub disconnected. Motors are stopping; press the hub button to reconnect.")
                break

            now = loop.time()
            crash_active = crash_lockout.active(now)

            brake_pressed = button_held(joystick, brake_button)
            speed_up_pressed = button_held(joystick, speed_up_button)
            speed_down_pressed = button_held(joystick, speed_down_button)
            boost_pressed = button_held(joystick, boost_button)
            front_lights_pressed = button_held(joystick, front_lights_button)
            attack_pressed = button_held(joystick, attack_button)
            brake = brake_pressed and not crash_active

            if not crash_active and speed_up_pressed and not speed_up_prev:
                previous_speed_mode = speed_mode
                speed_mode = await change_speed_mode_with_feedback(joystick, speed_mode, 1)
                if speed_mode != previous_speed_mode:
                    drive_rumble_paused_until = loop.time() + (SPEED_RUMBLE_DURATION_MS / 1000)
                ratio = int(SPEED_MODE_RATIOS[speed_mode] * 100)
                console.log(f"speed mode={speed_mode} trigger_to_power={ratio}%")
            speed_up_prev = speed_up_pressed

            if not crash_active and speed_down_pressed and not speed_down_prev:
                previous_speed_mode = speed_mode
                speed_mode = await change_speed_mode_with_feedback(joystick, speed_mode, -1)
                if speed_mode != previous_speed_mode:
                    drive_rumble_paused_until = loop.time() + (SPEED_RUMBLE_DURATION_MS / 1000)
                ratio = int(SPEED_MODE_RATIOS[speed_mode] * 100)
                console.log(f"speed mode={speed_mode} trigger_to_power={ratio}%")
            speed_down_prev = speed_down_pressed

            if brake:
                throttle = 0
                trigger_pressure = 0.0
                forward_pressure, reverse_pressure = read_trigger_pressures(joystick, pad)
            elif crash_active:
                throttle = 0
                trigger_pressure = 0.0
                forward_pressure = 0.0
                reverse_pressure = 0.0
            else:
                throttle, trigger_pressure, forward_pressure, reverse_pressure = read_drive_state(
                    joystick,
                    pad,
                    model.max_drive,
                    speed_mode,
                )

            status_reports = control.drain_status_reports()
            crash_started = False
            if status_reports:
                for _raw, status_flags in status_reports:
                    crash_started = (
                        crash_lockout.update(
                            throttle,
                            model.max_drive,
                            now,
                            impact="impact" in status_flags,
                            enabled=not brake_pressed,
                        )
                        or crash_started
                    )
            else:
                crash_lockout.update(throttle, model.max_drive, now, impact=None, enabled=not brake_pressed)

            if not crash_active and crash_started:
                crash_active = True
                throttle = 0
                trigger_pressure = 0.0
                forward_pressure = 0.0
                reverse_pressure = 0.0
                brake = False
                boost_until = 0.0
                boost_feedback_at = 0.0
                drive_rumble_paused_until = 0.0
                console.log(f"crash detected: controls locked for {CRASH_LOCKOUT_S:.1f}s")

            if throttle < 0:
                if reverse_led_started_at is None:
                    reverse_led_started_at = now
            else:
                reverse_led_started_at = None
            reverse_beep.update(throttle < 0, now)

            if not crash_active and boost_pressed and not boost_prev and now >= boost_ready_at and not brake:
                boost_until = now + boost_hold
                boost_feedback_at = now + BOOST_FEEDBACK_DELAY_S
                boost_ready_at = boost_until + boost_cooldown
                console.log(f"boost fired, ready again in {boost_hold + boost_cooldown:.1f}s")
            elif not crash_active and boost_pressed and not boost_prev:
                if brake:
                    console.log("boost unavailable while braking")
                else:
                    console.log(f"boost not ready ({boost_ready_at - now:.1f}s left)")
                boost_unavailable_feedback.trigger(joystick, now)
            boost_prev = boost_pressed
            if brake or crash_active:
                boost_until = 0.0
                boost_feedback_at = 0.0
            boost = not crash_active and now < boost_until
            boost_led_feedback = boost_led_feedback_active(boost_feedback_at, boost_until, now)
            if crash_active:
                rumble_strength = CRASH_RUMBLE_STRENGTH
                boost_rumble.update(joystick, rumble_strength)
            else:
                rumble_strength = boost_rumble_strength(boost_feedback_at, boost_until, now)
                if rumble_strength > 0.0 or now >= drive_rumble_paused_until:
                    if rumble_strength == 0.0:
                        rumble_strength = drive_rumble_strength(trigger_pressure, speed_mode)
                    boost_rumble.update(joystick, rumble_strength)
            led_color = update_gamepad_led(
                gamepad_led,
                speed_mode,
                boost_led_feedback,
                boost_color=boost_led_color(boost_feedback_at, boost_until, now),
                boost_unavailable_feedback=boost_unavailable_feedback,
                crash_feedback=crash_active,
                reverse_started_at=reverse_led_started_at,
                now=now,
            )

            if not crash_active and front_lights_pressed and not front_lights_prev:
                lights.toggle_front_lights()
            front_lights_prev = front_lights_pressed

            if not crash_active and attack_pressed and not attack_prev:
                attack_signal.trigger(now)
            attack_prev = attack_pressed

            flicker = False if crash_active else attack_signal.is_active(now)
            front_lights_on, rocket_lights_on = (False, False) if crash_active else lights.state_for(throttle, now)

            steering = (
                0
                if crash_active
                else axis_to_percent(joystick.get_axis(steer_axis), model.max_steering, pad.deadzone)
            )
            console.update(
                CarTelemetry(
                    model_name=model.name,
                    hub_name=hub.hub_name,
                    max_drive=model.max_drive,
                    max_steering=model.max_steering,
                    throttle=throttle,
                    steering=steering,
                    speed_mode=speed_mode,
                    trigger_pressure=trigger_pressure,
                    forward_pressure=forward_pressure,
                    reverse_pressure=reverse_pressure,
                    brake=brake,
                    boost=boost,
                    boost_ready_in=max(0.0, boost_ready_at - now),
                    crash=crash_active,
                    crash_lockout_left=crash_lockout.remaining(now),
                    front_lights_on=front_lights_on,
                    manual_front_lights_on=lights.front_lights_manual_on,
                    rocket_lights_on=rocket_lights_on,
                    flicker=flicker,
                    led_color=led_color,
                    rumble_strength=rumble_strength,
                    reverse_beep=reverse_beep_status(reverse_beep, throttle < 0, now),
                    speed_up_pressed=speed_up_pressed and not crash_active,
                    speed_down_pressed=speed_down_pressed and not crash_active,
                    boost_pressed=boost_pressed and not crash_active,
                    front_lights_pressed=front_lights_pressed and not crash_active,
                    attack_pressed=attack_pressed and not crash_active,
                )
            )

            cmd = (throttle, steering, brake, boost, front_lights_on, rocket_lights_on, flicker)
            if cmd != last_cmd:
                console.log(
                    f"cmd speed={throttle} steer={steering} brake={brake} "
                    f"boost={boost} mode={speed_mode} "
                    f"front_lights={front_lights_on} rocket_lights={rocket_lights_on} flicker={flicker}"
                )
                await control.drive(
                    throttle,
                    steering,
                    brake=brake,
                    boost=boost,
                    lights=front_lights_on,
                    rocket_lights=rocket_lights_on,
                    flicker=flicker,
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
        await safe_shutdown(control, hub, pygame_mod, gamepad_led)
    return reconnect_reason


async def run_control(
    model_name: str,
    gamepad_name: str,
    hub_name: str = DEFAULT_HUB_NAME,
    hub_address: str | None = None,
) -> None:
    """Run the guided live-control flow for one model and gamepad profile."""
    setup = SetupConsole()
    try:
        model = ModelProfile.load(model_name)
        pad = GamepadProfile.load(gamepad_name)
    except RuntimeError as exc:
        setup.show(
            "Profile configuration problem",
            "The selected model or gamepad profile could not be loaded.",
            startup_steps(dualsense=False, hub=False, ready=False),
            str(exc),
        )
        return

    port_map = await prepare_port_map_for_drive(setup, hub_name, hub_address)

    reconnect_reason: str | None = None
    while True:
        pygame_mod, joystick = await wait_for_gamepad(
            setup,
            pad,
            reconnect=reconnect_reason == RECONNECT_DUALSENSE,
        )
        hub = await wait_for_hub(
            setup,
            port_map,
            reconnect=reconnect_reason == RECONNECT_HUB,
            hub_name_override=hub_name,
            hub_address_override=hub_address,
        )
        if hub is None:
            try:
                pygame_mod.quit()
            except Exception:
                pass
            return

        setup.stop()
        try:
            require_user_acknowledgement(
                f"Ready to arm live control for {model.name} with {pad.name}.\n"
                "Keep the wheels off the ground, clear the area, and be ready to release the controls."
            )
        except RuntimeError:
            print("Live control cancelled before arming.")
            await hub.disconnect()
            try:
                pygame_mod.quit()
            except Exception:
                pass
            return

        reconnect_reason = await run_live_session(model, pad, port_map, ConnectedHardware(hub, pygame_mod, joystick))
        if reconnect_reason == SESSION_EXIT:
            return
