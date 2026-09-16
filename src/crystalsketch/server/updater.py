"""Explicit, local-only update coordination. No startup network requests or installers."""

from __future__ import annotations

import hashlib
import hmac
import importlib.metadata
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

import crystalsketch
from crystalsketch.server import update_worker
from crystalsketch.server.update_worker import (
    JOB_PATTERN,
    LOOPBACK_HOSTS,
    MAX_WHEEL_BYTES,
    TERMINAL_PHASES,
    UPDATE_ERROR_CODES,
    UPDATE_PHASES,
    UpdateError,
    UpdatePlan,
    append_log,
    best_effort,
    compare_versions,
    other_running_instances,
    process_alive,
    read_json,
    safe_archive_entries,
    validate_wheel,
    version_parts,
    write_json,
    write_status,
)

LATEST_RELEASE_API = "https://api.github.com/repos/Christanding/CrystalSketch/releases/latest"
RELEASE_BASE = "https://github.com/Christanding/CrystalSketch/releases/download/"
DOWNLOAD_HOSTS = {
    "github.com",
    "api.github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
}


@dataclass(frozen=True)
class Release:
    tag: str
    version: str
    size: int
    sha256: str | None


@dataclass(frozen=True)
class Installation:
    tool_root: Path
    tool_dir: Path
    bin_dir: Path
    entrypoint: Path
    tool_python: Path
    base_python: Path
    uv: Path
    python_version: tuple[int, int, int]


@dataclass(frozen=True)
class Lifecycle:
    host: str
    port: int
    shutdown: Callable[[], None]


def current_version() -> str:
    try:
        return importlib.metadata.version("crystalsketch")
    except importlib.metadata.PackageNotFoundError:
        return crystalsketch.__version__


def application_cache() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache")))
    return (base / "CrystalSketch" / "updates").resolve()


def _runtime_tool_root() -> Path | None:
    prefix = Path(sys.prefix).resolve()
    module = Path(crystalsketch.__file__).resolve()
    if (
        prefix.name.casefold() != "crystalsketch"
        or not module.is_relative_to(prefix)
        or not (prefix / "uv-receipt.toml").is_file()
    ):
        return None
    return prefix


def _query(command: list[str], environment: dict[str, str]) -> str:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=3,
            check=False,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise UpdateError("unsupported-installation") from exc
    if result.returncode or len(result.stdout) > 64 * 1024:
        raise UpdateError("unsupported-installation")
    return result.stdout.strip()


def detect_installation() -> Installation:
    root = _runtime_tool_root()
    if root is None:
        raise UpdateError("source-installation")
    try:
        with (root / "uv-receipt.toml").open("rb") as source:
            receipt = tomllib.load(source)["tool"]
        requirements, entrypoints = receipt["requirements"], receipt["entrypoints"]
        if (
            len(requirements) != 1
            or requirements[0].get("name") != "crystalsketch"
            or requirements[0].get("editable")
            or len(entrypoints) != 1
            or entrypoints[0].get("name") not in {"Crystal", "Crystal.exe"}
            or entrypoints[0].get("from") not in {None, "crystalsketch"}
        ):
            raise UpdateError("unsupported-installation")
        entry = Path(entrypoints[0]["install-path"])
        python = Path(sys.executable).absolute()
        base = Path(getattr(sys, "_base_executable", "")).resolve()
        uv_name = shutil.which("uv")
        if not uv_name:
            raise UpdateError("unsupported-installation")
        uv = Path(uv_name).resolve()
        if (
            not entry.is_absolute()
            or entry.name not in {"Crystal", "Crystal.exe"}
            or not entry.is_file()
            or entry.parent.resolve().is_relative_to(root)
            or not python.is_relative_to(root)
            or not python.is_file()
            or base.is_relative_to(root)
            or uv.is_relative_to(root)
            or not base.is_file()
            or not uv.is_file()
        ):
            raise UpdateError("unsupported-installation")
        if os.name != "nt" and not entry.resolve().is_relative_to(root):
            raise UpdateError("unsupported-installation")
        directory, commands = root.parent, entry.parent.resolve()
        entry = commands / entry.name
        environment = os.environ.copy()
        environment.update({"UV_TOOL_DIR": str(directory), "UV_TOOL_BIN_DIR": str(commands)})
        query = [str(uv), "--no-config", "--color", "never", "tool"]
        if Path(_query([*query, "dir"], environment)).resolve() != directory:
            raise UpdateError("unsupported-installation")
        if Path(_query([*query, "dir", "--bin"], environment)).resolve() != commands:
            raise UpdateError("unsupported-installation")
        listing = _query([*query, "list", "--show-paths"], environment)
        expected = f"crystalsketch v{current_version()} ({root})"
        if expected.casefold() not in listing.casefold().splitlines():
            raise UpdateError("unsupported-installation")
        probe = _query(
            [
                str(base),
                "-I",
                "-S",
                "-c",
                "import json,sys; "
                "print(json.dumps({'version': list(sys.version_info[:3]), 'prefix': sys.prefix}))",
            ],
            environment,
        )
        base_info = json.loads(probe)
        python_version = tuple(base_info["version"])
        if (
            len(python_version) != 3
            or any(type(item) is not int for item in python_version)
            or python_version < (3, 12, 0)
            or Path(base_info["prefix"]).resolve().is_relative_to(root)
        ):
            raise UpdateError("unsupported-installation")
        return Installation(root, directory, commands, entry, python, base, uv, python_version)
    except (KeyError, TypeError, ValueError, OSError) as exc:
        raise UpdateError("unsupported-installation") from exc


class OfficialRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        _validate_download_url(new_url)
        return super().redirect_request(request, fp, code, message, headers, new_url)


def _validate_download_url(url: str) -> None:
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in DOWNLOAD_HOSTS
        or parsed.port not in {None, 443}
        or parsed.username
        or parsed.password
    ):
        raise UpdateError("invalid-download-source")


def _official_open(url: str, timeout: float):
    _validate_download_url(url)
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "CrystalSketch-Updater",
            "X-GitHub-Api-Version": "2026-03-10",
        },
    )
    return urllib.request.build_opener(OfficialRedirectHandler()).open(request, timeout=timeout)


def latest_release() -> Release:
    try:
        with _official_open(LATEST_RELEASE_API, 10) as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise UpdateError("invalid-release")
        data = json.loads(raw)
        if (
            not isinstance(data, dict)
            or data.get("draft") is not False
            or data.get("prerelease") is not False
            or not isinstance(data.get("tag_name"), str)
        ):
            raise UpdateError("invalid-release")
        tag = data["tag_name"].strip()
        _, prerelease = version_parts(tag)
        if prerelease:
            raise UpdateError("invalid-release")
        version = re.sub(r"^[vV]", "", tag)
        assets = [
            asset
            for asset in data.get("assets", [])
            if isinstance(asset, dict) and asset.get("name") == "CrystalSketch.zip"
        ]
        if len(assets) != 1:
            raise UpdateError("invalid-release")
        asset = assets[0]
        size, digest = asset.get("size"), asset.get("digest")
        if type(size) is not int or not 0 < size <= MAX_WHEEL_BYTES:
            raise UpdateError("invalid-release")
        if digest is not None and (
            not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest)
        ):
            raise UpdateError("invalid-release")
        return Release(tag, version, size, digest.removeprefix("sha256:") if digest else None)
    except urllib.error.HTTPError as exc:
        message = exc.read(4096).decode("utf-8", errors="replace")
        if exc.code == 429 or (
            exc.code == 403
            and (
                exc.headers.get("x-ratelimit-remaining") == "0"
                or exc.headers.get("retry-after")
                or "rate limit" in message.lower()
            )
        ):
            raise UpdateError("rate-limited") from exc
        raise UpdateError("check-failed") from exc
    except (OSError, urllib.error.URLError) as exc:
        raise UpdateError("check-failed") from exc
    except (TypeError, ValueError) as exc:
        raise UpdateError("invalid-release") from exc


def prepare_release(
    job: Path, release: Release, python_version: tuple[int, int, int]
) -> tuple[Path, str]:
    bundle = job / "release.zip"
    url = f"{RELEASE_BASE}{urllib.parse.quote(release.tag, safe='')}/CrystalSketch.zip"
    deadline = time.monotonic() + 180
    digest = hashlib.sha256()
    length = 0
    try:
        with _official_open(url, 15) as response, bundle.open("xb") as target:
            while chunk := response.read(256 * 1024):
                length += len(chunk)
                if length > release.size or length > MAX_WHEEL_BYTES:
                    raise UpdateError("package-too-large")
                if time.monotonic() > deadline:
                    raise UpdateError("download-timeout")
                digest.update(chunk)
                target.write(chunk)
        if length != release.size or (
            release.sha256 and not hmac.compare_digest(digest.hexdigest(), release.sha256)
        ):
            raise UpdateError("package-integrity-failed")
        write_status(job, "validate")
        filename = f"crystalsketch-{release.version}-py3-none-any.whl"
        wheel = job / filename
        with zipfile.ZipFile(bundle) as archive:
            entries = safe_archive_entries(archive, max_files=100, max_bytes=MAX_WHEEL_BYTES)
            wheels = [name for name in entries if name.lower().endswith(".whl")]
            if wheels != [f"CrystalSketch/{filename}"]:
                raise UpdateError("invalid-package")
            with archive.open(wheels[0]) as source, wheel.open("xb") as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
        return wheel, validate_wheel(wheel, release.version, python_version)
    finally:
        bundle.unlink(missing_ok=True)


def _managed_ancestors(
    parent: int,
    parents: dict[int, int],
    image_for_pid: Callable[[int], Path],
    installation: Installation,
) -> list[int]:
    result: list[int] = []
    seen = {os.getpid()}
    for _ in range(8):
        if not parent or parent in seen:
            break
        seen.add(parent)
        image = image_for_pid(parent)
        if image != installation.entrypoint.resolve() and not image.is_relative_to(
            installation.tool_root
        ):
            break
        result.append(parent)
        parent = parents.get(parent, 0)
    return result


def _windows_launcher_pids(installation: Installation) -> list[int]:
    if os.name != "nt":
        return []
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    class ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    snapshot = kernel.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS.
    if snapshot == ctypes.c_void_p(-1).value:
        raise UpdateError("unsupported-installation")
    parents: dict[int, int] = {}
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        available = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while available:
            parents[entry.th32ProcessID] = entry.th32ParentProcessID
            available = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)

    def image_for_pid(pid: int) -> Path:
        handle = kernel.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION.
        if not handle:
            raise UpdateError("unsupported-installation")
        try:
            buffer = ctypes.create_unicode_buffer(32768)
            size = wintypes.DWORD(len(buffer))
            if not kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                raise UpdateError("unsupported-installation")
            return Path(buffer.value).resolve()
        finally:
            kernel.CloseHandle(handle)

    # Include venv redirectors between the service Python and Crystal.exe, but never its shell.
    return _managed_ancestors(os.getppid(), parents, image_for_pid, installation)


class UpdateManager:
    def __init__(self, cache: Path | None = None) -> None:
        self.cache = cache if cache is not None else application_cache()
        self.version = current_version()
        self.lifecycle: Lifecycle | None = None
        self._mutex = threading.Lock()
        self._intent: tuple[str, float, Release, Installation] | None = None
        self._startup_job = os.environ.pop("CRYSTALSKETCH_UPDATE_JOB", None)
        self._probe = os.environ.pop("CRYSTALSKETCH_UPDATE_PROBE", None)
        self._marker: Path | None = None

    def bind_lifecycle(self, host: str, port: int, shutdown: Callable[[], None]) -> None:
        self.lifecycle = Lifecycle(host, port, shutdown)
        self.register_runtime()

    def register_runtime(self) -> None:
        root = _runtime_tool_root()
        if root is None:
            return
        self._ensure_cache()
        lock = self._read_lock()
        if (
            lock
            and lock.get("toolRoot") == str(root)
            and process_alive(lock.get("pid"))
            and lock.get("jobId") != self._startup_job
        ):
            raise UpdateError("busy")
        running = self.cache / "running"
        running.mkdir(mode=0o700, exist_ok=True)
        self._marker = running / f"{os.getpid()}.json"
        write_json(self._marker, {"pid": os.getpid(), "toolRoot": str(root)})

    def service_exited(self) -> None:
        if self._marker:
            self._marker.unlink(missing_ok=True)

    def _ensure_cache(self) -> None:
        self.cache.mkdir(parents=True, mode=0o700, exist_ok=True)
        if self.cache.is_symlink():
            raise UpdateError("invalid-update-state")
        if os.name != "nt":
            if self.cache.stat().st_uid != os.getuid():
                raise UpdateError("invalid-update-state")
            self.cache.chmod(0o700)

    def _read_lock(self) -> dict[str, object] | None:
        try:
            return read_json(self.cache / "update.lock", 4096)
        except FileNotFoundError:
            return None

    def check(self) -> dict[str, object]:
        release = latest_release()
        available = compare_versions(release.version, self.version) > 0
        supported, reason, installation = True, None, None
        try:
            installation = detect_installation()
            if self.lifecycle is None:
                raise UpdateError("unmanaged-server")
            if self.lifecycle.host not in LOOPBACK_HOSTS:
                raise UpdateError("not-local")
            if other_running_instances(self.cache, str(installation.tool_root), [os.getpid()]):
                raise UpdateError("other-instance-running")
        except UpdateError as exc:
            supported, reason = False, exc.code
        result: dict[str, object] = {
            "status": "available" if available else "latest",
            "currentVersion": self.version,
            "latestVersion": release.version,
            "supported": supported,
            "reason": reason,
        }
        with self._mutex:
            lock = self._read_lock()
            if lock and process_alive(lock.get("pid")):
                if installation and lock.get("toolRoot") == str(installation.tool_root):
                    result["activeJob"] = lock.get("jobId")
                elif supported:
                    result["supported"], result["reason"] = False, "busy"
                return result
            self._intent = None
            if supported and available and installation:
                token = secrets.token_urlsafe(32)
                self._intent = (token, time.monotonic() + 300, release, installation)
                result["intentToken"] = token
        return result

    def start(self, token: str) -> dict[str, object]:
        with self._mutex:
            if not self._intent or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
                raise UpdateError("expired")
            expected, expires, release, installation = self._intent
            if not hmac.compare_digest(expected, token) or time.monotonic() > expires:
                raise UpdateError("expired")
            if self.lifecycle is None or self.lifecycle.host not in LOOPBACK_HOSTS:
                raise UpdateError("unsupported-installation")
            if detect_installation() != installation:
                raise UpdateError("installation-changed")
            if other_running_instances(self.cache, str(installation.tool_root), [os.getpid()]):
                raise UpdateError("other-instance-running")
            self._ensure_cache()
            previous = self._read_lock()
            if previous:
                if process_alive(previous.get("pid")):
                    raise UpdateError("busy")
                previous_id = str(previous.get("jobId", ""))
                if not JOB_PATTERN.fullmatch(previous_id):
                    raise UpdateError("invalid-update-state")
                old_job = self.cache / previous_id
                if old_job.exists():
                    try:
                        phase = read_json(old_job / "status.json").get("phase")
                    except FileNotFoundError:
                        phase = "download" if not (old_job / "plan.json").exists() else "unknown"
                    if phase not in TERMINAL_PHASES | {"download", "validate"}:
                        raise UpdateError("recovery-failed")
                (self.cache / "update.lock").unlink()
            identifier = secrets.token_hex(16)
            lock_path = self.cache / "update.lock"
            try:
                descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError as exc:
                raise UpdateError("busy") from exc
            job = self.cache / identifier
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as lock_file:
                    json.dump(
                        {
                            "pid": os.getpid(),
                            "jobId": identifier,
                            "toolRoot": str(installation.tool_root),
                        },
                        lock_file,
                    )
                job.mkdir(mode=0o700)
                write_json(
                    job / "job.json", {"version": release.version, "oldVersion": self.version}
                )
                write_status(job, "download")
                threading.Thread(
                    target=self._prepare, args=(job, release, installation), daemon=True
                ).start()
            except Exception:
                lock_path.unlink(missing_ok=True)
                raise
            self._intent = None
            return {"jobId": identifier, "version": release.version, "phase": "download"}

    def _prepare(self, job: Path, release: Release, installation: Installation) -> None:
        child: subprocess.Popen | None = None
        plan: UpdatePlan | None = None
        try:
            wheel, checksum = prepare_release(job, release, installation.python_version)
            if self.lifecycle is None:
                raise UpdateError("unmanaged-server")
            pids = [os.getpid()]
            pids.extend(_windows_launcher_pids(installation))
            plan = UpdatePlan(
                **{
                    key: str(value)
                    for key, value in asdict(installation).items()
                    if key != "python_version"
                },
                wheel=str(wheel),
                wheel_sha256=checksum,
                old_version=self.version,
                version=release.version,
                host=self.lifecycle.host,
                port=self.lifecycle.port,
                old_pids=pids,
                probe_token=secrets.token_hex(32),
            )
            write_json(job / "plan.json", asdict(plan))
            worker_script = job / "worker.py"
            shutil.copyfile(Path(update_worker.__file__), worker_script)
            options = (
                {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS}
                if os.name == "nt"
                else {"start_new_session": True}
            )
            with (job / "worker-start.log").open("a", encoding="utf-8") as worker_log:
                child = subprocess.Popen(
                    [
                        str(installation.base_python),
                        "-I",
                        "-S",
                        str(worker_script),
                        "--job-dir",
                        str(job),
                    ],
                    cwd=job,
                    stdin=subprocess.DEVNULL,
                    stdout=worker_log,
                    stderr=subprocess.STDOUT,
                    **options,
                )
            write_json(
                self.cache / "update.lock",
                {"pid": child.pid, "jobId": job.name, "toolRoot": str(installation.tool_root)},
            )
            deadline = time.monotonic() + 10
            while not (job / "ready.json").exists():
                if child.poll() is not None or time.monotonic() > deadline:
                    raise UpdateError("handoff-failed")
                time.sleep(0.05)
            if read_json(job / "ready.json").get("pid") != child.pid:
                raise UpdateError("handoff-failed")
            write_status(job, "restart")
            (job / "go").write_text(job.name, encoding="ascii")
            self.lifecycle.shutdown()
        except Exception as exc:
            if child is not None and child.poll() is None:
                update_worker.stop_started_process(child)
            code = exc.code if isinstance(exc, UpdateError) else "prepare-failed"
            best_effort(
                append_log, job, f"Update preparation failed: {code} ({type(exc).__name__}).", plan
            )
            best_effort(write_status, job, "failed", code=code)
            with self._mutex:
                lock = self._read_lock()
                if lock and lock.get("jobId") == job.name:
                    (self.cache / "update.lock").unlink(missing_ok=True)

    def _job(self, identifier: str) -> Path:
        if not JOB_PATTERN.fullmatch(identifier):
            raise UpdateError("unknown-job")
        job = self.cache / identifier
        if not job.is_dir() or job.is_symlink():
            raise UpdateError("unknown-job")
        return job

    def status(self, identifier: str) -> dict[str, object]:
        job = self._job(identifier)
        identity, status = read_json(job / "job.json"), read_json(job / "status.json")
        version_parts(identity["version"])
        version_parts(identity["oldVersion"])
        phase = status.get("phase") if status.get("phase") in UPDATE_PHASES else "recovery-failed"
        code = status.get("code") if status.get("code") in UPDATE_ERROR_CODES else None
        return {
            "jobId": identifier,
            "version": identity["version"],
            "oldVersion": identity["oldVersion"],
            "serverVersion": self.version,
            "phase": phase,
            "code": code,
            "restored": status.get("restored") is True,
            "logAvailable": True,
        }

    def log(self, identifier: str) -> str:
        status = self.status(identifier)
        # Subprocess diagnostics stay in the private cache; the HTTP log exposes fixed fields only.
        return (
            "CrystalSketch update\n"
            f"Target version: {status['version']}\n"
            f"Original version: {status['oldVersion']}\n"
            f"Server version: {status['serverVersion']}\n"
            f"Stage: {status['phase']}\n"
            f"Result code: {status['code'] or 'none'}\n"
            f"Original version restored: {status['restored']}\n"
        )

    def ready(self, probe: str) -> bool:
        return bool(
            self._probe
            and re.fullmatch(r"[a-f0-9]{64}", probe)
            and hmac.compare_digest(self._probe, probe)
        )
