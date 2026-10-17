"""Check the installed global command and its bundled web app outside the source tree."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import ProxyHandler, build_opener


class ModuleScripts(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.sources: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        source = attributes.get("src")
        if tag == "script" and attributes.get("type") == "module" and source:
            self.sources.append(source)


def verify(base_url: str) -> None:
    opener = build_opener(ProxyHandler({}))
    with opener.open(urljoin(base_url, "api/health"), timeout=5) as response:
        if json.load(response) != {"status": "ok"}:
            raise RuntimeError("Unexpected health response")
    with opener.open(base_url, timeout=5) as response:
        html = response.read().decode("utf-8")
        if response.headers.get_content_type() != "text/html" or "CrystalSketch" not in html:
            raise RuntimeError("The installed command did not serve the application page")
    parser = ModuleScripts()
    parser.feed(html)
    if not parser.sources:
        raise RuntimeError("The application page has no bundled JavaScript module")
    for source in parser.sources:
        url = urljoin(base_url, source)
        if urlsplit(url).netloc != urlsplit(base_url).netloc:
            raise RuntimeError("The application module is not bundled locally")
        with opener.open(url, timeout=10) as response:
            if response.headers.get_content_type() not in {
                "text/javascript", "application/javascript", "application/x-javascript",
            } or not response.read():
                raise RuntimeError(f"Invalid JavaScript resource: {source}")


def stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=True, stdout=subprocess.DEVNULL,
        )
    else:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def probe_installed_updater(metadata: Path) -> dict[str, str]:
    """Run inside the installed tool, using real release data fetched by CI's authenticated step."""
    from unittest.mock import patch

    from crystalsketch.server import updater

    installation = updater.detect_installation()

    def release_response(url: str, timeout: float):
        if url != updater.LATEST_RELEASE_API:
            raise RuntimeError("Unexpected update request during metadata validation")
        return metadata.open("rb")

    # Substitute only the download transport in this disposable probe process.
    # The installed updater still validates the full, unmodified release response.
    with patch.object(updater, "_official_open", release_response):
        release = updater.latest_release()
    return {
        "currentVersion": updater.current_version(), "latestVersion": release.version,
        "entrypoint": str(installation.entrypoint),
    }


def verify_update_support(
    command: str, metadata: Path, work: str, environment: dict[str, str],
) -> None:
    uv = shutil.which("uv", path=environment.get("PATH"))
    if not uv:
        raise RuntimeError("uv must be available to the installed updater")
    tool_dir = Path(subprocess.check_output(
        [uv, "--no-config", "--color", "never", "tool", "dir"],
        cwd=work, env=environment, text=True, encoding="utf-8", timeout=10,
    ).strip())
    executable = "Scripts/python.exe" if os.name == "nt" else "bin/python"
    python = tool_dir / "crystalsketch" / executable
    status = json.loads(subprocess.check_output(
        [str(python), "-I", str(Path(__file__).resolve()), "--probe-installed-updater",
         "--release-metadata", str(metadata.resolve())],
        cwd=work, env=environment, text=True, encoding="utf-8", timeout=30,
    ))
    if Path(status["entrypoint"]).resolve() != Path(command).resolve():
        raise RuntimeError("Updater probe inspected a different Crystal installation")
    print(
        f"PASS: installed updater v{status['currentVersion']} recognized its tool environment "
        f"and validated supplied release v{status['latestVersion']}; "
        "read-only metadata probe, no live update API call or installation"
    )


def verify_repeat_launch(command: str, work: str, environment: dict[str, str], port: str) -> None:
    repeat = subprocess.Popen(
        [command, "--no-open", "--port", "0"], cwd=work, env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
    )
    try:
        output, _ = repeat.communicate(timeout=15)
        if (repeat.returncode != 0 or "already running" not in output
                or f"http://localhost:{port}/" not in output):
            raise RuntimeError(f"Repeat launch did not reuse the installed service: {output}")
    finally:
        stop_process(repeat)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument(
        "--release-metadata", type=Path,
        help="Validate updater compatibility using the official release JSON fetched by CI",
    )
    parser.add_argument("--probe-installed-updater", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.probe_installed_updater:
        if args.release_metadata is None:
            parser.error("--release-metadata is required for an installed updater probe")
        print(json.dumps(probe_installed_updater(args.release_metadata)))
        return
    if args.work_dir is None:
        parser.error("--work-dir is required for an installation smoke test")
    repository = Path(__file__).resolve().parents[1]
    if args.work_dir.resolve().is_relative_to(repository):
        raise SystemExit("The smoke test work directory must be outside the repository")
    environment = dict(
        os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8", NO_COLOR="1", COLUMNS="160"
    )
    for name in ("PYTHONPATH", "GH_TOKEN", "GITHUB_TOKEN"):
        environment.pop(name, None)
    if os.name == "nt":
        import winreg

        def registry_path(hive, key: str) -> str:
            try:
                with winreg.OpenKey(hive, key) as entry:
                    return str(winreg.QueryValueEx(entry, "Path")[0])
            except FileNotFoundError:
                return ""

        # Ignore GITHUB_PATH and the installer's transient PATH, as on a fresh login.
        machine = registry_path(
            winreg.HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        )
        user = registry_path(winreg.HKEY_CURRENT_USER, "Environment")
        environment["PATH"] = os.path.expandvars(machine + ";" + user)
    command = shutil.which("Crystal", path=environment.get("PATH"))
    if not command or Path(command).resolve().is_relative_to(repository):
        raise SystemExit("Crystal must be installed globally and available on persisted PATH")
    with tempfile.TemporaryDirectory(prefix="crystalsketch-smoke-", dir=args.work_dir) as work:
        output: list[str] = []
        process = subprocess.Popen(
            [command, "--no-open", "--host", "127.0.0.1", "--port", "0"],
            cwd=work, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
        assert process.stdout is not None
        reader = threading.Thread(target=output.extend, args=(process.stdout,), daemon=True)
        reader.start()
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"Crystal exited early with code {process.returncode}")
                match = re.search(r"http://localhost:(\d+)/", "".join(output))
                if match:
                    base_url = f"http://127.0.0.1:{match[1]}/"
                    try:
                        verify(base_url)
                    except (URLError, TimeoutError):
                        pass
                    else:
                        verify_repeat_launch(command, work, environment, match[1])
                        if process.poll() is not None:
                            raise RuntimeError("Repeat launch stopped the original service")
                        verify(base_url)
                        if args.release_metadata is not None:
                            verify_update_support(command, args.release_metadata, work, environment)
                        print(
                            "PASS: global Crystal served HTML, JavaScript "
                            f"and health at {base_url}; repeat launch reused that service"
                        )
                        return
                time.sleep(0.2)
            raise RuntimeError("Crystal did not serve the installed application within 60 seconds")
        except Exception:
            print("".join(output))
            raise
        finally:
            stop_process(process)
            # Windows launcher exit can precede its Python child's exit. EOF waits
            # for every inherited output handle without leaving a locked log file.
            reader.join(timeout=10)
            if reader.is_alive():
                raise RuntimeError("The installed process tree did not close its output")
            process.stdout.close()


if __name__ == "__main__":
    main()
