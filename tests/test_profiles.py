"""Data-backed profiles reject unsafe configuration before hardware is opened."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from bridge import paths
from bridge.cars import model_profiles
from bridge.cars.model_profiles import ModelProfile
from bridge.gamepads import profile_loader
from bridge.gamepads.profile_loader import GamepadProfile


def profile_data(kind: str, name: str) -> dict[str, Any]:
    return json.loads((paths.CONFIG_DIR / kind / f"{name}.json").read_text())


@pytest.mark.parametrize("profile_type", [ModelProfile, GamepadProfile])
@pytest.mark.parametrize("name", ["../escape", "/tmp/escape", "..\\escape", "C:escape", "", "bad\x00name"])
def test_profile_ids_cannot_traverse_outside_their_directory(profile_type: Any, name: str) -> None:
    with pytest.raises(RuntimeError, match=r"Invalid .* profile id"):
        profile_type.load(name)


@pytest.mark.parametrize("profile_type", [ModelProfile, GamepadProfile])
@pytest.mark.parametrize("contents", [b"[]", b"null", b"{oops", b"\xff"])
def test_corrupt_profile_files_produce_actionable_errors(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, profile_type: Any, contents: bytes
) -> None:
    kind, module = ("models", model_profiles) if profile_type is ModelProfile else ("gamepads", profile_loader)
    directory = tmp_path / kind
    directory.mkdir()
    (directory / "broken.json").write_bytes(contents)
    monkeypatch.setattr(module, "CONFIG_DIR", tmp_path)
    with pytest.raises(RuntimeError, match=r"profile|Could not read"):
        profile_type.load("broken")


@pytest.mark.parametrize("section, action", [("buttons", "brake"), ("axes", "steer")])
@pytest.mark.parametrize("value", [-1, 1.5, "2", True])
def test_controller_indices_must_be_nonnegative_integers(section: str, action: str, value: Any) -> None:
    data = profile_data("gamepads", "dualsense")
    data[section][action] = value
    with pytest.raises(RuntimeError, match=f"{section}.{action}.*nonnegative integer"):
        GamepadProfile(data, "fixture")


@pytest.mark.parametrize("field", ["deadzone", "trigger_deadzone"])
@pytest.mark.parametrize("value", [-0.1, 1.1, math.nan, math.inf, "0.1", False, 10**1000])
def test_controller_deadzones_are_finite_normalized_numbers(field: str, value: Any) -> None:
    data = profile_data("gamepads", "dualsense")
    data[field] = value
    with pytest.raises(RuntimeError, match=field):
        GamepadProfile(data, "fixture")


def test_trigger_rest_polarity_cannot_be_a_truthy_string() -> None:
    data = profile_data("gamepads", "dualsense")
    data["triggers_rest_negative"] = "false"
    with pytest.raises(RuntimeError, match="triggers_rest_negative must be a boolean"):
        GamepadProfile(data, "fixture")


@pytest.mark.parametrize(
    "section, key, value",
    [
        (None, "program_id", 256),
        ("control", "boost", -1),
        ("control", "brake", 257),
        ("control2", "lights_off", True),
        ("limits", "drive", 101),
        ("limits", "steering", -100),
        ("calibration_pace_s", "after_start", -1.0),
        ("calibration_pace_s", "after_subscribe", math.inf),
        ("boost", "hold_s", math.nan),
        ("boost", "cooldown_s", -2.0),
    ],
)
def test_model_command_bytes_limits_and_timing_cannot_be_silently_wrapped_or_unbounded(
    section: str | None, key: str, value: Any
) -> None:
    data = profile_data("models", "tumbler")
    mapping = data if section is None else data[section]
    mapping[key] = value
    with pytest.raises(RuntimeError, match=key):
        ModelProfile(data, "fixture")


def test_gamepad_profile_owns_its_mapping_after_validation() -> None:
    data = profile_data("gamepads", "dualsense")
    pad = GamepadProfile(data, "fixture")
    data["axes"]["steer"] = 2
    assert pad.axis("steer") == 0


def test_packaged_profiles_still_load_and_optional_controls_have_clear_errors() -> None:
    for choice in profile_loader.available_gamepad_choices():
        pad = GamepadProfile.load(choice.profile_id)
        assert pad.name == choice.name
        assert pad.optional_button("unused") is None
        assert pad.optional_button("boost") == pad.button("boost")
    for choice in model_profiles.available_model_choices():
        assert ModelProfile.load(choice.profile_id).name == choice.name
    data = profile_data("models", "tumbler")
    del data["boost"]
    with pytest.raises(RuntimeError, match="has no boost"):
        _ = ModelProfile(data, "fixture").boost
