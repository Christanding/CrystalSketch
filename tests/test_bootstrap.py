from __future__ import annotations

import os
import shutil
import stat
import struct
import subprocess
import sys
import warnings
import zipfile
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.name == "nt", reason="POSIX bootstrap; Windows has its own harness"
)
BOOTSTRAP = Path(__file__).parents[1] / "scripts" / "bootstrap.sh"
WHEEL = "CrystalSketch/crystalsketch-0.0.0-py3-none-any.whl"


@pytest.fixture
def bootstrap_case(tmp_path: Path):
    root = tmp_path / "Crystal a'a bootstrap"
    commands, temporary, uv_dir = root / "commands", root / "temporary", root / "uv"
    for path in (commands, temporary, uv_dir):
        path.mkdir(parents=True)
    for name in ("bash", "sh", "uname", "mktemp", "rm", "dirname", "mkdir", "cp", "chmod"):
        executable = shutil.which(name)
        assert executable is not None
        (commands / name).symlink_to(executable)
    uv_fixture = root / "uv-fixture"
    uv_fixture.write_text('''#!/bin/bash
case "$*" in
  'run --help') printf '%s\\n' '--no-project' ;;
  'tool install --help') printf '%s\\n' '--reinstall-package' ;;
  'python --help') exit 0 ;;
  'run --no-config --no-project --python 3.12 python - '*)
    shift 6; exec "$CRYSTAL_TEST_PYTHON" "$@" ;;
  *) exit 91 ;;
esac
''')
    uv_fixture.chmod(0o755)
    uv_installer = root / "uv-installer"
    uv_installer.write_text('''#!/bin/sh
set -eu
mkdir -p "$UV_INSTALL_DIR"
cp "$CRYSTAL_TEST_UV" "$UV_INSTALL_DIR/uv"
chmod u+x "$UV_INSTALL_DIR/uv"
printf 'installed' > "$CRYSTAL_TEST_UV_MARKER"
''')
    (commands / "curl").write_text(f'''#!{sys.executable}
import os, shutil, sys
from pathlib import Path
args = sys.argv[1:]
target = Path(args[args.index("--output") + 1])
url = args[-1]
if os.environ.get("CRYSTAL_TEST_DOWNLOAD_FAILURE") == "1":
    target.write_bytes(b"partial")
    sys.exit(22)
sources = {{
    "https://github.com/Christanding/CrystalSketch/releases/latest/download/CrystalSketch.zip":
        os.environ["CRYSTAL_TEST_ARCHIVE"],
    "https://astral.sh/uv/install.sh": os.environ["CRYSTAL_TEST_UV_INSTALLER"],
}}
shutil.copyfile(sources[url], target)
''')
    (commands / "curl").chmod(0o755)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("UV_")}
    environment.update({
        "PATH": str(commands), "TMPDIR": str(temporary), "UV_INSTALL_DIR": str(uv_dir),
        "CRYSTAL_TEST_PYTHON": sys.executable, "CRYSTAL_TEST_UV": str(uv_fixture),
        "CRYSTAL_TEST_UV_INSTALLER": str(uv_installer),
        "CRYSTAL_TEST_UV_MARKER": str(root / "uv-installed"),
        "CRYSTAL_TEST_ARCHIVE": str(root / "release.zip"),
        "CRYSTAL_TEST_INSTALL_MARKER": str(root / "installed"),
    })
    installer = '''#!/bin/bash
set -eu
crystal_fixture_dir="$(dirname -- "${BASH_SOURCE[0]}")"
test -f "$crystal_fixture_dir/crystalsketch-0.0.0-py3-none-any.whl"
printf '%s\\n' "$crystal_fixture_dir" > "$CRYSTAL_TEST_INSTALL_MARKER"
exit "${CRYSTAL_TEST_INSTALL_EXIT:-0}"
'''
    with zipfile.ZipFile(environment["CRYSTAL_TEST_ARCHIVE"], "w") as archive:
        archive.writestr(WHEEL, b"fixture wheel")
        archive.writestr("CrystalSketch/install.sh", installer)
        archive.writestr("CrystalSketch/install.ps1", "# fixture")
    sentinel = root / "unrelated.txt"
    sentinel.write_text("keep")
    return root, environment, sentinel


def run_bootstrap(case, *, pipe: bool = False):
    root, environment, sentinel = case
    command = [str(root / "commands/bash")]
    result = subprocess.run(
        command if pipe else [*command, str(BOOTSTRAP)],
        input=BOOTSTRAP.read_text() if pipe else None,
        cwd=root, env=environment, text=True, capture_output=True, timeout=30,
    )
    assert list(Path(environment["TMPDIR"]).iterdir()) == []
    assert sentinel.read_text() == "keep"
    return result


@pytest.mark.parametrize("existing_uv", [False, True, "incompatible"])
def test_bootstrap_prepares_uv_and_runs_valid_bundle_from_stdin(bootstrap_case, existing_uv):
    root, environment, _ = bootstrap_case
    candidate = Path(environment["UV_INSTALL_DIR"]) / "uv"
    if existing_uv is True:
        shutil.copyfile(environment["CRYSTAL_TEST_UV"], candidate)
        candidate.chmod(0o755)
    elif existing_uv == "incompatible":
        candidate.write_text("#!/bin/sh\nexit 0\n")
        candidate.chmod(0o755)
    result = run_bootstrap(bootstrap_case, pipe=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (root / "installed").is_file()
    assert (root / "uv-installed").exists() == (existing_uv is not True)
    assert not any((root / "commands" / name).exists() for name in ("python", "git", "bun"))


@pytest.mark.parametrize("failure", ["download", "installer"])
def test_bootstrap_propagates_failures_and_cleans_only_its_temporary_files(bootstrap_case, failure):
    root, environment, _ = bootstrap_case
    if failure == "download":
        environment["CRYSTAL_TEST_DOWNLOAD_FAILURE"] = "1"
    else:
        environment["CRYSTAL_TEST_INSTALL_EXIT"] = "23"
    result = run_bootstrap(bootstrap_case)
    assert result.returncode == (22 if failure == "download" else 23)
    assert (root / "installed").exists() == (failure == "installer")


@pytest.mark.parametrize("bad_path", [
    "../escaped.sh", "/CrystalSketch/absolute.sh", "CrystalSketch/../escaped.sh",
    "CrystalSketch/..", "CrystalSketch\\escape.sh", "CrystalSketch/C:escape.sh",
    "CrystalSketch/INSTALL.SH", "CrystalSketch/install.sh", "CrystalSketch/nested/file",
    "CrystalSketch/other.whl", "CrystalSketch/crystalsketch-0.0.1-py3-none-any.whl",
])
def test_bootstrap_rejects_unsafe_or_ambiguous_bundles(bootstrap_case, bad_path):
    root, environment, _ = bootstrap_case
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Duplicate name:", category=UserWarning)
        with zipfile.ZipFile(environment["CRYSTAL_TEST_ARCHIVE"], "a") as archive:
            archive.writestr(bad_path, "unexpected")
    result = run_bootstrap(bootstrap_case)
    assert result.returncode != 0
    assert "Invalid CrystalSketch installation bundle" in result.stderr
    assert not (root / "installed").exists()
    assert not (root / "escaped.sh").exists()


@pytest.mark.parametrize("problem", [
    "missing-wheel", "missing-installer", "empty-wheel", "empty-installer",
    "symlink", "crc", "size", "count", "not-zip",
])
def test_bootstrap_checks_archive_before_executing_any_installer(bootstrap_case, problem):
    root, environment, _ = bootstrap_case
    path = Path(environment["CRYSTAL_TEST_ARCHIVE"])
    if problem.startswith(("missing-", "empty-")):
        target = WHEEL if problem.endswith("wheel") else "CrystalSketch/install.sh"
        with zipfile.ZipFile(path) as archive:
            entries = [
                (item.filename, b"" if item.filename == target else archive.read(item))
                for item in archive.infolist()
                if not (problem.startswith("missing-") and item.filename == target)
            ]
        with zipfile.ZipFile(path, "w") as archive:
            for name, content in entries:
                archive.writestr(name, content)
    elif problem == "symlink":
        with zipfile.ZipFile(path, "a") as archive:
            entry = zipfile.ZipInfo("CrystalSketch/link")
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(entry, "../outside")
    elif problem == "count":
        with zipfile.ZipFile(path, "a") as archive:
            for index in range(98):
                archive.writestr(f"CrystalSketch/file{index}.txt", "")
    elif problem == "not-zip":
        path.write_bytes(b"not a ZIP")
    else:
        contents = bytearray(path.read_bytes())
        if problem == "crc":
            name_size, extra_size = struct.unpack_from("<HH", contents, 26)
            contents[30 + name_size + extra_size] ^= 1
        else:
            central = contents.index(b"PK\x01\x02")
            struct.pack_into("<I", contents, central + 24, 128 * 1024 * 1024 + 1)
        path.write_bytes(contents)
    result = run_bootstrap(bootstrap_case)
    assert result.returncode != 0
    assert "Invalid CrystalSketch installation bundle" in result.stderr
    assert not (root / "installed").exists()
