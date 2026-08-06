"""Power ceilings and the one interactive guard before anything moves."""

from dataclasses import dataclass


@dataclass
class SafetyLimits:
    """Power ceilings applied to every command before it reaches the hub."""

    max_drive_power: int
    max_steering_power: int


def clamp_signed(value: int, limit: int) -> int:
    """Clamp to +/-limit."""
    return max(-limit, min(limit, int(value)))


def require_user_acknowledgement(message: str) -> None:
    """Print the warning and require a bare Enter to continue."""
    response = input(f"{message}\nPress Enter to continue or type anything to cancel: ")
    if response.strip():
        raise RuntimeError("User did not confirm the action")
