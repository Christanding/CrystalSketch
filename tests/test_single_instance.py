from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, replace
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from crystalsketch.server import single_instance as single
from crystalsketch.server.app import create_app
from crystalsketch.server.update_worker import write_json


def info(root: Path, *, port: int = 8765) -> single.InstanceInfo:
    return single.InstanceInfo(
        pid=os.getpid(), tool_root=str(root), host="127.0.0.1", port=port,
        version="1.0.0", instance_id="a" * 32, secret="b" * 64,
    )


def wait_until(predicate, processes=(), timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        for process in processes:
            if process.poll() is not None:
                raise AssertionError(process.communicate(timeout=2))
        time.sleep(0.05)
    raise AssertionError("The isolated instance did not reach its expected state")


@contextmanager
def managed_process(cache: Path, root: Path):
    # Run the actual CLI and HTTP lifecycle, redirecting only installation discovery/cache.
    # Never contend with the developer's real managed installation.
    source = Path(single.__file__).resolve().parents[2]
    code = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv.pop(1))
from crystalsketch.server import updater
cache, root = Path(sys.argv.pop(1)), Path(sys.argv.pop(1))
updater.application_cache = lambda: cache
updater._runtime_tool_root = lambda: root
from crystalsketch.cli import app
app()
"""
    process = subprocess.Popen(
        [sys.executable, "-c", code, str(source), str(cache), str(root),
         "--no-open", "--port", "0"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", env=dict(os.environ, PYTHONIOENCODING="utf-8", NO_COLOR="1"),
    )
    try:
        yield process
    finally:
        if process.poll() is None:
            current = single.read_instance(cache)
            stop_process(process, current.pid if current else None)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        process.communicate(timeout=5)


def stop_process(process, service_pid=None):
    if os.name == "nt":
        # Terminate the test-owned venv redirector and its Python child together.
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       check=True, capture_output=True)
    else:
        process.kill()
    process.wait(timeout=5)
    if service_pid is not None:
        # Waiting for a venv redirector alone does not await its real Python child.
        wait_until(lambda: not single.process_alive(service_pid), timeout=5)


def test_concurrent_cli_launches_reuse_one_authenticated_service_and_recover_after_crash(tmp_path):
    cache, root = tmp_path / "cache", tmp_path / "tools" / "crystalsketch"
    with managed_process(cache, root) as first, managed_process(cache, root) as second:
        wait_until(lambda: first.poll() is not None or second.poll() is not None)
        owner, repeat = (first, second) if first.poll() is None else (second, first)
        output, _ = repeat.communicate(timeout=5)
        assert repeat.returncode == 0, output
        assert "already running" in output
        current = single.read_instance(cache)
        assert current is not None
        assert owner.poll() is None
        assert single.probe_instance(current) == current
        assert current.url in output
        # Kernel ownership, not the presence of a JSON file, prevents a second server.
        contender = single.InstanceLease(cache, root)
        try:
            assert not contender.try_acquire()
        finally:
            contender.close()
        stop_process(owner, current.pid)
        owner.wait(timeout=5)
        assert single.read_instance(cache) == current  # Crash left stale metadata.
    with managed_process(cache, root) as replacement:
        def replacement_ready():
            candidate = single.read_instance(cache)
            return (candidate and candidate.instance_id != current.instance_id
                    and single.probe_instance(candidate))

        restored = wait_until(replacement_ready, [replacement])
        assert restored.instance_id != current.instance_id
    recovered = single.claim_or_reuse(cache, root, timeout=0)
    assert isinstance(recovered, single.InstanceLease)
    recovered.close()


def test_releasing_ownership_preserves_lock_inode_and_removes_only_own_metadata(tmp_path):
    lease = single.claim_or_reuse(tmp_path, tmp_path, timeout=0)
    assert isinstance(lease, single.InstanceLease)
    try:
        assert lease.fd is not None and not os.get_inheritable(lease.fd)
        lease.publish(host="127.0.0.1", port=8765, version="1.0.0")
        inode = (tmp_path / "instance.lock").stat().st_ino
    finally:
        lease.close()
    assert not (tmp_path / "instance.json").exists()
    assert (tmp_path / "instance.lock").stat().st_ino == inode
    assert lease.try_acquire()
    try:
        lease.publish(host="127.0.0.1", port=8765, version="1.0.0")
        write_json(tmp_path / "instance.json", asdict(info(tmp_path)))
    finally:
        lease.close()
    assert single.read_instance(tmp_path) == info(tmp_path)


def test_only_matching_update_job_can_claim_during_worker_handoff(tmp_path, monkeypatch):
    root = tmp_path / "crystalsketch"
    job = "c" * 32
    write_json(tmp_path / "update.lock", {
        "pid": os.getpid(), "toolRoot": str(root), "jobId": job,
    })
    for incoming in ("", "d" * 32):
        monkeypatch.setenv("CRYSTALSKETCH_UPDATE_JOB", incoming)
        with pytest.raises(single.InstanceError, match="update-in-progress"):
            single.claim_or_reuse(tmp_path, root, timeout=0)
        # An ordinary launch must release its lock so the updater can restart.
        lease = single.InstanceLease(tmp_path, root)
        try:
            assert lease.try_acquire()
        finally:
            lease.close()
    monkeypatch.setenv("CRYSTALSKETCH_UPDATE_JOB", job)
    with pytest.raises(single.InstanceError, match="update-in-progress"):
        single.claim_or_reuse(tmp_path, root.parent / "other", timeout=0)
    replacement = single.claim_or_reuse(tmp_path, root, timeout=0)
    replacement.close()
    assert os.environ["CRYSTALSKETCH_UPDATE_JOB"] == job  # UpdateManager still needs it.


def test_corrupt_update_lock_fails_closed_without_blocking_future_recovery(tmp_path):
    (tmp_path / "update.lock").write_text("{", encoding="utf-8")
    with pytest.raises(single.InstanceError, match="invalid-instance-state"):
        single.claim_or_reuse(tmp_path, tmp_path, timeout=0)
    assert (tmp_path / "update.lock").read_text(encoding="utf-8") == "{"
    lease = single.InstanceLease(tmp_path, tmp_path)
    try:
        assert lease.try_acquire()
    finally:
        lease.close()


def test_legacy_running_service_blocks_new_owner_but_dead_markers_do_not(tmp_path):
    running = tmp_path / "running"
    running.mkdir()
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        write_json(running / f"{process.pid}.json", {
            "pid": process.pid, "toolRoot": str(tmp_path / "older-install"),
        })
        with pytest.raises(single.InstanceError, match="legacy-instance-running"):
            single.claim_or_reuse(tmp_path, tmp_path, timeout=0)
    finally:
        stop_process(process)
        process.wait(timeout=5)
    lease = single.claim_or_reuse(tmp_path, tmp_path, timeout=0)
    lease.close()


def test_identity_route_requires_local_authority_exact_port_and_private_token(tmp_path):
    identity = info(tmp_path)
    application = create_app(instance_info=identity, prewarm_structure_stack=False)
    with TestClient(application, base_url=identity.url) as client:
        assert client.get(single.IDENTITY_PATH).status_code == 403
        headers = {single.IDENTITY_HEADER: identity.secret}
        response = client.get(single.IDENTITY_PATH, headers=headers)
        assert response.status_code == 200
        assert response.json() == {
            "application": "CrystalSketch", "instanceId": identity.instance_id,
            "version": application.state.update_manager.version,
        }
        assert response.headers["Cache-Control"] == "no-store"
        for extra in (
            {single.IDENTITY_HEADER: "x" * 64}, {"Host": "localhost:9876"},
            {"Host": "attacker.invalid:8765"}, {"Origin": "https://attacker.invalid"},
            {"Sec-Fetch-Site": "cross-site"},
        ):
            assert client.get(single.IDENTITY_PATH, headers=headers | extra).status_code == 403


def test_explicit_local_interface_can_be_probed_but_remote_metadata_cannot(tmp_path, monkeypatch):
    bindings = []

    class BoundSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def bind(self, address):
            bindings.append(address)
            if address[0] != "192.168.1.42":
                raise OSError("Cannot assign requested address")

    monkeypatch.setattr(socket, "socket", lambda *args: BoundSocket())
    assert replace(info(tmp_path), host="192.168.1.42").probe_host == "192.168.1.42"
    assert replace(info(tmp_path), host="203.0.113.42").probe_host is None
    assert replace(info(tmp_path), host="attacker.invalid").probe_host is None
    assert bindings == [("192.168.1.42", 0), ("203.0.113.42", 0)]


@pytest.mark.parametrize("body,status", [
    ({"status": "ok"}, 200),
    ({"application": "CrystalSketch", "instanceId": "z" * 32, "version": "2.0.0"}, 200),
    ({"application": "CrystalSketch", "instanceId": "a" * 32, "version": "2.0.0"}, 302),
    ({"application": "CrystalSketch", "instanceId": "a" * 32, "version": "invalid"}, 200),
    ("x" * 4097, 200),
    ({"application": "CrystalSketch", "instanceId": "a" * 32, "version": "2.0.0"}, 200),
])
def test_probe_does_not_trust_generic_health_redirects_or_wrong_identity(tmp_path, body, status):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append((self.path, self.headers.get(single.IDENTITY_HEADER)))
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Location", "/must-not-follow")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        identity = info(tmp_path, port=server.server_port)
        try:
            result = single.probe_instance(identity)
            valid = status == 200 and isinstance(body, dict) and body.get("version") == "2.0.0"
            valid = valid and body.get("instanceId") == identity.instance_id
            assert result == (replace(identity, version="2.0.0") if valid else None)
            assert calls == [(single.IDENTITY_PATH, identity.secret)]
            assert single.probe_instance(replace(identity, host="attacker.invalid")) is None
            assert len(calls) == 1
        finally:
            server.shutdown()
            thread.join(timeout=2)


def test_reload_child_only_inherits_its_own_parent_descriptor(tmp_path):
    identity = replace(info(tmp_path), pid=os.getppid())
    write_json(tmp_path / "instance.json", asdict(identity))
    assert single.parent_instance(tmp_path, tmp_path) == identity
    assert single.parent_instance(tmp_path, tmp_path / "other") is None
    write_json(tmp_path / "instance.json", asdict(replace(identity, pid=os.getpid())))
    assert single.parent_instance(tmp_path, tmp_path) is None
    (tmp_path / "instance.json").write_text("corrupt", encoding="utf-8")
    assert single.read_instance(tmp_path) is None
