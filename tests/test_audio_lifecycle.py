"""Optional reverse audio cannot leak processes or temporary system output state."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from bridge import audio


class Process:
    def __init__(self) -> None:
        self.completed = False
        self.waits = 0
        self.terminations = 0
        self.fail_stop = False

    def poll(self) -> int | None:
        return 0 if self.completed else None

    def wait(self) -> int:
        self.waits += 1
        self.completed = True
        return 0

    def terminate(self) -> None:
        self.terminations += 1
        self.completed = True
        if self.fail_stop:
            raise ProcessLookupError("Process exited during terminate")


class DeferredThread:
    def __init__(self, target: Any, args: tuple[Any, ...], daemon: bool) -> None:
        assert daemon
        self.target = target
        self.args = args

    def start(self) -> None:
        pass

    def run(self) -> None:
        self.target(*self.args)


@pytest.fixture
def backend(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> SimpleNamespace:
    current = {"device": 10}
    changes: list[int] = []
    processes: list[Process] = []
    threads: list[DeferredThread] = []
    commands: list[list[str]] = []

    def select(device: int) -> bool:
        changes.append(device)
        current["device"] = device
        return True

    def launch(command: list[str], **kwargs: Any) -> Process:
        assert kwargs == {"stdout": audio.subprocess.DEVNULL, "stderr": audio.subprocess.DEVNULL}
        commands.append(command)
        process = Process()
        processes.append(process)
        return process

    def thread(**kwargs: Any) -> DeferredThread:
        worker = DeferredThread(**kwargs)
        threads.append(worker)
        return worker

    monkeypatch.setattr(audio, "coreaudio_default_output_device", lambda: current["device"])
    monkeypatch.setattr(audio, "coreaudio_set_default_output_device", select)
    monkeypatch.setattr(audio.subprocess, "Popen", launch)
    monkeypatch.setattr(audio, "Thread", thread)
    path = tmp_path / "warning $(echo unsafe).mp3"
    path.write_bytes(b"fixture")
    return SimpleNamespace(
        player=audio.MacAfplayBeepPlayer(path, 20),
        current=current,
        changes=changes,
        processes=processes,
        threads=threads,
        commands=commands,
        path=path,
    )


def test_afplay_completion_restores_output_and_does_not_duplicate_active_playback(backend: SimpleNamespace) -> None:
    player = backend.player
    assert player.play() is player
    assert player.get_busy()
    player.play()
    assert len(backend.processes) == 1
    assert backend.commands == [["/usr/bin/afplay", str(backend.path.resolve())]]
    backend.threads[0].run()
    assert not player.get_busy()
    assert backend.changes == [20, 10]


def test_failed_process_launch_restores_output_before_reverse_beep_disables_itself(
    monkeypatch: pytest.MonkeyPatch, backend: SimpleNamespace
) -> None:
    def fail(*_args: Any, **_kwargs: Any) -> None:
        raise OSError("afplay unavailable")

    monkeypatch.setattr(audio.subprocess, "Popen", fail)
    beep = audio.ReverseBeep(backend.player)
    beep.play()
    assert beep.sound is None
    assert not beep.active
    assert not backend.player.get_busy()
    assert backend.changes == [20, 10]


def test_stop_restores_output_even_if_process_exits_during_termination(backend: SimpleNamespace) -> None:
    beep = audio.ReverseBeep(backend.player)
    beep.play()
    backend.processes[0].fail_stop = True
    beep.stop()
    assert backend.changes == [20, 10]
    assert not backend.player.get_busy()
    assert beep.channel is None


def test_late_old_waiter_cannot_wait_for_or_restore_a_new_beep(backend: SimpleNamespace) -> None:
    player = backend.player
    player.play()
    player.stop()
    player.play()
    backend.threads[0].run()
    assert backend.processes[0].waits == 1
    assert backend.processes[1].waits == 0
    assert player.get_busy()
    assert backend.current["device"] == 20
    backend.threads[1].run()
    assert not player.get_busy()
    assert backend.changes == [20, 10, 20, 10]


def test_completion_preserves_a_system_output_selected_by_the_user_mid_beep(backend: SimpleNamespace) -> None:
    backend.player.play()
    backend.current["device"] = 30
    backend.threads[0].run()
    assert backend.current["device"] == 30
    assert backend.changes == [20]


def test_waiter_start_failure_terminates_launched_process_and_restores_output(
    monkeypatch: pytest.MonkeyPatch, backend: SimpleNamespace
) -> None:
    def fail_start(_self: DeferredThread) -> None:
        raise RuntimeError("No thread resources")

    monkeypatch.setattr(DeferredThread, "start", fail_start)
    beep = audio.ReverseBeep(backend.player)
    beep.play()
    assert beep.sound is None
    assert backend.processes[0].terminations == 1
    assert not backend.player.get_busy()
    assert backend.changes == [20, 10]


def test_unknown_system_output_is_not_changed_when_it_cannot_be_restored(
    monkeypatch: pytest.MonkeyPatch, backend: SimpleNamespace
) -> None:
    monkeypatch.setattr(audio, "coreaudio_default_output_device", lambda: None)
    beep = audio.ReverseBeep(backend.player)
    beep.play()
    assert beep.sound is None
    assert backend.changes == []
    assert backend.processes == []


def test_failed_controller_output_selection_does_not_play_on_an_unintended_speaker(
    monkeypatch: pytest.MonkeyPatch, backend: SimpleNamespace
) -> None:
    monkeypatch.setattr(audio, "coreaudio_set_default_output_device", lambda _device: False)
    beep = audio.ReverseBeep(backend.player)
    beep.play()
    assert beep.sound is None
    assert backend.processes == []
    assert backend.current["device"] == 10
