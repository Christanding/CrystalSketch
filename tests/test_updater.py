from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.request
import venv
import zipfile
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from crystalsketch.server import update_worker as worker
from crystalsketch.server import updater
from crystalsketch.server.app import create_app
from crystalsketch.server.single_instance import probe_instance, read_instance

TOKEN = "a" * 43
JOB = "b" * 32
PROBE = "c" * 64


def wheel_files(
    version: str, *, fail_start: bool = False, instance_cache: Path | None = None
) -> dict[str, bytes]:
    info = f"crystalsketch-{version}.dist-info"
    entrypoint = f"""
import argparse, json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from importlib.metadata import version
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host')
    parser.add_argument('--port', type=int)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    lease = None
    if {instance_cache is not None!r}:
        from crystalsketch.server.single_instance import claim_or_reuse
        lease = claim_or_reuse(Path({str(instance_cache)!r}), Path(sys.prefix))
        lease.publish(host=args.host, port=args.port, version=version('crystalsketch'))
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/api/instance' and lease and lease.info.accepts(
                self.headers.get('X-CrystalSketch-Instance-Token', '')
            ):
                body = json.dumps({{'application': 'CrystalSketch',
                    'instanceId': lease.info.instance_id,
                    'version': version('crystalsketch')}}).encode()
                self.send_response(200); self.end_headers(); self.wfile.write(body); return
            valid = self.headers.get('X-CrystalSketch-Update-Probe')
            expected = os.environ.get('CRYSTALSKETCH_UPDATE_PROBE')
            if self.path != '/api/updates/ready' or valid != expected:
                self.send_response(403); self.end_headers(); return
            body = json.dumps({{'version': version('crystalsketch')}}).encode()
            self.send_response(200); self.send_header('Content-Length', str(len(body)))
            self.end_headers(); self.wfile.write(body)
        def log_message(self, *args):
            pass
    try:
        if {fail_start!r}:
            return 1
        HTTPServer((args.host, args.port), Handler).serve_forever()
    finally:
        if lease:
            lease.close()
"""
    files = {
        "crystalsketch/__init__.py": f"__version__ = {version!r}\n".encode(),
        "crystalsketch/entrypoint.py": entrypoint.encode(),
        "crystalsketch/cli.py": b"# fixture\n",
        "crystalsketch/server/app.py": b"# fixture\n",
        "crystalsketch/web_static/index.html": b"<script src='/assets/main.js'></script>",
        "crystalsketch/web_static/assets/main.js": b"console.log('fixture');",
        f"{info}/METADATA": (
            f"Metadata-Version: 2.3\nName: crystalsketch\nVersion: {version}\n"
            "Requires-Python: >=3.12\n"
        ).encode(),
        f"{info}/WHEEL": b"Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        f"{info}/entry_points.txt": b"[console_scripts]\nCrystal = crystalsketch.entrypoint:main\n",
    }
    if instance_cache is not None:
        # Test the real ownership code inside the venv that the real worker restarts.
        directory = Path(worker.__file__).parent
        for name in ("single_instance.py", "update_worker.py"):
            files[f"crystalsketch/server/{name}"] = (directory / name).read_bytes()
    return files


def make_wheel(
    directory: Path, version: str = "2.0.0", *, edits=None, tamper=False, fail_start=False,
    instance_cache: Path | None = None,
) -> Path:
    files = wheel_files(version, fail_start=fail_start, instance_cache=instance_cache)
    files.update(edits or {})
    record_name = f"crystalsketch-{version}.dist-info/RECORD"
    rows = [
        f"{name},sha256={base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()},{len(data)}"
        for name, data in files.items()
    ]
    files[record_name] = ("\n".join(rows) + f"\n{record_name},,\n").encode()
    if tamper:
        files["crystalsketch/cli.py"] = b"tampered"
    path = directory / f"crystalsketch-{version}-py3-none-any.whl"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return path


def make_bundle(wheel: Path, extras=None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(f"CrystalSketch/{wheel.name}", wheel.read_bytes())
        for name, data in (extras or {}).items():
            bundle.writestr(name, data)
    return output.getvalue()


def installation_fixture(tmp_path: Path) -> updater.Installation:
    root, commands = tmp_path / "tools" / "crystalsketch", tmp_path / "commands"
    root.mkdir(parents=True)
    commands.mkdir()
    scripts = root / ("Scripts" if os.name == "nt" else "bin")
    scripts.mkdir()
    python = scripts / ("python.exe" if os.name == "nt" else "python")
    python.write_text("fixture")
    tool_entry = scripts / ("Crystal.exe" if os.name == "nt" else "Crystal")
    tool_entry.write_text("old entrypoint")
    entry = commands / tool_entry.name
    if os.name == "nt":
        shutil.copy2(tool_entry, entry)
    else:
        entry.symlink_to(tool_entry)
    uv = tmp_path / "uv"
    uv.write_text("fixture")
    (root / "uv-receipt.toml").write_text(
        '[tool]\nrequirements=[{name="crystalsketch"}]\n'
        f'entrypoints=[{{name="Crystal",install-path={json.dumps(str(entry))},from="crystalsketch"}}]\n'
    )
    return updater.Installation(
        root,
        root.parent,
        commands,
        entry,
        python,
        Path(sys._base_executable).resolve(),
        uv,
        (3, 12, 13),
    )


def manager_fixture(
    tmp_path: Path, monkeypatch
) -> tuple[updater.UpdateManager, updater.Installation]:
    install = installation_fixture(tmp_path)
    monkeypatch.setattr(updater, "current_version", lambda: "1.0.0")
    monkeypatch.setattr(
        updater, "latest_release", lambda: updater.Release("v2.0.0", "2.0.0", 100, None)
    )
    monkeypatch.setattr(updater, "detect_installation", lambda: install)
    manager = updater.UpdateManager(tmp_path / "cache")
    manager.bind_lifecycle("127.0.0.1", 8765, lambda: None)
    return manager, install


def test_semver_and_prereleases_are_ordered_without_offering_downgrades() -> None:
    assert worker.compare_versions("v1.10.0", "1.9.9") == 1
    assert worker.compare_versions("1.0.0", "1.0.0-rc.1") == 1
    assert worker.compare_versions("1.0.0-beta.2", "1.0.0-beta.11") == -1
    assert worker.compare_versions("1.0.0+build.1", "1.0.0+build.2") == 0
    assert worker.compare_versions("0.2.1", "0.3.0-beta") == -1
    for invalid in ["1.0", "01.0.0", "1.0.0-01", "1.0.0/../../x"]:
        with pytest.raises(worker.UpdateError):
            worker.version_parts(invalid)


def test_wheel_identity_record_and_python_requirement_are_verified(tmp_path) -> None:
    wheel = make_wheel(tmp_path)
    assert len(worker.validate_wheel(wheel, "2.0.0", (3, 12, 13))) == 64
    with pytest.raises(worker.UpdateError, match="package-version-mismatch"):
        worker.validate_wheel(wheel, "2.0.0", (3, 11, 9))
    make_wheel(tmp_path, tamper=True)
    with pytest.raises(worker.UpdateError, match="package-integrity-failed"):
        worker.validate_wheel(wheel, "2.0.0", (3, 12, 13))
    make_wheel(
        tmp_path,
        edits={
            "crystalsketch-2.0.0.dist-info/entry_points.txt": (
                b"[console_scripts]\nCrystal = crystalsketch.entrypoint:main\nOther = evil:main\n"
            )
        },
    )
    with pytest.raises(worker.UpdateError, match="invalid-package"):
        worker.validate_wheel(wheel, "2.0.0", (3, 12, 13))


@pytest.mark.parametrize(
    "name",
    [
        "../outside",
        "/absolute",
        "C:/evil",
        "CrystalSketch/../bad",
        "CrystalSketch\\bad",
        "CrystalSketch/CON.txt",
    ],
)
def test_package_paths_cannot_escape_on_either_platform(tmp_path, name) -> None:
    with zipfile.ZipFile(tmp_path / "bad.zip", "w") as archive:
        archive.writestr(name, "bad")
    with zipfile.ZipFile(tmp_path / "bad.zip") as archive:
        with pytest.raises(worker.UpdateError, match="invalid-package"):
            worker.safe_archive_entries(archive)


def test_package_rejects_symlinks_and_oversized_contents(tmp_path) -> None:
    info = zipfile.ZipInfo("crystalsketch/link")
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(tmp_path / "bad.zip", "w") as archive:
        archive.writestr(info, "../../user-data")
    with zipfile.ZipFile(tmp_path / "bad.zip") as archive:
        with pytest.raises(worker.UpdateError, match="invalid-package"):
            worker.safe_archive_entries(archive)
    with zipfile.ZipFile(tmp_path / "large.zip", "w") as archive:
        archive.writestr("large", b"12345")
    with zipfile.ZipFile(tmp_path / "large.zip") as archive:
        with pytest.raises(worker.UpdateError, match="package-too-large"):
            worker.safe_archive_entries(archive, max_bytes=4)


def test_download_uses_fixed_official_url_and_validates_before_handoff(
    tmp_path, monkeypatch
) -> None:
    wheel = make_wheel(tmp_path)
    payload = make_bundle(wheel)
    target = tmp_path / "job"
    target.mkdir()
    urls = []
    monkeypatch.setattr(
        updater, "_official_open", lambda url, timeout: urls.append(url) or io.BytesIO(payload)
    )
    release = updater.Release("v2.0.0", "2.0.0", len(payload), hashlib.sha256(payload).hexdigest())
    result, digest = updater.prepare_release(target, release, (3, 12, 13))
    assert result.name == wheel.name and len(digest) == 64
    assert urls == [
        "https://github.com/Christanding/CrystalSketch/releases/download/v2.0.0/CrystalSketch.zip"
    ]
    other = tmp_path / "rejected"
    other.mkdir()
    with pytest.raises(worker.UpdateError, match="package-integrity-failed"):
        updater.prepare_release(
            other, updater.Release("v2.0.0", "2.0.0", len(payload), "0" * 64), (3, 12, 13)
        )
    for url in [
        "http://github.com/file",
        "https://evil.example/file",
        "https://github.com.evil.example/file",
        "https://user:password@github.com/file",
        "https://github.com:8443/file",
    ]:
        with pytest.raises(worker.UpdateError, match="invalid-download-source"):
            updater._validate_download_url(url)


def test_source_installation_can_check_but_cannot_get_an_update_intent(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(updater, "current_version", lambda: "1.0.0")
    monkeypatch.setattr(
        updater, "latest_release", lambda: updater.Release("v2.0.0", "2.0.0", 100, None)
    )
    monkeypatch.setattr(updater, "_runtime_tool_root", lambda: None)
    manager = updater.UpdateManager(tmp_path / "cache")
    result = manager.check()
    assert result["status"] == "available"
    assert result["supported"] is False and result["reason"] == "source-installation"
    assert "intentToken" not in result and not manager.cache.exists()
    with pytest.raises(worker.UpdateError, match="expired"):
        manager.start(TOKEN)


def test_uv_detection_requires_receipt_paths_and_an_independent_base_python(
    tmp_path, monkeypatch
) -> None:
    install = installation_fixture(tmp_path)
    monkeypatch.setattr(updater, "_runtime_tool_root", lambda: install.tool_root)
    monkeypatch.setattr(updater, "current_version", lambda: "1.0.0")
    monkeypatch.setattr(updater.sys, "executable", str(install.tool_python))
    monkeypatch.setattr(updater.shutil, "which", lambda name: str(install.uv))

    def query(command, environment):
        assert environment["UV_TOOL_DIR"] == str(install.tool_dir)
        assert environment["UV_TOOL_BIN_DIR"] == str(install.bin_dir)
        if command[-1] == "dir":
            return str(install.tool_dir)
        if command[-1] == "--bin":
            return str(install.bin_dir)
        if command[-1] == "--show-paths":
            return f"crystalsketch v1.0.0 ({install.tool_root})"
        return json.dumps({"version": [3, 12, 13], "prefix": str(install.base_python.parent)})

    monkeypatch.setattr(updater, "_query", query)
    assert updater.detect_installation() == install
    monkeypatch.setattr(updater.sys, "_base_executable", str(install.tool_python))
    with pytest.raises(worker.UpdateError, match="unsupported-installation"):
        updater.detect_installation()


def test_local_origin_intent_boolean_and_single_job_are_enforced(tmp_path, monkeypatch) -> None:
    manager, _ = manager_fixture(tmp_path, monkeypatch)
    launched = []

    class FakeThread:
        def __init__(self, **kwargs):
            launched.append(kwargs)

        def start(self):
            pass

    monkeypatch.setattr(
        updater, "threading", SimpleNamespace(Thread=FakeThread, Lock=threading.Lock)
    )
    app = create_app(prewarm_structure_stack=False)
    app.state.update_manager = manager
    client = TestClient(app, base_url="http://127.0.0.1:8765")
    checked = client.get("/api/updates/check").json()
    headers = {
        "Origin": "http://127.0.0.1:8765",
        "X-CrystalSketch-Update-Token": checked["intentToken"],
    }
    assert (
        client.post(
            "/api/updates/apply",
            json={"confirm": True},
            headers={**headers, "Origin": "https://evil.example"},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/updates/apply",
            json={"confirm": True},
            headers={"X-CrystalSketch-Update-Token": checked["intentToken"]},
        ).status_code
        == 403
    )
    for body in [
        {"confirm": 1},
        {"confirm": False},
        {"confirm": True, "command": "anything"},
        {"confirm": True, "url": "https://evil.example/pkg.zip"},
    ]:
        assert client.post("/api/updates/apply", json=body, headers=headers).status_code == 400
    assert not launched
    response = client.post("/api/updates/apply", json={"confirm": True}, headers=headers)
    assert response.status_code == 202 and response.headers["x-frame-options"] == "DENY"
    assert len(launched) == 1
    assert (
        client.post("/api/updates/apply", json={"confirm": True}, headers=headers).status_code
        == 403
    )
    assert client.get("/api/updates/check", headers={"Host": "evil.example"}).status_code == 403
    assert (
        client.get("/api/updates/check", headers={"Sec-Fetch-Site": "cross-site"}).status_code
        == 403
    )


def test_failed_job_initialization_releases_claimed_lock(tmp_path, monkeypatch) -> None:
    manager, _ = manager_fixture(tmp_path, monkeypatch)
    token = manager.check()["intentToken"]
    original = updater.write_status
    monkeypatch.setattr(
        updater, "write_status", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("disk full"))
    )
    with pytest.raises(OSError):
        manager.start(token)
    assert not (manager.cache / "update.lock").exists()
    monkeypatch.setattr(updater, "write_status", original)
    assert "intentToken" in manager.check()


def test_lan_and_unmanaged_servers_still_register_environment_occupancy(
    tmp_path, monkeypatch
) -> None:
    manager, install = manager_fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(updater, "_runtime_tool_root", lambda: install.tool_root)
    manager.bind_lifecycle("0.0.0.0", 8766, lambda: None)
    marker = manager.cache / "running" / f"{os.getpid()}.json"
    assert worker.read_json(marker)["toolRoot"] == str(install.tool_root)
    assert manager.check()["reason"] == "not-local"
    manager.service_exited()
    assert not marker.exists()


def test_http_log_never_returns_raw_subprocess_paths_or_authorization(
    tmp_path, monkeypatch
) -> None:
    manager, _ = manager_fixture(tmp_path, monkeypatch)
    job = manager.cache / JOB
    job.mkdir(parents=True)
    worker.write_json(job / "job.json", {"version": "2.0.0", "oldVersion": "1.0.0"})
    worker.write_status(job, "failed", code="install-failed", restored=True)
    (job / "update.log").write_text(
        "Authorization: Bearer DEMO_SECRET\n/private/var/folders/private/build.py"
    )
    summary = manager.log(JOB)
    assert "install-failed" in summary and "2.0.0" in summary
    assert "DEMO_SECRET" not in summary and "/private/var" not in summary


def test_failed_preparation_never_requests_shutdown_or_starts_worker(tmp_path, monkeypatch) -> None:
    manager, installation = manager_fixture(tmp_path, monkeypatch)
    shutdowns = []
    manager.bind_lifecycle("127.0.0.1", 8765, lambda: shutdowns.append(True))
    job = manager.cache / JOB
    job.mkdir(parents=True)
    worker.write_json(manager.cache / "update.lock", {"pid": os.getpid(), "jobId": JOB})
    monkeypatch.setattr(
        updater,
        "prepare_release",
        lambda *args: (_ for _ in ()).throw(worker.UpdateError("package-integrity-failed")),
    )
    monkeypatch.setattr(
        updater.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("must not launch")
    )
    manager._prepare(job, updater.Release("v2.0.0", "2.0.0", 100, None), installation)
    assert not shutdowns and not (job / "go").exists()
    assert worker.read_json(job / "status.json")["code"] == "package-integrity-failed"
    assert not (manager.cache / "update.lock").exists()


def test_handoff_uses_independent_python_and_waits_for_worker_readiness(
    tmp_path, monkeypatch
) -> None:
    manager, installation = manager_fixture(tmp_path, monkeypatch)
    job = manager.cache / JOB
    job.mkdir(parents=True)
    wheel = make_wheel(job)
    checksum = worker.validate_wheel(wheel, "2.0.0", installation.python_version)
    monkeypatch.setattr(updater, "prepare_release", lambda *args: (wheel, checksum))
    events = []

    def launch(command, **kwargs):
        assert command[:3] == [str(installation.base_python), "-I", "-S"]
        assert not Path(command[3]).is_relative_to(installation.tool_root)
        assert Path(command[3]).read_bytes() == Path(worker.__file__).read_bytes()
        assert kwargs["cwd"] == job
        events.append("launch")
        worker.write_json(job / "ready.json", {"pid": 9000001})
        return SimpleNamespace(pid=9000001, poll=lambda: None)

    monkeypatch.setattr(updater.subprocess, "Popen", launch)

    def shutdown():
        assert (job / "go").is_file()
        assert worker.read_json(job / "ready.json")["pid"] == 9000001
        events.append("shutdown")

    manager.bind_lifecycle("127.0.0.1", 8765, shutdown)
    manager._prepare(job, updater.Release("v2.0.0", "2.0.0", 100, None), installation)
    assert events == ["launch", "shutdown"]
    assert worker.read_json(job / "plan.json")["wheel_sha256"] == checksum


def test_managed_windows_ancestor_chain_includes_redirector_and_excludes_shell(tmp_path) -> None:
    installation = installation_fixture(tmp_path)
    parent, launcher, shell = os.getpid() + 100000, os.getpid() + 100001, os.getpid() + 100002
    images = {
        parent: installation.tool_python,
        launcher: installation.entrypoint.resolve(),
        shell: tmp_path / "powershell.exe",
    }
    result = updater._managed_ancestors(
        parent, {parent: launcher, launcher: shell}, images.__getitem__, installation
    )
    assert result == [parent, launcher]


def test_reload_cli_registers_occupancy_even_without_update_lifecycle(monkeypatch) -> None:
    import uvicorn

    from crystalsketch import cli

    calls = []

    class Occupancy:
        def register_runtime(self):
            calls.append("register")

        def service_exited(self):
            calls.append("exit")

    monkeypatch.setattr(updater, "UpdateManager", Occupancy)
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append("run"))
    cli._load_uvicorn_run()("crystalsketch.server.app:create_app", factory=True, reload=True)
    assert calls == ["register", "run", "exit"]


def plan_fixture(tmp_path: Path) -> tuple[Path, worker.UpdatePlan]:
    install = installation_fixture(tmp_path)
    job = tmp_path / "updates" / JOB
    job.mkdir(parents=True)
    wheel = make_wheel(job)
    plan = worker.UpdatePlan(
        **{key: str(value) for key, value in asdict(install).items() if key != "python_version"},
        wheel=str(wheel),
        wheel_sha256=hashlib.sha256(wheel.read_bytes()).hexdigest(),
        old_version="1.0.0",
        version="2.0.0",
        host="127.0.0.1",
        port=8765,
        old_pids=[123456],
        probe_token=PROBE,
    )
    worker.write_json(job / "plan.json", asdict(plan))
    (job / "go").write_text(JOB)
    return job, plan


def test_restore_is_not_blocked_by_log_or_status_io_failures(tmp_path, monkeypatch) -> None:
    job, _ = plan_fixture(tmp_path)
    calls = []
    monkeypatch.setattr(worker, "process_alive", lambda pid: False)
    monkeypatch.setattr(worker, "backup_installation", lambda *args: calls.append("backup"))
    monkeypatch.setattr(
        worker,
        "_run_install",
        lambda *args: (_ for _ in ()).throw(worker.UpdateError("install-failed")),
    )
    monkeypatch.setattr(
        worker, "append_log", lambda *args: (_ for _ in ()).throw(OSError("disk full"))
    )
    original_status = worker.write_status

    def status(job, phase, **kwargs):
        if phase in {"restore", "failed"}:
            raise OSError("disk full")
        original_status(job, phase, **kwargs)

    monkeypatch.setattr(worker, "write_status", status)
    monkeypatch.setattr(worker, "restore_installation", lambda *args: calls.append("restore"))
    monkeypatch.setattr(worker, "restart_service", lambda *args: calls.append("restart"))
    assert worker.run_update(job) == 1
    assert calls == ["backup", "restore", "restart"]


def test_slow_old_exit_abandons_install_but_restarts_old_version_when_released(
    tmp_path, monkeypatch
) -> None:
    job, _ = plan_fixture(tmp_path)
    alive = iter([True, True, False])
    clock = iter([0, 0, 100])
    monkeypatch.setattr(
        worker,
        "time",
        SimpleNamespace(
            monotonic=lambda: next(clock),
            sleep=lambda _: None,
            time=time.time,
            strftime=time.strftime,
        ),
    )
    monkeypatch.setattr(worker, "process_alive", lambda _: next(alive))
    monkeypatch.setattr(
        worker, "_run_install", lambda *args: pytest.fail("must not install after deadline")
    )
    restarted = []
    monkeypatch.setattr(
        worker, "restart_service", lambda job, plan, version: restarted.append(version)
    )
    assert worker.run_update(job) == 1
    assert restarted == ["1.0.0"]
    assert worker.read_json(job / "status.json")["restored"] is True


@pytest.mark.skipif(
    os.name == "nt", reason="The fake uv executable in this test is a POSIX fixture."
)
@pytest.mark.parametrize("outcome", ["success", "install-fails", "new-start-fails"])
def test_update_flow_with_temporary_venv_fake_uv_and_real_short_lived_cli(
    tmp_path, monkeypatch, outcome
) -> None:
    root, commands = tmp_path / "tools" / "crystalsketch", tmp_path / "commands"
    job = tmp_path / "updates" / JOB
    job.mkdir(parents=True)
    root.parent.mkdir()
    commands.mkdir()
    (root.parent / "unrelated-tool").mkdir()
    (root.parent / "unrelated-tool" / "keep").write_text("unrelated installation")
    (tmp_path / "user-structure.cif").write_text("user data must survive")
    venv.EnvBuilder(with_pip=False, symlinks=True).create(root)
    tool_python = root / "bin" / "python"
    site = Path(
        subprocess.check_output(
            [
                str(tool_python),
                "-I",
                "-c",
                "import sysconfig; print(sysconfig.get_paths()['purelib'])",
            ],
            text=True,
        ).strip()
    )
    assert site.is_relative_to(tmp_path)
    for name, data in wheel_files("1.0.0", instance_cache=job.parent).items():
        path = site / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    (root / "sentinel").write_text("original environment")
    (root / "uv-receipt.toml").write_text('[tool]\nrequirements=[{name="crystalsketch"}]\n')
    (root / "bin" / "Crystal").write_text("original entrypoint")
    entry = commands / "Crystal"
    entry.symlink_to(root / "bin" / "Crystal")
    wheel = make_wheel(job, fail_start=outcome == "new-start-fails", instance_cache=job.parent)
    fake_uv = tmp_path / "uv"
    implementation = tmp_path / "fake_uv.py"
    implementation.write_text(f"""
import json, os, shutil, sys, zipfile
from pathlib import Path
root = Path(os.environ['UV_TOOL_DIR']) / 'crystalsketch'
assert root == Path({str(root)!r})
assert os.environ['UV_TOOL_BIN_DIR'] == {str(commands)!r}
Path({str(job / "invocation.json")!r}).write_text(json.dumps(sys.argv[1:]))
if {outcome!r} == 'install-fails':
    shutil.rmtree(root)
    Path({str(entry)!r}).unlink()
    print('Authorization: Bearer DEMO_SECRET', file=sys.stderr)
    raise SystemExit(1)
site = Path({str(site)!r})
shutil.rmtree(site / 'crystalsketch-1.0.0.dist-info')
with zipfile.ZipFile(sys.argv[-1]) as archive:
    for name in archive.namelist():
        target = (site / name).resolve()
        assert target.is_relative_to(site)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.read(name))
(root / 'bin' / 'Crystal').write_text('updated entrypoint')
""")
    fake_uv.write_text(
        f"#!/bin/sh\nexec {shlex.quote(sys._base_executable)} "
        f'{shlex.quote(str(implementation))} "$@"\n'
    )
    fake_uv.chmod(0o700)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    old = subprocess.Popen(
        [str(tool_python), "-I", "-c", "from crystalsketch.entrypoint import main; main()",
         "--host", "127.0.0.1", "--port", str(port), "--no-open"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    plan = worker.UpdatePlan(
        str(root),
        str(root.parent),
        str(commands),
        str(entry),
        str(tool_python),
        str(Path(sys._base_executable).resolve()),
        str(fake_uv),
        str(wheel),
        hashlib.sha256(wheel.read_bytes()).hexdigest(),
        "1.0.0",
        "2.0.0",
        "127.0.0.1",
        port,
        [old.pid],
        PROBE,
    )
    worker.write_json(job / "plan.json", asdict(plan))
    worker.write_json(job / "job.json", {"version": "2.0.0", "oldVersion": "1.0.0"})
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        old_info = read_instance(job.parent)
        if old_info and probe_instance(old_info):
            break
        assert old.poll() is None
        time.sleep(0.01)
    else:
        old.terminate()
        old.wait(timeout=5)
        pytest.fail("Old fixture did not acquire its instance lease")
    worker.write_json(job.parent / "update.lock", {
        "pid": os.getpid(), "jobId": JOB, "toolRoot": str(root),
    })
    started = []
    original_restart = worker.restart_service

    def restart(*args):
        process = original_restart(*args)
        started.append(process)
        return process

    monkeypatch.setattr(worker, "restart_service", restart)
    result = []
    thread = threading.Thread(target=lambda: result.append(worker.run_update(job)))
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not (job / "ready.json").exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert (job / "ready.json").exists()
        (job / "go").write_text(JOB)
        time.sleep(0.05)
        assert not (job / "invocation.json").exists(), "must not replace a running tool environment"
        old.terminate()
        old.wait(timeout=5)
        thread.join(timeout=20)
        assert not thread.is_alive()
        status = worker.read_json(job / "status.json")
        assert result == ([0] if outcome == "success" else [1])
        assert status["phase"] == ("complete" if outcome == "success" else "failed")
        assert status["restored"] is (outcome != "success")
        current = read_instance(job.parent)
        assert current and current.instance_id != old_info.instance_id
        assert probe_instance(current) == current
        assert current.version == ("2.0.0" if outcome == "success" else "1.0.0")
        assert (job / "backup" / "tool" / "sentinel").read_text() == "original environment"
        assert entry.read_text() == (
            "updated entrypoint" if outcome == "success" else "original entrypoint"
        )
        assert (root.parent / "unrelated-tool" / "keep").read_text() == "unrelated installation"
        assert (tmp_path / "user-structure.cif").read_text() == "user data must survive"
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/updates/ready",
            headers={"X-CrystalSketch-Update-Probe": PROBE},
        )
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
            request, timeout=2
        ) as response:
            assert json.load(response)["version"] == ("2.0.0" if outcome == "success" else "1.0.0")
        command = json.loads((job / "invocation.json").read_text())
        assert command[:5] == ["--no-config", "--color", "never", "tool", "install"]
        assert "--reinstall-package" in command and command[-1] == str(wheel)
        assert not (job.parent / "update.lock").exists()
    finally:
        if old.poll() is None:
            old.terminate()
            old.wait(timeout=5)
        thread.join(timeout=5)
        for process in started:
            worker.stop_started_process(process)


def test_copied_worker_imports_with_only_base_python_stdlib(tmp_path) -> None:
    copied = tmp_path / "worker.py"
    shutil.copy2(Path(worker.__file__), copied)
    result = subprocess.run(
        [sys._base_executable, "-I", "-S", str(copied), "--help"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0 and "--job-dir" in result.stdout
