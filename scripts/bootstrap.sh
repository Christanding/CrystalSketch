#!/usr/bin/env bash

# Keep execution inside a complete function so a truncated piped download cannot install anything.
crystalsketch_bootstrap() (
    set -euo pipefail
    if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
        printf '%s\n' 'Download the official CrystalSketch release and run its existing installer.' \
            'Usage: bash bootstrap.sh (macOS / Linux; requires HTTPS access and curl)' \
            'Python and uv are prepared automatically. Git, Bun and unzip are not required.'
        return
    fi
    if [[ $# -ne 0 ]]; then
        printf '%s\n' 'Unsupported argument. Use --help for usage.' >&2
        return 1
    fi
    case "$(uname -s)" in
        Darwin|Linux) ;;
        *) printf '%s\n' 'Use bootstrap.ps1 on Windows.' >&2; return 1 ;;
    esac
    if ! command -v curl >/dev/null 2>&1; then
        printf '%s\n' 'A system HTTPS downloader (curl) is required to obtain the installer.' >&2
        return 1
    fi

    local crystal_tmp crystal_uv crystal_uv_dir crystal_run_help crystal_tool_help
    crystal_tmp="$(mktemp -d "${TMPDIR:-/tmp}/crystalsketch-install.XXXXXXXX")"
    trap 'rm -rf -- "$crystal_tmp"' EXIT
    printf '%s\n' '正在下载 CrystalSketch 官方安装包……'
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --retry 2 --connect-timeout 20 --max-time 300 \
        --output "$crystal_tmp/CrystalSketch.zip" \
        https://github.com/Christanding/CrystalSketch/releases/latest/download/CrystalSketch.zip

    crystal_uv_dir="${UV_UNMANAGED_INSTALL:-${UV_INSTALL_DIR:-$HOME/.local/bin}}"
    if [[ -n "${UV_UNMANAGED_INSTALL:-}${UV_INSTALL_DIR:-}" ]]; then
        crystal_uv="$crystal_uv_dir/uv"
    else
        crystal_uv="$(command -v uv || true)"
        crystal_uv="${crystal_uv:-$crystal_uv_dir/uv}"
    fi
    crystal_run_help="$("$crystal_uv" run --help 2>/dev/null || true)"
    crystal_tool_help="$("$crystal_uv" tool install --help 2>/dev/null || true)"
    if [[ "$crystal_run_help" != *--no-project* || "$crystal_tool_help" != *--reinstall-package* ]] \
        || ! "$crystal_uv" python --help >/dev/null 2>&1; then
        printf '%s\n' '正在准备兼容的 uv 安装工具……'
        curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
            --retry 2 --connect-timeout 20 --max-time 120 \
            --output "$crystal_tmp/uv-install.sh" https://astral.sh/uv/install.sh
        UV_INSTALL_DIR="$crystal_uv_dir" sh "$crystal_tmp/uv-install.sh"
        crystal_uv="$crystal_uv_dir/uv"
    fi
    if [[ ! -x "$crystal_uv" ]]; then
        printf '%s\n' 'uv installation failed. Check the download and installer output above.' >&2
        return 1
    fi
    PATH="$(dirname -- "$crystal_uv"):$PATH"
    export PATH

    # uv supplies Python if missing; the standard library avoids an unzip prerequisite.
    printf '%s\n' '正在准备 Python 并检查安装包……'
    "$crystal_uv" run --no-config --no-project --python 3.12 python - \
        "$crystal_tmp/CrystalSketch.zip" "$crystal_tmp" <<'PY'
import re
import stat
import sys
import zipfile
from pathlib import Path

archive, destination = map(Path, sys.argv[1:])
limit = 128 * 1024 * 1024
try:
    if archive.stat().st_size > limit:
        raise ValueError("archive exceeds 128 MiB")
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if not entries or len(entries) > 100 or sum(item.file_size for item in entries) > limit:
            raise ValueError("invalid archive size")
        seen, files = set(), set()
        for entry in entries:
            name = entry.filename
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if name.casefold() in seen or kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError("duplicate or non-regular archive entry")
            seen.add(name.casefold())
            if name == "CrystalSketch/" and entry.is_dir():
                continue
            if (not re.fullmatch(r"CrystalSketch/[A-Za-z0-9_.+-]+", name)
                    or name.split("/")[1] in (".", "..") or entry.is_dir()
                    or kind == stat.S_IFDIR or entry.flag_bits & 1):
                raise ValueError("invalid archive path")
            if entry.file_size == 0 and (name in ("CrystalSketch/install.sh", "CrystalSketch/install.ps1")
                                         or name.lower().endswith(".whl")):
                raise ValueError("empty installation file")
            files.add(name)
        wheels = [name for name in files if name.lower().endswith(".whl")]
        if (not {"CrystalSketch/install.sh", "CrystalSketch/install.ps1"} <= files
                or len(wheels) != 1
                or not re.fullmatch(r"CrystalSketch/crystalsketch-[0-9][A-Za-z0-9_.+-]*-py3-none-any\.whl", wheels[0])):
            raise ValueError("missing or ambiguous installation files")
        if bundle.testzip() is not None:
            raise ValueError("archive checksum failed")
        bundle.extractall(destination)
except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as error:
    raise SystemExit(f"Invalid CrystalSketch installation bundle: {error}") from None
PY
    bash "$crystal_tmp/CrystalSketch/install.sh"
)

crystalsketch_bootstrap "$@"
