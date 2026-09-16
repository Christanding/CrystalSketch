"""Per-user managed-service ownership and authenticated repeat-launch discovery."""

from __future__ import annotations

import errno
import hmac
import http.client
import ipaddress
import json
import os
import re
import secrets
import socket
import stat
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path

from crystalsketch.server.update_worker import (
    JOB_PATTERN,
    UpdateError,
    other_running_instances,
    process_alive,
    read_json,
    version_parts,
    write_json,
)

IDENTITY_HEADER = "X-CrystalSketch-Instance-Token"
IDENTITY_PATH = "/api/instance"
_TOKEN = re.compile(r"^[a-f0-9]{64}$")


class InstanceError(Exception):
    pass


@dataclass(frozen=True, kw_only=True)
class InstanceInfo:
    pid: int
    tool_root: str
    host: str
    port: int
    version: str
    instance_id: str
    secret: str

    @property
    def probe_host(self) -> str | None:
        if self.host in {"localhost", "127.0.0.1", "0.0.0.0"}:
            return "127.0.0.1"
        if self.host in {"::1", "::"}:
            return "::1"
        # Preserve explicit local-interface binds without sending the token to a
        # remote or DNS-rebound metadata host. Bind checks the literal address locally.
        try:
            address = ipaddress.ip_address(self.host)
            family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
            with socket.socket(family, socket.SOCK_STREAM) as check:
                check.bind((str(address), 0))
            return str(address)
        except (ValueError, OSError):
            return None

    @property
    def url(self) -> str:
        host = "localhost" if self.host == "127.0.0.1" else self.host
        return f"http://{'[' + host + ']' if ':' in host else host}:{self.port}/"

    def accepts(self, token: str) -> bool:
        return bool(_TOKEN.fullmatch(token) and hmac.compare_digest(token, self.secret))


def read_instance(cache: Path) -> InstanceInfo | None:
    try:
        value = read_json(cache / "instance.json", 4096)
        info = InstanceInfo(**value)
        if (type(info.pid) is not int or info.pid <= 0 or type(info.port) is not int
                or not 1 <= info.port <= 65535 or not isinstance(info.host, str)
                or not info.host or len(info.host) > 255
                or not isinstance(info.tool_root, str) or not Path(info.tool_root).is_absolute()
                or not isinstance(info.instance_id, str)
                or not JOB_PATTERN.fullmatch(info.instance_id)
                or not isinstance(info.secret, str) or not _TOKEN.fullmatch(info.secret)):
            return None
        version_parts(info.version)
        return info
    except (OSError, ValueError, TypeError, UpdateError):
        return None


def probe_instance(info: InstanceInfo) -> InstanceInfo | None:
    """Never open arbitrary metadata URLs or trust a port's generic health response."""
    host = info.probe_host
    if host is None or not process_alive(info.pid):
        return None
    connection = http.client.HTTPConnection(host, info.port, timeout=0.5)
    try:
        # HTTPConnection neither uses proxies nor follows redirects with the private token.
        connection.request("GET", IDENTITY_PATH, headers={
            IDENTITY_HEADER: info.secret, "Host": f"localhost:{info.port}",
        })
        response = connection.getresponse()
        body = response.read(4097)
        if response.status != 200 or len(body) > 4096:
            return None
        value = json.loads(body)
        if (not isinstance(value, dict) or value.get("application") != "CrystalSketch"
                or value.get("instanceId") != info.instance_id):
            return None
        version_parts(value.get("version"))
        return replace(info, version=value["version"])
    except (OSError, ValueError, http.client.HTTPException, UpdateError):
        return None
    finally:
        connection.close()


class InstanceLease:
    """Keep the lock inode: unlinking a locked file could admit a second owner."""

    def __init__(self, cache: Path, root: Path) -> None:
        self.cache = cache
        self.root = root
        self.fd: int | None = None
        self.owned = False
        self.info: InstanceInfo | None = None

    def try_acquire(self) -> bool:
        if self.owned:
            return True
        if self.fd is None:
            self.cache.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.cache.is_symlink() or (
                os.name != "nt" and self.cache.stat().st_uid != os.getuid()
            ):
                raise InstanceError("invalid-instance-state")
            if os.name != "nt":
                self.cache.chmod(0o700)
            flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
            self.fd = os.open(self.cache / "instance.lock", flags, 0o600)
            metadata = os.fstat(self.fd)
            if not stat.S_ISREG(metadata.st_mode) or (
                os.name != "nt" and metadata.st_uid != os.getuid()
            ):
                self.close()
                raise InstanceError("invalid-instance-state")
            os.set_inheritable(self.fd, False)
            if os.name != "nt":
                os.fchmod(self.fd, 0o600)
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in {errno.EACCES, errno.EAGAIN}:
                return False
            raise
        self.owned = True
        return True

    def publish(self, *, host: str, port: int, version: str) -> InstanceInfo:
        if not self.owned:
            raise InstanceError("instance-not-owned")
        self.info = InstanceInfo(
            pid=os.getpid(), tool_root=str(self.root), host=host, port=port, version=version,
            instance_id=secrets.token_hex(16), secret=secrets.token_hex(32),
        )
        write_json(self.cache / "instance.json", asdict(self.info))
        return self.info

    def close(self) -> None:
        if self.fd is None:
            return
        try:
            if self.owned:
                try:
                    current = read_instance(self.cache)
                    if self.info and current and current.instance_id == self.info.instance_id:
                        (self.cache / "instance.json").unlink(missing_ok=True)
                except OSError:
                    pass  # A stale descriptor is harmless once the OS lock is released.
                if os.name == "nt":
                    import msvcrt

                    os.lseek(self.fd, 0, os.SEEK_SET)
                    msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(self.fd, fcntl.LOCK_UN)
        finally:
            os.close(self.fd)
            self.fd, self.owned, self.info = None, False, None


def _updating(cache: Path, root: Path) -> bool:
    try:
        lock = read_json(cache / "update.lock", 4096)
    except FileNotFoundError:
        return False
    except (ValueError, UpdateError) as exc:
        raise InstanceError("invalid-instance-state") from exc
    if not process_alive(lock.get("pid")):
        return False
    incoming = os.environ.get("CRYSTALSKETCH_UPDATE_JOB", "")
    return not (
        JOB_PATTERN.fullmatch(incoming)
        and lock.get("toolRoot") == str(root)
        and lock.get("jobId") == incoming
    )


def claim_or_reuse(
    cache: Path, root: Path, *, timeout: float = 30.0
) -> InstanceLease | InstanceInfo:
    lease = InstanceLease(cache, root)
    deadline = time.monotonic() + timeout
    updating = False
    try:
        while True:
            if lease.try_acquire():
                updating = _updating(cache, root)
                if not updating:
                    if other_running_instances(cache, None, [os.getpid()]):
                        raise InstanceError("legacy-instance-running")
                    return lease
                lease.close()  # The authorized updater must be able to start its replacement.
            else:
                info = read_instance(cache)
                if info is not None:
                    live = probe_instance(info)
                    if live is not None:
                        lease.close()
                        return live
            if time.monotonic() >= deadline:
                raise InstanceError("update-in-progress" if updating else "instance-unavailable")
            time.sleep(0.1)
    except BaseException:
        lease.close()
        raise


def parent_instance(cache: Path, root: Path) -> InstanceInfo | None:
    """Uvicorn reload children serve the identity owned by their managed launcher."""
    info = read_instance(cache)
    if info and info.pid == os.getppid() and info.tool_root == str(root):
        return info
    return None
