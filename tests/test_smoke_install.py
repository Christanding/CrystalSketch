from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from crystalsketch.server import updater


@pytest.fixture
def smoke():
    script = Path(__file__).parents[1] / "scripts" / "smoke_install.py"
    spec = importlib.util.spec_from_file_location("smoke_install", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def installed_updater(tmp_path, monkeypatch):
    entrypoint = tmp_path / "commands a'a" / "Crystal"
    detection = Mock(return_value=SimpleNamespace(entrypoint=entrypoint))
    monkeypatch.setattr(updater, "detect_installation", detection)
    monkeypatch.setattr(updater, "current_version", lambda: "1.0.0")
    network = Mock(side_effect=AssertionError("No live lookup"))
    monkeypatch.setattr(updater, "_official_open", network)
    return entrypoint, detection


@pytest.fixture
def release_metadata(tmp_path):
    path = tmp_path / "official release a'a.json"
    path.write_text(json.dumps({
        "draft": False, "prerelease": False, "tag_name": "v2.0.0",
        "assets": [{"name": "CrystalSketch.zip", "size": 123, "digest": None}],
    }))
    return path


def test_installed_probe_uses_the_real_release_parser_without_live_network(
    smoke, installed_updater, release_metadata,
):
    entrypoint, detection = installed_updater
    original_open = updater._official_open
    assert smoke.probe_installed_updater(release_metadata) == {
        "currentVersion": "1.0.0", "latestVersion": "2.0.0", "entrypoint": str(entrypoint),
    }
    detection.assert_called_once_with()
    original_open.assert_not_called()
    assert updater._official_open is original_open


@pytest.mark.parametrize("change", [
    {"draft": True}, {"prerelease": True}, {"tag_name": "not-a-version"},
    {"assets": []}, {"assets": [{"name": "CrystalSketch.zip", "size": 0}]},
])
def test_invalid_release_metadata_is_not_accepted(
    smoke, installed_updater, release_metadata, change,
):
    release = json.loads(release_metadata.read_text())
    release.update(change)
    release_metadata.write_text(json.dumps(release))
    original_open = updater._official_open
    with pytest.raises(updater.UpdateError):
        smoke.probe_installed_updater(release_metadata)
    assert updater._official_open is original_open


@pytest.mark.parametrize("payload", ["not JSON", " " * (1024 * 1024 + 1)])
def test_malformed_and_oversized_metadata_fail(smoke, installed_updater, release_metadata, payload):
    release_metadata.write_text(payload)
    with pytest.raises(updater.UpdateError, match="invalid-release"):
        smoke.probe_installed_updater(release_metadata)


def test_unsupported_installation_still_fails(smoke, installed_updater, release_metadata):
    _, detection = installed_updater
    detection.side_effect = updater.UpdateError("unsupported-installation")
    with pytest.raises(updater.UpdateError, match="unsupported-installation"):
        smoke.probe_installed_updater(release_metadata)


def test_missing_metadata_is_not_silently_skipped(smoke, installed_updater, tmp_path):
    with pytest.raises(updater.UpdateError, match="check-failed"):
        smoke.probe_installed_updater(tmp_path / "absent.json")


@pytest.mark.parametrize("wrong_entrypoint", [False, True])
def test_probe_runs_in_the_installed_interpreter_and_checks_the_same_launcher(
    smoke, release_metadata, tmp_path, monkeypatch, capsys, wrong_entrypoint,
):
    tools = tmp_path / "tools a'a"
    command = str(tmp_path / "commands a'a" / "Crystal")
    environment = {"PATH": "persisted command path"}
    monkeypatch.setattr(smoke.shutil, "which", lambda name, path: "uv-test")
    run = Mock(side_effect=[str(tools), json.dumps({
        "currentVersion": "1.0.0", "latestVersion": "2.0.0",
        "entrypoint": command + ".other" if wrong_entrypoint else command,
    })])
    monkeypatch.setattr(smoke.subprocess, "check_output", run)
    if wrong_entrypoint:
        with pytest.raises(RuntimeError, match="different Crystal installation"):
            smoke.verify_update_support(command, release_metadata, str(tmp_path), environment)
        assert "PASS:" not in capsys.readouterr().out
    else:
        smoke.verify_update_support(command, release_metadata, str(tmp_path), environment)
        assert "no live update API call or installation" in capsys.readouterr().out
    calls = run.call_args_list
    assert calls[0].args[0] == ["uv-test", "--no-config", "--color", "never", "tool", "dir"]
    python = tools / "crystalsketch" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    assert calls[1].args[0] == [
        str(python), "-I", str(Path(smoke.__file__).resolve()), "--probe-installed-updater",
        "--release-metadata", str(release_metadata.resolve()),
    ]
    assert all(call.kwargs["env"] is environment for call in calls)


def test_probe_process_failure_never_reports_success(smoke, release_metadata, monkeypatch, capsys):
    monkeypatch.setattr(smoke.shutil, "which", lambda name, path: "uv-test")
    run = Mock(side_effect=["/temporary/tools", subprocess.CalledProcessError(1, "probe")])
    monkeypatch.setattr(smoke.subprocess, "check_output", run)
    with pytest.raises(subprocess.CalledProcessError):
        smoke.verify_update_support("/temporary/Crystal", release_metadata, "/temporary", {})
    assert "PASS:" not in capsys.readouterr().out


def test_missing_uv_fails_the_compatibility_check(smoke, release_metadata, monkeypatch):
    monkeypatch.setattr(smoke.shutil, "which", lambda name, path: None)
    with pytest.raises(RuntimeError, match="uv must be available"):
        smoke.verify_update_support("/temporary/Crystal", release_metadata, "/temporary", {})


def test_smoke_launch_never_passes_workflow_credentials_to_the_application(
    smoke, tmp_path, monkeypatch,
):
    monkeypatch.setattr("sys.argv", ["smoke_install.py", "--work-dir", str(tmp_path)])
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "PYTHONPATH"):
        monkeypatch.setenv(name, "test-only-value")
    monkeypatch.setattr(smoke.shutil, "which", lambda name, path: str(tmp_path / "Crystal"))
    launch = Mock(side_effect=RuntimeError("stop before launching"))
    monkeypatch.setattr(smoke.subprocess, "Popen", launch)
    with pytest.raises(RuntimeError, match="stop before launching"):
        smoke.main()
    environment = launch.call_args.kwargs["env"]
    assert all(name not in environment for name in ("GH_TOKEN", "GITHUB_TOKEN", "PYTHONPATH"))
    assert os.environ["GH_TOKEN"] == "test-only-value"
