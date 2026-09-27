"""Reverse-beep audio backends and audio device discovery."""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from threading import Lock, Thread
from typing import Any, Callable

from .settings import (
    CORE_AUDIO_PATH,
    CORE_FOUNDATION_PATH,
    DUALSENSE_AUDIO_DEVICE_ENV,
    DUALSENSE_AUDIO_DEVICE_HINTS,
    REVERSE_BEEP_OUTPUT_ENV,
    REVERSE_BEEP_PATH,
    REVERSE_BEEP_START_DELAY_S,
)


@dataclass(frozen=True)
class CoreAudioOutputDevice:
    """One macOS CoreAudio output device."""

    device_id: int
    name: str


class AudioObjectPropertyAddress(ctypes.Structure):
    """ctypes shape for CoreAudio's AudioObjectPropertyAddress."""

    _fields_ = [
        ("mSelector", ctypes.c_uint32),
        ("mScope", ctypes.c_uint32),
        ("mElement", ctypes.c_uint32),
    ]


class MacAfplayBeepPlayer:
    """Play a short sound through macOS default output or a temporary selected output."""

    def __init__(self, sound_path: Path, device_id: int | None = None) -> None:
        """Store the sound and optional CoreAudio output device used for future beeps."""
        self.sound_path = sound_path.resolve()
        self.device_id = device_id
        self._process: subprocess.Popen[Any] | None = None
        self._previous_device_id: int | None = None
        self._lock = Lock()

    def play(self) -> "MacAfplayBeepPlayer":
        """Start one beep through the selected output and restore default output after it exits."""
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                return self
            self._restore_locked()
            if self.device_id is not None:
                self._previous_device_id = coreaudio_default_output_device()
                coreaudio_set_default_output_device(self.device_id)
            self._process = subprocess.Popen(
                ["/usr/bin/afplay", str(self.sound_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            Thread(target=self._wait_and_restore, daemon=True).start()
            return self

    def stop(self) -> None:
        """Stop any active beep and restore the previous output device."""
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                self._process.terminate()
            self._restore_locked()

    def get_busy(self) -> bool:
        """Return whether the launched afplay process is still active."""
        with self._lock:
            return self._process is not None and self._process.poll() is None

    def _wait_and_restore(self) -> None:
        process = self._process
        if process is not None:
            process.wait()
        with self._lock:
            if self._process is process:
                self._restore_locked()

    def _restore_locked(self) -> None:
        if self._previous_device_id is not None:
            coreaudio_set_default_output_device(self._previous_device_id)
        self._previous_device_id = None
        self._process = None


@dataclass
class ReverseBeep:
    """Repeated reverse warning beep through the selected audio output when available."""

    sound: Any | None = None
    channel: Any | None = None
    play_after: float | None = None
    active: bool = False

    @classmethod
    def open(
        cls,
        pygame_mod: Any,
        sound_path: Path = REVERSE_BEEP_PATH,
        log: Callable[[str], None] | None = None,
    ) -> "ReverseBeep":
        """Load the reverse beep, returning no-op audio on failure."""
        if not sound_path.exists():
            log_message(log, f"Reverse beep disabled: {sound_path} not found")
            return cls()

        output_mode = os.environ.get(REVERSE_BEEP_OUTPUT_ENV, "auto").lower()
        if output_mode in {"off", "none", "disabled"}:
            log_message(log, f"Reverse beep disabled by {REVERSE_BEEP_OUTPUT_ENV}={output_mode}")
            return cls()
        if output_mode in {"default", "system"}:
            return cls(open_system_sound(pygame_mod, sound_path, log))

        sound = cls._open_preferred_controller_sound(pygame_mod, sound_path, output_mode, log)
        if sound is not None:
            return cls(sound)
        if output_mode == "dualsense":
            return cls()
        return cls(open_system_sound(pygame_mod, sound_path, log))

    @classmethod
    def _open_preferred_controller_sound(
        cls,
        pygame_mod: Any,
        sound_path: Path,
        output_mode: str,
        log: Callable[[str], None] | None = None,
    ) -> Any | None:
        forced_device = os.environ.get(DUALSENSE_AUDIO_DEVICE_ENV)
        coreaudio_devices = coreaudio_output_devices()
        coreaudio_device = select_forced_coreaudio_device(coreaudio_devices, forced_device)
        if coreaudio_device is None and forced_device is None:
            coreaudio_device = select_dualsense_coreaudio_device(coreaudio_devices)
        if coreaudio_device is not None:
            return MacAfplayBeepPlayer(sound_path, coreaudio_device.device_id)

        devices = audio_output_devices()
        audio_device = forced_device or select_dualsense_audio_device(devices)
        if audio_device is None:
            listed = ", ".join([device.name for device in coreaudio_devices] + devices) or "none"
            if output_mode == "dualsense":
                log_message(
                    log,
                    f"Reverse beep disabled: no DualSense audio output found for {sound_path} (outputs: {listed})",
                )
                return None
            log_message(log, f"Reverse beep using system output: no DualSense audio output found (outputs: {listed})")
            return None

        return open_pygame_sound(pygame_mod, sound_path, audio_device, output_mode, log)

    def update(self, reverse_active: bool, now: float) -> None:
        """Repeat the beep while reverse remains active, using the file's own trailing pause."""
        if self.sound is None:
            return
        if not reverse_active:
            self.stop()
            return
        if not self.active:
            self.active = True
            self.play_after = now + REVERSE_BEEP_START_DELAY_S
        if self.play_after is not None and now < self.play_after:
            return
        if self.channel is None or not self.channel_busy():
            self.play()

    def play(self) -> None:
        """Play the configured beep once, disabling future beeps if playback fails."""
        if self.sound is None:
            return
        try:
            self.channel = self.sound.play()
        except Exception:
            self.sound = None
            self.channel = None
            self.active = False

    def channel_busy(self) -> bool:
        """Return whether the current beep playback is still running."""
        busy = getattr(self.channel, "get_busy", None)
        if busy is None:
            return False
        try:
            return bool(busy())
        except Exception:
            return False

    def stop(self) -> None:
        """Stop any currently playing beep and reset the repeat cadence."""
        if self.channel is not None:
            try:
                self.channel.stop()
            except Exception:
                pass
        self.channel = None
        self.play_after = None
        self.active = False


def log_message(log: Callable[[str], None] | None, message: str) -> None:
    """Send one user-visible message to a live logger when present, or stdout otherwise."""
    if log is None:
        print(message)
    else:
        log(message)


def open_system_sound(
    pygame_mod: Any,
    sound_path: Path,
    log: Callable[[str], None] | None = None,
) -> Any | None:
    """Open the current system output with the best backend for this platform."""
    if sys.platform == "darwin" and Path("/usr/bin/afplay").exists():
        return MacAfplayBeepPlayer(sound_path)
    return open_pygame_sound(pygame_mod, sound_path, None, "system", log)


def open_pygame_sound(
    pygame_mod: Any,
    sound_path: Path,
    audio_device: str | None,
    output_mode: str,
    log: Callable[[str], None] | None = None,
) -> Any | None:
    """Load a pygame Sound using an optional named SDL audio output."""
    try:
        mixer = pygame_mod.mixer
        if mixer.get_init():
            mixer.quit()
        if audio_device is None:
            mixer.init()
        else:
            mixer.init(devicename=audio_device)
        return mixer.Sound(str(sound_path))
    except Exception as exc:
        if output_mode == "dualsense":
            log_message(log, f"Reverse beep disabled: could not open {audio_device!r}: {exc}")
            return None
        target = "system output" if audio_device is None else repr(audio_device)
        log_message(log, f"Reverse beep disabled: could not open {target}: {exc}")
        return None


def four_char_code(value: str) -> int:
    """Return the integer form of a CoreAudio four-character code."""
    return int.from_bytes(value.encode("ascii"), "big")


def coreaudio_property(selector: str, scope: str = "glob") -> AudioObjectPropertyAddress:
    """Build a CoreAudio property address."""
    return AudioObjectPropertyAddress(four_char_code(selector), four_char_code(scope), 0)


def coreaudio() -> Any:
    """Load CoreAudio."""
    return ctypes.cdll.LoadLibrary(CORE_AUDIO_PATH)


def corefoundation() -> Any:
    """Load CoreFoundation."""
    return ctypes.cdll.LoadLibrary(CORE_FOUNDATION_PATH)


def coreaudio_status_ok(status: int) -> bool:
    """Return whether a CoreAudio status code represents success."""
    return status == 0


def coreaudio_output_devices() -> list[CoreAudioOutputDevice]:
    """Return macOS CoreAudio output devices, or an empty list on other platforms."""
    if sys.platform != "darwin":
        return []
    try:
        ca = coreaudio()
        get_size = ca.AudioObjectGetPropertyDataSize
        get_size.argtypes = [
            ctypes.c_uint32,
            ctypes.POINTER(AudioObjectPropertyAddress),
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_uint32),
        ]
        get_size.restype = ctypes.c_int32
        get_data = ca.AudioObjectGetPropertyData
        get_data.argtypes = [
            ctypes.c_uint32,
            ctypes.POINTER(AudioObjectPropertyAddress),
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.c_void_p,
        ]
        get_data.restype = ctypes.c_int32

        address = coreaudio_property("dev#")
        size = ctypes.c_uint32(0)
        if not coreaudio_status_ok(get_size(1, ctypes.byref(address), 0, None, ctypes.byref(size))) or size.value == 0:
            return []
        count = size.value // ctypes.sizeof(ctypes.c_uint32)
        device_ids = (ctypes.c_uint32 * count)()
        data_size = ctypes.c_uint32(size.value)
        if not coreaudio_status_ok(get_data(1, ctypes.byref(address), 0, None, ctypes.byref(data_size), device_ids)):
            return []

        devices = []
        for device_id in device_ids:
            if coreaudio_has_output_streams(get_size, int(device_id)):
                name = coreaudio_string_property(get_data, int(device_id), "lnam")
                if name:
                    devices.append(CoreAudioOutputDevice(int(device_id), name))
        return devices
    except Exception:
        return []


def coreaudio_has_output_streams(get_size: Any, device_id: int) -> bool:
    """Return whether a CoreAudio device exposes output streams."""
    address = coreaudio_property("stm#", "outp")
    size = ctypes.c_uint32(0)
    status = get_size(device_id, ctypes.byref(address), 0, None, ctypes.byref(size))
    return coreaudio_status_ok(status) and size.value > 0


def coreaudio_string_property(get_data: Any, device_id: int, selector: str) -> str | None:
    """Read one CoreAudio CFString property."""
    cf = corefoundation()
    cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
    cf.CFStringGetCString.restype = ctypes.c_bool
    cf.CFRelease.argtypes = [ctypes.c_void_p]

    address = coreaudio_property(selector)
    value = ctypes.c_void_p()
    size = ctypes.c_uint32(ctypes.sizeof(ctypes.c_void_p))
    status = get_data(device_id, ctypes.byref(address), 0, None, ctypes.byref(size), ctypes.byref(value))
    if not coreaudio_status_ok(status):
        return None
    if not value.value:
        return None
    buffer = ctypes.create_string_buffer(1024)
    try:
        if not cf.CFStringGetCString(value, buffer, len(buffer), 0x08000100):
            return None
        return buffer.value.decode("utf-8", errors="replace")
    finally:
        cf.CFRelease(value)


def coreaudio_default_output_device() -> int | None:
    """Return the default macOS CoreAudio output device id."""
    if sys.platform != "darwin":
        return None
    try:
        ca = coreaudio()
        get_data = ca.AudioObjectGetPropertyData
        get_data.argtypes = [
            ctypes.c_uint32,
            ctypes.POINTER(AudioObjectPropertyAddress),
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.c_void_p,
        ]
        get_data.restype = ctypes.c_int32
        address = coreaudio_property("dOut")
        device_id = ctypes.c_uint32(0)
        size = ctypes.c_uint32(ctypes.sizeof(device_id))
        status = get_data(1, ctypes.byref(address), 0, None, ctypes.byref(size), ctypes.byref(device_id))
        if coreaudio_status_ok(status):
            return int(device_id.value)
    except Exception:
        return None
    return None


def coreaudio_set_default_output_device(device_id: int) -> bool:
    """Set the default macOS CoreAudio output device."""
    if sys.platform != "darwin":
        return False
    try:
        ca = coreaudio()
        set_data = ca.AudioObjectSetPropertyData
        set_data.argtypes = [
            ctypes.c_uint32,
            ctypes.POINTER(AudioObjectPropertyAddress),
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_void_p,
        ]
        set_data.restype = ctypes.c_int32
        address = coreaudio_property("dOut")
        value = ctypes.c_uint32(device_id)
        return coreaudio_status_ok(
            set_data(1, ctypes.byref(address), 0, None, ctypes.sizeof(value), ctypes.byref(value))
        )
    except Exception:
        return False


def select_dualsense_coreaudio_device(devices: list[CoreAudioOutputDevice]) -> CoreAudioOutputDevice | None:
    """Choose the first CoreAudio output that looks like a DualSense speaker."""
    for device in devices:
        if any(hint in device.name.lower() for hint in DUALSENSE_AUDIO_DEVICE_HINTS):
            return device
    return None


def select_forced_coreaudio_device(
    devices: list[CoreAudioOutputDevice],
    forced_device: str | None,
) -> CoreAudioOutputDevice | None:
    """Choose an explicitly requested CoreAudio device by exact or substring match."""
    if forced_device is None:
        return None
    forced = forced_device.lower()
    for device in devices:
        if device.name.lower() == forced:
            return device
    for device in devices:
        if forced in device.name.lower():
            return device
    return None


def audio_output_devices() -> list[str]:
    """Return SDL audio output device names known to pygame."""
    try:
        from pygame._sdl2 import audio, sdl2  # noqa: PLC0415

        sdl2.init_subsystem(sdl2.INIT_AUDIO)
        return [
            device.decode() if isinstance(device, bytes) else str(device)
            for device in audio.get_audio_device_names(False)
        ]
    except Exception:
        return []


def select_dualsense_audio_device(devices: list[str]) -> str | None:
    """Choose the first SDL audio output that looks like a DualSense speaker."""
    for name in devices:
        if any(hint in name.lower() for hint in DUALSENSE_AUDIO_DEVICE_HINTS):
            return name
    return None


def dualsense_audio_device(pygame_mod: Any) -> str | None:
    """Return a forced or auto-detected DualSense audio device name."""
    forced_device = os.environ.get(DUALSENSE_AUDIO_DEVICE_ENV)
    if forced_device:
        return forced_device
    return select_dualsense_audio_device(audio_output_devices())


def reverse_beep_status(reverse_beep: ReverseBeep | None, reverse_active: bool, now: float) -> str:
    """Human-readable reverse-beep state for the live dashboard."""
    if not reverse_active:
        return "off"
    if reverse_beep is None or reverse_beep.sound is None:
        return "disabled"
    if reverse_beep.play_after is not None and now < reverse_beep.play_after:
        return f"armed {reverse_beep.play_after - now:.1f}s"
    if reverse_beep.channel is not None and reverse_beep.channel_busy():
        return "playing"
    return "repeat"


def run_audio_probe() -> None:
    """Print available audio outputs and the selected reverse-beep device."""
    coreaudio_devices = coreaudio_output_devices()
    devices = audio_output_devices()
    selected = dualsense_audio_device(None)
    selected_coreaudio = select_dualsense_coreaudio_device(coreaudio_devices)
    print("CoreAudio outputs:")
    if coreaudio_devices:
        for device in coreaudio_devices:
            marker = " *" if device == selected_coreaudio else ""
            print(f"  - {device.name} [{device.device_id}]{marker}")
    else:
        print("  none")
    print("Audio outputs:")
    if devices:
        for device_name in devices:
            marker = " *" if device_name == selected else ""
            print(f"  - {device_name}{marker}")
    else:
        print("  none")
    if selected is None:
        print(f"No DualSense-like output found. Set {DUALSENSE_AUDIO_DEVICE_ENV}=<device name> to force one.")
        print(f"Use {REVERSE_BEEP_OUTPUT_ENV}=default to force beeps through the current system output.")
    else:
        print(f"Selected reverse beep output: {selected}")
