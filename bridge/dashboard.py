"""Terminal setup and live dashboard rendering."""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from typing import Any

from .feedback import led_color_label
from .settings import (
    DASHBOARD_DISABLE_ENV,
    DASHBOARD_ELLIPSIS_WIDTH,
    DASHBOARD_LOG_LIMIT,
    DASHBOARD_MAX_WIDTH,
    DEFAULT_SPEED_MODE,
    LED_OFF_COLOR,
    RGB,
    SPEED_MODE_LED_COLORS,
    SPEED_MODE_RATIOS,
    SPEED_MODE_SEQUENCE,
)


@dataclass(frozen=True)
class CarTelemetry:
    """One complete snapshot for the terminal car-state simulation."""

    model_name: str
    hub_name: str
    max_drive: int
    max_steering: int
    throttle: int = 0
    steering: int = 0
    speed_mode: int = DEFAULT_SPEED_MODE
    trigger_pressure: float = 0.0
    forward_pressure: float = 0.0
    reverse_pressure: float = 0.0
    brake: bool = False
    boost: bool = False
    boost_ready_in: float = 0.0
    crash: bool = False
    crash_lockout_left: float = 0.0
    front_lights_on: bool = False
    manual_front_lights_on: bool = False
    rocket_lights_on: bool = False
    flicker: bool = False
    led_color: RGB = SPEED_MODE_LED_COLORS[DEFAULT_SPEED_MODE]
    rumble_strength: float = 0.0
    reverse_beep: str = "off"
    speed_up_pressed: bool = False
    speed_down_pressed: bool = False
    boost_pressed: bool = False
    front_lights_pressed: bool = False
    attack_pressed: bool = False


class LiveConsole:
    """Live terminal dashboard above a compact event log."""

    def __init__(self, stream: Any = None, max_logs: int = DASHBOARD_LOG_LIMIT) -> None:
        """Store dashboard output settings and detect whether ANSI refresh is available."""
        self.stream = stream or sys.stdout
        disabled = os.environ.get(DASHBOARD_DISABLE_ENV, "").lower() in {"0", "false", "no", "off"}
        self.enabled = bool(getattr(self.stream, "isatty", lambda: False)()) and not disabled
        self.max_logs = max_logs
        self.logs: list[str] = []
        self._state: CarTelemetry | None = None
        self._last_screen: str | None = None
        self._started = False

    def start(self, state: CarTelemetry) -> None:
        """Start redrawing a dashboard instead of plain scrolling logs."""
        self._state = state
        self._started = True
        if self.enabled:
            self._redraw(force=True)

    def update(self, state: CarTelemetry) -> None:
        """Refresh the dashboard if the rendered state changed."""
        self._state = state
        if self.enabled and self._started:
            self._redraw()

    def log(self, message: str) -> None:
        """Append a log entry below the dashboard, or print normally outside a TTY."""
        lines = str(message).splitlines() or [""]
        self.logs.extend(lines)
        if len(self.logs) > self.max_logs:
            self.logs = self.logs[-self.max_logs :]

        if self.enabled and self._started and self._state is not None:
            self._redraw(force=True)
        else:
            print(message, file=self.stream)

    def stop(self) -> None:
        """Restore cursor visibility before ordinary shutdown logs resume."""
        if self.enabled and self._started:
            self.stream.write("\033[?25h\n")
            self.stream.flush()
        self._started = False

    def _redraw(self, force: bool = False) -> None:
        if self._state is None:
            return
        screen = self._render_screen()
        if not force and screen == self._last_screen:
            return
        self.stream.write("\033[H\033[J\033[?25l")
        self.stream.write(screen)
        self.stream.write("\n")
        self.stream.flush()
        self._last_screen = screen

    def _render_screen(self) -> str:
        columns, rows = shutil.get_terminal_size(fallback=(DASHBOARD_MAX_WIDTH, 34))
        width = max(32, min(columns, DASHBOARD_MAX_WIDTH))
        dashboard = render_car_dashboard(self._state, width).splitlines() if self._state is not None else []
        visible_log_count = max(0, rows - len(dashboard) - 3)
        visible_logs = self.logs[-visible_log_count:] if visible_log_count else []
        lines = [*dashboard, "", "Event log"]
        lines.extend(clip_terminal_line(line, width) for line in visible_logs)
        return "\n".join(lines)


class SetupConsole:
    """Guided startup and reconnect screens before the live cockpit is armed."""

    def __init__(self, stream: Any = None) -> None:
        """Detect ANSI support and remember the last setup screen to avoid flicker."""
        self.stream = stream or sys.stdout
        self.enabled = bool(getattr(self.stream, "isatty", lambda: False)())
        self._last_screen: str | None = None

    def show(self, title: str, message: str, steps: list[tuple[str, bool]], detail: str = "") -> None:
        """Render one setup state with a visible checklist and next action."""
        columns, _ = shutil.get_terminal_size(fallback=(DASHBOARD_MAX_WIDTH, 24))
        screen = render_setup_panel(title, message, steps, detail, min(columns, DASHBOARD_MAX_WIDTH))
        if screen == self._last_screen:
            return
        if self.enabled:
            self.stream.write("\033[H\033[J")
            self.stream.write(screen)
            self.stream.write("\n")
        else:
            self.stream.write(f"\n{screen}\n")
        self.stream.flush()
        self._last_screen = screen

    def stop(self) -> None:
        """Leave a clean line before ordinary prompt or shutdown output."""
        if self.enabled:
            self.stream.write("\n")
            self.stream.flush()


def clip_terminal_line(text: str, width: int) -> str:
    """Clip a terminal line with a fixed ellipsis width."""
    if len(text) <= width:
        return text
    if width <= DASHBOARD_ELLIPSIS_WIDTH:
        return text[:width]
    return f"{text[: width - DASHBOARD_ELLIPSIS_WIDTH]}..."


def dashboard_bar(fraction: float, width: int = 14) -> str:
    """Render a left-to-right bar."""
    fraction = max(0.0, min(1.0, fraction))
    filled = round(fraction * width)
    return f"[{'#' * filled}{'-' * (width - filled)}]"


def dashboard_center_bar(value: int, limit: int, width: int = 21) -> str:
    """Render a centered signed-value bar."""
    if limit <= 0:
        limit = 1
    center = width // 2
    ratio = max(-1.0, min(1.0, value / limit))
    position = max(0, min(width - 1, round(center + (ratio * center))))
    chars = ["-"] * width
    chars[center] = "|"
    chars[position] = "^"
    return f"[{''.join(chars)}]"


def telemetry_fraction(value: int, limit: int) -> float:
    """Return an absolute telemetry fraction against a signed limit."""
    if limit <= 0:
        return 0.0
    return min(1.0, abs(value) / limit)


def dashboard_percent(fraction: float) -> str:
    """Render a 0..1 fraction as a compact percentage."""
    return f"{round(max(0.0, min(1.0, fraction)) * 100):3d}%"


def dashboard_bool(value: bool, on: str = "ON", off: str = "--") -> str:
    """Render a compact boolean label."""
    return on if value else off


def dashboard_direction(throttle: int) -> str:
    """Return the drive direction label for signed throttle."""
    if throttle > 0:
        return "FORWARD"
    if throttle < 0:
        return "REVERSE"
    return "IDLE"


def dashboard_steering(steering: int) -> str:
    """Return the steering direction label for signed steering."""
    if steering < 0:
        return "LEFT"
    if steering > 0:
        return "RIGHT"
    return "CENTER"


def boost_status_label(state: CarTelemetry) -> str:
    """Return the live boost status label."""
    if state.crash:
        return f"crash lock {state.crash_lockout_left:.1f}s"
    if state.brake:
        return "cancelled by brake"
    if state.boost:
        return "ACTIVE"
    if state.boost_ready_in > 0:
        return f"cooldown {state.boost_ready_in:.1f}s"
    return "ready"


def dashboard_button(label: str, active: bool, detail: str = "") -> str:
    """Render one compact button state."""
    state = "ON" if active else "--"
    suffix = f" {detail}" if detail else ""
    return f"[{label} {state}{suffix}]"


def speed_mode_selector(speed_mode: int) -> str:
    """Render the available speed modes."""
    return " ".join(
        f"[{mode}:{int(SPEED_MODE_RATIOS[mode] * 100)}{'*' if mode == speed_mode else ' '}]"
        for mode in SPEED_MODE_SEQUENCE
    )


def dashboard_panel_line(title: str, body: str) -> str:
    """Render one dashboard row with a fixed title column."""
    return f"{title:<10} {body}"


def render_setup_panel(
    title: str,
    message: str,
    steps: list[tuple[str, bool]],
    detail: str = "",
    width: int = DASHBOARD_MAX_WIDTH,
) -> str:
    """Render the guided startup/reconnect panel."""
    width = max(52, min(width, DASHBOARD_MAX_WIDTH))
    inner = width - 2
    border = f"+{'-' * inner}+"

    def line(text: str = "") -> str:
        return f"|{clip_terminal_line(text, inner).ljust(inner)}|"

    lines = [
        border,
        line("LEGO TECHNIC BRIDGE - READY CHECK"),
        line(),
        line(title),
        line(message),
        line(),
        line("Checklist"),
    ]
    for label, done in steps:
        mark = "OK" if done else ".."
        lines.append(line(f"  [{mark}] {label}"))
    if detail:
        lines.extend([line(), line(detail)])
    lines.extend([line(), line("Press Ctrl+C to exit safely."), border])
    return "\n".join(lines)


def car_light_beams(state: CarTelemetry) -> tuple[str, str, str]:
    """Return ASCII car light/effect labels for the small dashboard view."""
    rear = "<== ROCKET" if state.rocket_lights_on else "         "
    front = "HEADLIGHT ==>" if state.front_lights_on else "            "
    flicker = "FLASH" if state.flicker else "     "
    return rear, front, flicker


def render_car_dashboard(state: CarTelemetry, width: int = DASHBOARD_MAX_WIDTH) -> str:
    """Render a fixed-height cockpit panel for the live terminal."""
    width = max(32, min(width, DASHBOARD_MAX_WIDTH))
    inner = width - 2
    border = f"+{'-' * inner}+"

    def line(text: str = "") -> str:
        return f"|{clip_terminal_line(text, inner).ljust(inner)}|"

    speed_ratio = SPEED_MODE_RATIOS[state.speed_mode]
    speed_percent = int(speed_ratio * 100)
    direction = "LOCKED" if state.crash else dashboard_direction(state.throttle)
    steering = dashboard_steering(state.steering)
    drive_fraction = telemetry_fraction(state.throttle, state.max_drive)
    steering_fraction = telemetry_fraction(state.steering, state.max_steering)
    drive_bar = dashboard_bar(drive_fraction, 28)
    forward_bar = dashboard_bar(state.forward_pressure, 18)
    reverse_bar = dashboard_bar(state.reverse_pressure, 18)
    steer_bar = dashboard_center_bar(state.steering, state.max_steering)
    rumble_bar = dashboard_bar(state.rumble_strength, 12)
    rear_beam, front_beam, flicker = car_light_beams(state)
    boost_label = boost_status_label(state)
    brake_label = "HELD" if state.brake else "ready"
    led_label = led_color_label(state.led_color)
    power_text = dashboard_percent(drive_fraction)
    steer_text = dashboard_percent(steering_fraction)
    trigger_text = (
        f"L2 {dashboard_percent(state.reverse_pressure)} {reverse_bar}   "
        f"R2 {dashboard_percent(state.forward_pressure)} {forward_bar}"
    )
    mode_text = f"mode {state.speed_mode} / {speed_percent}% {speed_mode_selector(state.speed_mode)}"
    boost_detail = boost_label if boost_label != "ready" else ""

    return "\n".join(
        [
            border,
            line(f"GAMEPAD COCKPIT | {state.model_name} | hub {state.hub_name} | Ctrl+C/Esc/Start safe stop"),
            line(),
            line(dashboard_panel_line("DRIVE", f"{direction:<7} {power_text} {drive_bar} power {state.throttle:+4d}")),
            line(
                dashboard_panel_line(
                    "STEERING",
                    f"{steering:<6} {steer_text} {steer_bar} input {state.steering:+4d}",
                )
            ),
            line(dashboard_panel_line("TRIGGERS", trigger_text)),
            line(dashboard_panel_line("MODE", mode_text)),
            line(),
            line(
                dashboard_panel_line(
                    "CONTROLS",
                    " ".join(
                        [
                            dashboard_button("L1 brake", state.brake, brake_label if state.brake else ""),
                            dashboard_button("R1 boost", state.boost_pressed or state.boost, boost_detail),
                            dashboard_button("D-up", state.speed_up_pressed, "mode+"),
                            dashboard_button("D-down", state.speed_down_pressed, "mode-"),
                        ]
                    ),
                )
            ),
            line(
                dashboard_panel_line(
                    "ACTIONS",
                    " ".join(
                        [
                            dashboard_button("Square lights", state.front_lights_pressed or state.front_lights_on),
                            dashboard_button("Circle flicker", state.attack_pressed or state.flicker),
                            dashboard_button("manual light", state.manual_front_lights_on),
                        ]
                    ),
                )
            ),
            line(
                dashboard_panel_line(
                    "SYSTEMS",
                    f"LED {led_label:<10} | rumble {rumble_bar} {state.rumble_strength:.2f} "
                    f"| beep {state.reverse_beep}",
                )
            ),
            line(
                dashboard_panel_line(
                    "LIGHTS",
                    f"front {dashboard_bool(state.front_lights_on):<2} | rockets "
                    f"{dashboard_bool(state.rocket_lights_on, 'BLINK'):<5} | flicker "
                    f"{dashboard_bool(state.flicker, 'FLASH')}",
                )
            ),
            line(),
            line(f" {rear_beam}       .====================.       {front_beam}"),
            line("                  /   BATMOBILE DASH    \\"),
            line(f"             O===[ {direction:^7} | {steering:^6} ]===O   {flicker}"),
            line("                  \\____________________/"),
            border,
        ]
    )


def dashboard_off_color() -> RGB:
    """Return the off LED color used by dashboard callers and tests."""
    return LED_OFF_COLOR
