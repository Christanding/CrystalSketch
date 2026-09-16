"""Standalone stdlib updater, copied out of the tool environment before it is stopped."""

from __future__ import annotations

import argparse
import base64
import configparser
import csv
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from email.parser import BytesParser
from pathlib import Path

MAX_WHEEL_BYTES = 128 * 1024 * 1024
MAX_UNPACKED_BYTES = 512 * 1024 * 1024
MAX_ENVIRONMENT_BYTES = 2 * 1024 * 1024 * 1024
VERSION_PATTERN = re.compile(
    r"^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)
JOB_PATTERN = re.compile(r"^[a-f0-9]{32}$")
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
TERMINAL_PHASES = {"complete", "failed", "recovery-failed"}
UPDATE_PHASES = TERMINAL_PHASES | {
    "download",
    "validate",
    "backup",
    "installing",
    "restart",
    "restore",
    "waiting-for-exit",
}
UPDATE_ERROR_CODES = {
    "invalid-version",
    "invalid-update-state",
    "invalid-package",
    "package-too-large",
    "package-version-mismatch",
    "package-integrity-failed",
    "installation-changed",
    "insufficient-backup-space",
    "invalid-backup",
    "install-failed",
    "installed-version-mismatch",
    "restart-failed",
    "handoff-failed",
    "old-process-busy",
    "other-instance-running",
    "update-failed",
    "prepare-failed",
    "recovery-failed",
    "download-timeout",
    "invalid-download-source",
}


class UpdateError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def version_parts(value: str) -> tuple[tuple[int, int, int], tuple[str, ...]]:
    if not isinstance(value, str) or len(value) > 128:
        raise UpdateError("invalid-version")
    match = VERSION_PATTERN.fullmatch(value.strip())
    if match is None:
        raise UpdateError("invalid-version")
    prerelease = tuple(match[4].split(".")) if match[4] else ()
    if any(part.isdigit() and len(part) > 1 and part.startswith("0") for part in prerelease):
        raise UpdateError("invalid-version")
    return (int(match[1]), int(match[2]), int(match[3])), prerelease


def compare_versions(first: str, second: str) -> int:
    a, pre_a = version_parts(first)
    b, pre_b = version_parts(second)
    if a != b:
        return 1 if a > b else -1
    if not pre_a or not pre_b:
        return 0 if pre_a == pre_b else (-1 if pre_a else 1)
    for left, right in zip(pre_a, pre_b, strict=False):
        if left == right:
            continue
        if left.isdigit() and right.isdigit():
            return 1 if int(left) > int(right) else -1
        if left.isdigit() != right.isdigit():
            return -1 if left.isdigit() else 1
        return 1 if left > right else -1
    return (len(pre_a) > len(pre_b)) - (len(pre_a) < len(pre_b))


def read_json(path: Path, limit: int = 32 * 1024) -> dict[str, object]:
    with path.open("rb") as stream:
        content = stream.read(limit + 1)
    if len(content) > limit:
        raise UpdateError("invalid-update-state")
    data = json.loads(content)
    if not isinstance(data, dict):
        raise UpdateError("invalid-update-state")
    return data


def write_json(path: Path, data: dict[str, object]) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=".update-", delete=False
    ) as stream:
        temporary = Path(stream.name)
        json.dump(data, stream, ensure_ascii=True)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_status(job: Path, phase: str, *, code: str | None = None, restored: bool = False) -> None:
    write_json(
        job / "status.json",
        {"phase": phase, "code": code, "restored": restored, "updatedAt": time.time()},
    )


def best_effort(action: Callable, *args, **kwargs) -> None:
    """Observability must never prevent restoration after the environment has been touched."""
    try:
        action(*args, **kwargs)
    except Exception:
        pass


def process_alive(pid: int) -> bool:
    if type(pid) is not int or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE, no admin access.
        if not handle:
            return ctypes.get_last_error() != 87  # ERROR_INVALID_PARAMETER: no such PID.
        try:
            return kernel.WaitForSingleObject(handle, 0) != 0
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def safe_archive_entries(
    archive: zipfile.ZipFile, *, max_files: int = 20_000, max_bytes: int = MAX_UNPACKED_BYTES
) -> dict[str, zipfile.ZipInfo]:
    entries = archive.infolist()
    if len(entries) > max_files or sum(entry.file_size for entry in entries) > max_bytes:
        raise UpdateError("package-too-large")
    names: set[str] = set()
    result: dict[str, zipfile.ZipInfo] = {}
    reserved = {
        "con",
        "prn",
        "aux",
        "nul",
        *(f"com{i}" for i in range(1, 10)),
        *(f"lpt{i}" for i in range(1, 10)),
    }
    for entry in entries:
        name = entry.filename
        parts = name.rstrip("/").split("/")
        if (
            not name
            or "\\" in name
            or ":" in name
            or any(ord(c) < 32 for c in name)
            or any(
                part in {"", ".", ".."}
                or part.endswith((" ", "."))
                or part.split(".")[0].casefold() in reserved
                for part in parts
            )
            or name.rstrip("/").casefold() in names
            or stat.S_ISLNK(entry.external_attr >> 16)
            or entry.flag_bits & 1
            or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
            or entry.file_size > MAX_WHEEL_BYTES
        ):
            raise UpdateError("invalid-package")
        names.add(name.rstrip("/").casefold())
        result[name] = entry
    return result


def python_requirement_matches(requirement: str, python_version: tuple[int, int, int]) -> bool:
    """Accept ordinary release Python bounds; reject unsupported syntax instead of guessing."""
    for clause in requirement.split(","):
        match = re.fullmatch(r"\s*(>=|<=|==|!=|>|<|~=)\s*(\d+(?:\.\d+){0,2})(\.\*)?\s*", clause)
        if not match:
            return False
        operator, raw, wildcard = match.groups()
        parts = tuple(int(part) for part in raw.split("."))
        target = (*parts, *(0 for _ in range(3 - len(parts))))
        if wildcard:
            if operator not in {"==", "!="}:
                return False
            equal = python_version[: len(parts)] == parts
            valid = equal if operator == "==" else not equal
        elif operator == "~=":
            if len(parts) < 2:
                return False
            upper = (parts[0] + 1, 0, 0) if len(parts) == 2 else (parts[0], parts[1] + 1, 0)
            valid = target <= python_version < upper
        else:
            valid = {
                ">=": python_version >= target,
                "<=": python_version <= target,
                ">": python_version > target,
                "<": python_version < target,
                "==": python_version == target,
                "!=": python_version != target,
            }[operator]
        if not valid:
            return False
    return True


def validate_wheel(path: Path, expected_version: str, python_version: tuple[int, int, int]) -> str:
    """Validate package identity, portable entrypoint, bundled UI and every RECORD hash/size."""
    version_parts(expected_version)
    if path.name != f"crystalsketch-{expected_version}-py3-none-any.whl":
        raise UpdateError("invalid-package")
    try:
        with zipfile.ZipFile(path) as wheel:
            entries = safe_archive_entries(wheel)
            metadata_paths = [name for name in entries if name.endswith(".dist-info/METADATA")]
            if len(metadata_paths) != 1:
                raise UpdateError("invalid-package")
            metadata_path = metadata_paths[0]
            dist_info = metadata_path.split("/")[0]
            if dist_info != f"crystalsketch-{expected_version}.dist-info":
                raise UpdateError("invalid-package")
            if any(not name.startswith(("crystalsketch/", f"{dist_info}/")) for name in entries):
                raise UpdateError("invalid-package")
            for name, limit in [
                (metadata_path, 1024 * 1024),
                (f"{dist_info}/WHEEL", 64 * 1024),
                (f"{dist_info}/entry_points.txt", 64 * 1024),
                (f"{dist_info}/RECORD", 4 * 1024 * 1024),
            ]:
                if entries[name].file_size > limit:
                    raise UpdateError("invalid-package")
            metadata = BytesParser().parsebytes(wheel.read(metadata_path))
            if (
                metadata.get_all("Name") != ["crystalsketch"]
                or metadata.get_all("Version") != [expected_version]
                or not python_requirement_matches(
                    metadata.get("Requires-Python", ""), python_version
                )
            ):
                raise UpdateError("package-version-mismatch")
            wheel_metadata = BytesParser().parsebytes(wheel.read(f"{dist_info}/WHEEL"))
            if wheel_metadata.get(
                "Root-Is-Purelib", ""
            ).lower() != "true" or wheel_metadata.get_all("Tag") != ["py3-none-any"]:
                raise UpdateError("invalid-package")
            points = configparser.ConfigParser(interpolation=None)
            points.optionxform = str
            points.read_string(wheel.read(f"{dist_info}/entry_points.txt").decode("utf-8"))
            if set(points.sections()) != {"console_scripts"} or dict(points["console_scripts"]) != {
                "Crystal": "crystalsketch.entrypoint:main"
            }:
                raise UpdateError("invalid-package")
            required = {
                "crystalsketch/entrypoint.py",
                "crystalsketch/cli.py",
                "crystalsketch/server/app.py",
                "crystalsketch/web_static/index.html",
            }
            if not required.issubset(entries) or not any(
                name.startswith("crystalsketch/web_static/assets/") and name.endswith(".js")
                for name in entries
            ):
                raise UpdateError("invalid-package")
            record_name = f"{dist_info}/RECORD"
            record = wheel.read(record_name)
            if len(record) > 4 * 1024 * 1024:
                raise UpdateError("invalid-package")
            records: dict[str, tuple[str, str]] = {}
            for row in csv.reader(io.StringIO(record.decode("utf-8"))):
                if len(row) != 3 or row[0] in records or row[0] not in entries:
                    raise UpdateError("invalid-package")
                records[row[0]] = (row[1], row[2])
            for name, entry in entries.items():
                if entry.is_dir():
                    continue
                if name == record_name:
                    if records.get(name) != ("", ""):
                        raise UpdateError("invalid-package")
                    continue
                digest, size = records.get(name, ("", ""))
                algorithm, separator, expected = digest.partition("=")
                if (
                    algorithm not in {"sha256", "sha384", "sha512"}
                    or not separator
                    or not size.isdigit()
                ):
                    raise UpdateError("invalid-package")
                hasher = hashlib.new(algorithm)
                length = 0
                with wheel.open(name) as content:
                    while chunk := content.read(1024 * 1024):
                        length += len(chunk)
                        hasher.update(chunk)
                actual = base64.urlsafe_b64encode(hasher.digest()).rstrip(b"=").decode("ascii")
                if actual != expected or length != int(size) or length != entry.file_size:
                    raise UpdateError("package-integrity-failed")
    except (KeyError, ValueError, UnicodeError, zipfile.BadZipFile, configparser.Error) as exc:
        raise UpdateError("invalid-package") from exc
    with path.open("rb") as content:
        return hashlib.file_digest(content, "sha256").hexdigest()


@dataclass(frozen=True)
class UpdatePlan:
    tool_root: str
    tool_dir: str
    bin_dir: str
    entrypoint: str
    tool_python: str
    base_python: str
    uv: str
    wheel: str
    wheel_sha256: str
    old_version: str
    version: str
    host: str
    port: int
    old_pids: list[int]
    probe_token: str


def validate_plan(job: Path, plan: UpdatePlan) -> None:
    root, tools, commands = Path(plan.tool_root), Path(plan.tool_dir), Path(plan.bin_dir)
    wheel, entry = Path(plan.wheel), Path(plan.entrypoint)
    paths = [
        root,
        tools,
        commands,
        wheel,
        entry,
        Path(plan.tool_python),
        Path(plan.base_python),
        Path(plan.uv),
    ]
    if (
        not JOB_PATTERN.fullmatch(job.name)
        or not all(path.is_absolute() for path in paths)
        or root.name.casefold() != "crystalsketch"
        or root.parent != tools
        or root.is_symlink()
        or entry.parent != commands
        or entry.name not in {"Crystal", "Crystal.exe"}
        or commands.is_relative_to(root)
        or job.is_relative_to(root)
        or root.is_relative_to(job)
        or wheel.parent != job
        or not Path(plan.tool_python).is_relative_to(root)
        or Path(plan.base_python).resolve().is_relative_to(root)
        or Path(plan.uv).resolve().is_relative_to(root)
        or plan.host not in LOOPBACK_HOSTS
        or type(plan.port) is not int
        or not 1 <= plan.port <= 65535
        or not plan.old_pids
        or any(type(pid) is not int or pid <= 0 for pid in plan.old_pids)
        or not re.fullmatch(r"[a-f0-9]{64}", plan.wheel_sha256)
        or not re.fullmatch(r"[a-f0-9]{64}", plan.probe_token)
    ):
        raise UpdateError("invalid-update-state")
    version_parts(plan.old_version)
    version_parts(plan.version)
    if compare_versions(plan.version, plan.old_version) <= 0:
        raise UpdateError("invalid-update-state")
    with wheel.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != plan.wheel_sha256:
            raise UpdateError("package-integrity-failed")


def child_environment(
    plan: UpdatePlan, *, restart: bool = False, job: Path | None = None
) -> dict[str, str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("UV_", "PYTHON", "PIP_", "CRYSTALSKETCH_UPDATE_"))
        and key not in {"VIRTUAL_ENV", "CONDA_PREFIX"}
    }
    environment.update(
        {
            "UV_TOOL_DIR": plan.tool_dir,
            "UV_TOOL_BIN_DIR": plan.bin_dir,
            "UV_NO_PROGRESS": "1",
            "UV_PYTHON_DOWNLOADS": "never",
        }
    )
    if restart and job is not None:
        environment["CRYSTALSKETCH_UPDATE_JOB"] = job.name
        environment["CRYSTALSKETCH_UPDATE_PROBE"] = plan.probe_token
    return environment


def append_log(job: Path, message: str, plan: UpdatePlan | None = None) -> None:
    text = message
    sensitive = [str(job), str(Path.home())]
    if plan:
        sensitive.extend(
            [
                plan.tool_root,
                plan.tool_dir,
                plan.bin_dir,
                plan.entrypoint,
                plan.tool_python,
                plan.base_python,
                plan.uv,
                plan.wheel,
                plan.probe_token,
            ]
        )
    for value in sorted(sensitive, key=len, reverse=True):
        text = text.replace(value, "[redacted]")
    text = re.sub(r"(https?://)[^/\s:@]+:[^/@\s]+@", r"\1[redacted]@", text)
    text = re.sub(r"(?i)authorization\s*[:=][^\r\n]+", "Authorization=[redacted]", text)
    text = re.sub(r"(?i)(token|password|secret|api[_-]?key)\s*[:=]\s*\S+", r"\1=[redacted]", text)
    with (job / "update.log").open("a", encoding="utf-8") as log:
        log.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {text[-8000:]}\n")


def _copy_entrypoint(source: Path, target: Path) -> None:
    if source.is_symlink():
        target.symlink_to(os.readlink(source))
    else:
        shutil.copy2(source, target)


def backup_installation(job: Path, plan: UpdatePlan) -> None:
    root = Path(plan.tool_root)
    if not (root / "uv-receipt.toml").is_file() or root.is_symlink():
        raise UpdateError("installation-changed")
    size = sum(
        path.stat().st_size for path in root.rglob("*") if path.is_file() and not path.is_symlink()
    )
    if size > MAX_ENVIRONMENT_BYTES or shutil.disk_usage(job).free < size * 2 + MAX_WHEEL_BYTES:
        raise UpdateError("insufficient-backup-space")
    backup = job / "backup"
    backup.mkdir(mode=0o700)
    shutil.copytree(root, backup / "tool", symlinks=True)
    _copy_entrypoint(Path(plan.entrypoint), backup / "entrypoint")
    write_json(backup / "complete.json", {"toolRoot": plan.tool_root, "version": plan.old_version})
    # Keep only one completed restore point for this exact installation; logs remain available.
    for previous in job.parent.iterdir():
        if (
            previous == job
            or previous.is_symlink()
            or not previous.is_dir()
            or not JOB_PATTERN.fullmatch(previous.name)
        ):
            continue
        try:
            previous_status = read_json(previous / "status.json")
            previous_backup = previous / "backup"
            if previous_backup.is_symlink():
                continue
            identity = read_json(previous_backup / "complete.json")
            if (
                previous_status.get("phase") in {"complete", "failed"}
                and identity.get("toolRoot") == plan.tool_root
            ):
                shutil.rmtree(previous_backup)
        except (OSError, ValueError, UpdateError):
            continue


def restore_installation(job: Path, plan: UpdatePlan) -> None:
    backup = job / "backup"
    if backup.is_symlink() or (backup / "tool").is_symlink():
        raise UpdateError("invalid-backup")
    identity = read_json(backup / "complete.json")
    if identity != {"toolRoot": plan.tool_root, "version": plan.old_version}:
        raise UpdateError("invalid-backup")
    root, entry = Path(plan.tool_root), Path(plan.entrypoint)
    if root.is_symlink():
        raise UpdateError("installation-changed")
    if root.exists():
        shutil.rmtree(root)
    shutil.copytree(backup / "tool", root, symlinks=True)
    entry.unlink(missing_ok=True)
    _copy_entrypoint(backup / "entrypoint", entry)


def other_running_instances(cache: Path, root: str, own_pids: list[int]) -> bool:
    running = cache / "running"
    if not running.exists():
        return False
    for marker in running.glob("*.json"):
        try:
            data = read_json(marker, 4096)
            pid = data.get("pid")
            if data.get("toolRoot") == root and pid not in own_pids and process_alive(pid):
                return True
        except (OSError, ValueError, UpdateError):
            continue
    return False


def _run_install(job: Path, plan: UpdatePlan) -> None:
    command = [
        plan.uv,
        "--no-config",
        "--color",
        "never",
        "tool",
        "install",
        "--python",
        plan.base_python,
        "--no-python-downloads",
        "--no-progress",
        "--reinstall-package",
        "crystalsketch",
        plan.wheel,
    ]
    result = subprocess.run(
        command,
        cwd=job,
        env=child_environment(plan),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
        check=False,
    )
    best_effort(append_log, job, result.stdout + result.stderr, plan)
    if result.returncode:
        raise UpdateError("install-failed")
    version = subprocess.run(
        [
            plan.tool_python,
            "-I",
            "-c",
            "from importlib.metadata import version; print(version('crystalsketch'))",
        ],
        cwd=job,
        env=child_environment(plan),
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    if (
        version.returncode
        or version.stdout.strip() != plan.version
        or not Path(plan.entrypoint).is_file()
    ):
        raise UpdateError("installed-version-mismatch")


def restart_service(job: Path, plan: UpdatePlan, expected_version: str) -> subprocess.Popen:
    # A direct tool Python process avoids a second Windows launcher holding Crystal.exe open.
    command = [
        plan.tool_python,
        "-I",
        "-c",
        "from crystalsketch.entrypoint import main; raise SystemExit(main())",
        "--host",
        plan.host,
        "--port",
        str(plan.port),
        "--no-open",
    ]
    options = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS}
        if os.name == "nt"
        else {"start_new_session": True}
    )
    with (job / "startup.log").open("a", encoding="utf-8") as startup_log:
        process = subprocess.Popen(
            command,
            cwd=job,
            env=child_environment(plan, restart=True, job=job),
            stdin=subprocess.DEVNULL,
            stdout=startup_log,
            stderr=subprocess.STDOUT,
            **options,
        )
    host = "[::1]" if plan.host == "::1" else "127.0.0.1"
    request = urllib.request.Request(
        f"http://{host}:{plan.port}/api/updates/ready",
        headers={"X-CrystalSketch-Update-Probe": plan.probe_token},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 60
    try:
        while time.monotonic() < deadline and process.poll() is None:
            try:
                with opener.open(request, timeout=1) as response:
                    data = json.loads(response.read(4096))
                if data.get("version") == expected_version:
                    return process
            except (OSError, ValueError, urllib.error.URLError):
                pass
            time.sleep(0.25)
        raise UpdateError("restart-failed")
    except BaseException:
        stop_started_process(process)
        with (job / "startup.log").open("r", encoding="utf-8", errors="replace") as startup_log:
            append_log(job, startup_log.read(64 * 1024), plan)
        raise


def stop_started_process(process: subprocess.Popen) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def run_update(job: Path) -> int:
    plan: UpdatePlan | None = None
    backup_complete = False
    installation_started = False
    old_stopped = False
    new_service: subprocess.Popen | None = None
    try:
        plan = UpdatePlan(**read_json(job / "plan.json"))
        validate_plan(job, plan)
        write_json(job / "ready.json", {"pid": os.getpid()})
        deadline = time.monotonic() + 15
        while not (job / "go").is_file():
            if time.monotonic() > deadline:
                raise UpdateError("handoff-failed")
            time.sleep(0.05)
        deadline = time.monotonic() + 90
        abandoned_install = False
        while any(process_alive(pid) for pid in plan.old_pids):
            if not abandoned_install and time.monotonic() > deadline:
                abandoned_install = True
                best_effort(write_status, job, "waiting-for-exit", code="old-process-busy")
                best_effort(
                    append_log,
                    job,
                    "Installation abandoned; waiting to restart the original service.",
                    plan,
                )
            time.sleep(0.1)
        old_stopped = True
        if abandoned_install:
            raise UpdateError("old-process-busy")
        if other_running_instances(job.parent, plan.tool_root, plan.old_pids):
            raise UpdateError("other-instance-running")
        write_status(job, "backup")
        backup_installation(job, plan)
        backup_complete = True
        write_status(job, "installing")
        installation_started = True
        _run_install(job, plan)
        write_status(job, "restart")
        new_service = restart_service(job, plan, plan.version)
        write_status(job, "complete")
        best_effort(
            append_log,
            job,
            "Update installed and the restarted server reported the expected version.",
            plan,
        )
        try:
            Path(plan.wheel).unlink(missing_ok=True)
        except OSError:
            pass
        return 0
    except Exception as exc:
        code = exc.code if isinstance(exc, UpdateError) else "update-failed"
        best_effort(append_log, job, f"Update failed: {code} ({type(exc).__name__}).", plan)
        if plan and old_stopped:
            try:
                if new_service is not None:
                    stop_started_process(new_service)
                if installation_started:
                    if not backup_complete:
                        raise UpdateError("invalid-backup")
                    best_effort(write_status, job, "restore")
                    restore_installation(job, plan)
                restart_service(job, plan, plan.old_version)
                best_effort(write_status, job, "failed", code=code, restored=True)
                best_effort(
                    append_log,
                    job,
                    "The original version is running again; the restore point is retained.",
                    plan,
                )
                return 1
            except Exception as recovery:
                best_effort(append_log, job, f"Recovery failed ({type(recovery).__name__}).", plan)
                best_effort(write_status, job, "recovery-failed", code="recovery-failed")
                return 2
        best_effort(write_status, job, "failed", code=code)
        return 1
    finally:
        try:
            lock = job.parent / "update.lock"
            if read_json(lock, 4096).get("jobId") == job.name:
                lock.unlink()
        except (OSError, ValueError, UpdateError):
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", required=True, type=Path)
    arguments = parser.parse_args()
    raise SystemExit(run_update(arguments.job_dir.resolve()))
