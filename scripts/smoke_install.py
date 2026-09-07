"""Check the installed global command and its bundled web app outside the source tree."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[1]
    if args.work_dir.resolve().is_relative_to(repository):
        raise SystemExit("The smoke test work directory must be outside the repository")
    environment = dict(
        os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8", NO_COLOR="1", COLUMNS="160"
    )
    environment.pop("PYTHONPATH", None)
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
        log_path = Path(work) / "server.log"
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [command, "--no-open", "--host", "127.0.0.1", "--port", "0"],
                cwd=work, env=environment, stdout=log, stderr=subprocess.STDOUT,
            )
            try:
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError(f"Crystal exited early with code {process.returncode}")
                    output = log_path.read_text(encoding="utf-8", errors="replace")
                    match = re.search(r"http://localhost:(\d+)/", output)
                    if match:
                        base_url = f"http://127.0.0.1:{match[1]}/"
                        try:
                            verify(base_url)
                        except (URLError, TimeoutError):
                            pass
                        else:
                            print(
                                "PASS: global Crystal served HTML, JavaScript "
                                f"and health at {base_url}"
                            )
                            return
                    time.sleep(0.2)
                raise RuntimeError(
                    "Crystal did not serve the installed application within 60 seconds"
                )
            except Exception:
                print(log_path.read_text(encoding="utf-8", errors="replace"))
                raise
            finally:
                if process.poll() is None:
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


if __name__ == "__main__":
    main()
