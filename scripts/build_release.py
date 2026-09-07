from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = PROJECT_ROOT / "web"
WEB_DIST = WEB_ROOT / "dist"
STATIC_ROOT = PROJECT_ROOT / "src" / "crystalsketch" / "web_static"
DEFAULT_DIST_DIR = PROJECT_ROOT / "dist"


def main() -> None:
    args = parse_args()
    dist_dir = args.dist_dir.resolve()

    require_command("bun")
    require_command("uv")

    if not args.skip_bun_install:
        run(["bun", "install", "--frozen-lockfile"], cwd=WEB_ROOT)

    run(["bun", "run", "build"], cwd=WEB_ROOT)
    copy_web_dist()

    with tempfile.TemporaryDirectory(prefix="crystalsketch-build-") as staging_dir_name:
        staging_dir = Path(staging_dir_name)
        run(["uv", "build", "--out-dir", str(staging_dir)], cwd=PROJECT_ROOT)
        wheel_path = newest_wheel(staging_dir)
        verify_wheel_static_assets(wheel_path)
        publish_release_artifacts(staging_dir, dist_dir)
        create_install_bundle(wheel_path, dist_dir)
    if not args.keep_web_static:
        clean_web_static()

    print()
    print(f"Built release artifacts in {dist_dir}:")
    for artifact in sorted(dist_dir.iterdir()):
        if artifact.suffix in {".whl", ".gz", ".zip"}:
            print(f"  {artifact.name}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build the CrystalSketch frontend, bundle it into the Python package, "
            "and create verified release artifacts."
        )
    )
    parser.add_argument(
        "--dist-dir",
        type=Path,
        default=DEFAULT_DIST_DIR,
        help="Directory for Python release artifacts. Defaults to ./dist.",
    )
    parser.add_argument(
        "--skip-bun-install",
        action="store_true",
        help="Skip `bun install --frozen-lockfile` before building the frontend.",
    )
    parser.add_argument(
        "--keep-web-static",
        action="store_true",
        help="Keep generated files in src/crystalsketch/web_static after a successful build.",
    )
    return parser.parse_args()


def require_command(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f"Required command not found on PATH: {name}")


def run(command: list[str], cwd: Path) -> None:
    print(f"$ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def copy_web_dist() -> None:
    index_file = WEB_DIST / "index.html"
    assets_dir = WEB_DIST / "assets"
    if not index_file.is_file() or not assets_dir.is_dir():
        raise SystemExit(
            "Frontend build did not produce web/dist/index.html and web/dist/assets/."
        )

    if STATIC_ROOT.exists():
        shutil.rmtree(STATIC_ROOT)
    STATIC_ROOT.mkdir(parents=True)

    for item in WEB_DIST.iterdir():
        target = STATIC_ROOT / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)

    shutil.copy2(PROJECT_ROOT / "THIRD_PARTY_NOTICES.md", STATIC_ROOT / "THIRD_PARTY_NOTICES.md")

    print(
        f"Copied {WEB_DIST.relative_to(PROJECT_ROOT)} to {STATIC_ROOT.relative_to(PROJECT_ROOT)}",
        flush=True,
    )


def clean_web_static() -> None:
    if STATIC_ROOT.exists():
        shutil.rmtree(STATIC_ROOT)
    STATIC_ROOT.mkdir(parents=True, exist_ok=True)
    print(f"Cleaned generated files from {STATIC_ROOT.relative_to(PROJECT_ROOT)}", flush=True)


def newest_wheel(dist_dir: Path) -> Path:
    wheels = sorted(dist_dir.glob("*.whl"), key=lambda path: path.stat().st_mtime)
    if not wheels:
        raise SystemExit(f"No wheel found in {dist_dir}")
    return wheels[-1]


def publish_release_artifacts(staging_dir: Path, dist_dir: Path) -> None:
    artifacts = [
        artifact
        for artifact in staging_dir.iterdir()
        if artifact.is_file() and artifact.suffix in {".whl", ".gz"}
    ]
    if not artifacts:
        raise SystemExit(f"No release artifacts found in {staging_dir}")

    dist_dir.mkdir(parents=True, exist_ok=True)
    for artifact in artifacts:
        shutil.copy2(artifact, dist_dir / artifact.name)


def create_install_bundle(wheel_path: Path, dist_dir: Path) -> None:
    with zipfile.ZipFile(dist_dir / "CrystalSketch.zip", "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.write(wheel_path, f"CrystalSketch/{wheel_path.name}")
        for name in ("install.sh", "install.ps1"):
            bundle.write(PROJECT_ROOT / "scripts" / name, f"CrystalSketch/{name}")
        for name in ("README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"):
            bundle.write(PROJECT_ROOT / name, f"CrystalSketch/{name}")
        bundle.write(WEB_ROOT / "public" / "font-licenses.txt", "CrystalSketch/font-licenses.txt")


def verify_wheel_static_assets(wheel_path: Path) -> None:
    with zipfile.ZipFile(wheel_path) as wheel:
        names = set(wheel.namelist())

    index_name = "crystalsketch/web_static/index.html"
    has_assets = any(name.startswith("crystalsketch/web_static/assets/") for name in names)
    missing: list[str] = []
    if index_name not in names:
        missing.append(index_name)
    if not has_assets:
        missing.append("crystalsketch/web_static/assets/")

    if missing:
        lines = "\n".join(f"  - {name}" for name in missing)
        raise SystemExit(f"Wheel is missing bundled frontend files:\n{lines}")

    print(f"Verified bundled frontend assets in {wheel_path.name}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        sys.exit(exc.returncode)
