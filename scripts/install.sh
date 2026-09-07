#!/usr/bin/env bash
set -euo pipefail

crystal_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
shopt -s nullglob
crystal_wheels=("$crystal_dir"/crystalsketch-*.whl)
crystal_root="$(dirname -- "$crystal_dir")"
if [[ ${#crystal_wheels[@]} -eq 0 && ! -f "$crystal_root/pyproject.toml" ]]; then
    echo "请先解压完整的安装包，或从 CrystalSketch 仓库运行此脚本。" >&2
    exit 1
fi

if command -v uv >/dev/null 2>&1; then
    crystal_uv="$(command -v uv)"
elif [[ -x "$HOME/.local/bin/uv" ]]; then
    crystal_uv="$HOME/.local/bin/uv"
else
    echo "正在准备安装工具……"
    # Official standalone installer; Python is not required to bootstrap uv.
    crystal_uv_dir="${UV_INSTALL_DIR:-$HOME/.local/bin}"
    curl --fail --silent --show-error --location https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$crystal_uv_dir" sh
    crystal_uv="$crystal_uv_dir/uv"
    if [[ ! -x "$crystal_uv" ]]; then
        echo "未找到 uv，请检查安装工具上方的输出。" >&2
        exit 1
    fi
fi

export PATH="$(dirname -- "$crystal_uv"):$PATH"
if [[ ${#crystal_wheels[@]} -eq 0 ]]; then
    echo "正在从仓库安装 CrystalSketch……"
    crystal_bun_dir="${BUN_INSTALL:-$HOME/.bun}/bin"
    if ! command -v bun >/dev/null 2>&1; then
        if [[ ! -x "$crystal_bun_dir/bun" ]]; then
            curl --fail --silent --show-error --location https://bun.com/install | bash -s "bun-v1.3.13"
        fi
        export PATH="$crystal_bun_dir:$PATH"
    fi
    cd -- "$crystal_root"
    "$crystal_uv" run --python 3.12 --locked python scripts/build_release.py
    crystal_wheels=("$crystal_root"/dist/crystalsketch-*.whl)
fi

if [[ ${#crystal_wheels[@]} -eq 0 ]]; then
    echo "未找到安装文件，请检查上方的构建输出。" >&2
    exit 1
fi
crystal_wheel="${crystal_wheels[0]}"
for candidate in "${crystal_wheels[@]}"; do
    if [[ "$candidate" -nt "$crystal_wheel" ]]; then crystal_wheel="$candidate"; fi
done
"$crystal_uv" tool install --python 3.12 --reinstall-package crystalsketch "$crystal_wheel"
"$crystal_uv" tool update-shell
echo "安装完成。重新打开终端，输入 Crystal 即可启动并自动打开浏览器。"
