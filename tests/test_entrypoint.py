from __future__ import annotations

import subprocess
import sys
import sysconfig
from pathlib import Path

from crystalsketch.entrypoint import _unsupported_python_message, main


def test_supported_python_has_no_runtime_error() -> None:
    assert _unsupported_python_message((3, 12, 0)) is None
    assert _unsupported_python_message((3, 14, 1)) is None


def test_cloud_entrypoint_loads_without_an_editable_install(tmp_path: Path) -> None:
    entrypoint = Path(__file__).parents[1] / "app.py"
    dependencies = sysconfig.get_paths()["purelib"]
    script = f"""
import importlib.util
import sys
sys.path.insert(0, {dependencies!r})
spec = importlib.util.spec_from_file_location("cloud_entry", {str(entrypoint)!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from fastapi.testclient import TestClient
response = TestClient(module.app).options("/api/structure-preview", headers={{
    "Origin": "https://christanding.github.io",
    "Access-Control-Request-Method": "POST",
}})
assert response.status_code == 200, response.text
assert response.headers["access-control-allow-origin"] == "https://christanding.github.io"
"""
    result = subprocess.run(
        [sys.executable, "-I", "-S", "-c", script], cwd=tmp_path,
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stderr


def test_unsupported_python_error_names_required_and_running_versions() -> None:
    message = _unsupported_python_message((3, 8, 18))

    assert message is not None
    assert "Python 3.12 or newer" in message
    assert "Python 3.8.18" in message


def test_entrypoint_stops_before_loading_cli_on_unsupported_python(
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setattr("crystalsketch.entrypoint.sys.version_info", (3, 8, 18))

    assert main() == 1
    assert "CrystalSketch requires Python 3.12 or newer" in capsys.readouterr().err
