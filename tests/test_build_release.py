from __future__ import annotations

import importlib.util
import io
import tarfile
import zipfile
from pathlib import Path

import pytest


def _load_build_release_module():
    script_path = Path(__file__).parents[1] / "scripts" / "build_release.py"
    spec = importlib.util.spec_from_file_location("build_release", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_publish_release_artifacts_preserves_unrelated_destination_files(tmp_path: Path) -> None:
    build_release = _load_build_release_module()
    staging_dir = tmp_path / "staging"
    dist_dir = tmp_path / "shared-output"
    staging_dir.mkdir()
    dist_dir.mkdir()
    wheel = staging_dir / "crystalsketch-0.2.0-py3-none-any.whl"
    source_distribution = staging_dir / "crystalsketch-0.2.0.tar.gz"
    sentinel = dist_dir / "do-not-delete.txt"
    wheel.write_bytes(b"wheel")
    source_distribution.write_bytes(b"sdist")
    sentinel.write_text("keep me")

    build_release.publish_release_artifacts(staging_dir, dist_dir)

    assert (dist_dir / wheel.name).read_bytes() == b"wheel"
    assert (dist_dir / source_distribution.name).read_bytes() == b"sdist"
    assert sentinel.read_text() == "keep me"


def test_install_bundle_contains_wheel_launchers_and_user_instructions(tmp_path: Path) -> None:
    build_release = _load_build_release_module()
    wheel = tmp_path / "crystalsketch-0.2.0-py3-none-any.whl"
    wheel.write_bytes(b"wheel")

    build_release.create_install_bundle(wheel, tmp_path)

    with zipfile.ZipFile(tmp_path / "CrystalSketch.zip") as bundle:
        assert set(bundle.namelist()) == {
            f"CrystalSketch/{wheel.name}", "CrystalSketch/install.sh",
            "CrystalSketch/install.ps1", "CrystalSketch/README.md", "CrystalSketch/LICENSE",
            "CrystalSketch/THIRD_PARTY_NOTICES.md", "CrystalSketch/font-licenses.txt",
        }
        assert bundle.read(f"CrystalSketch/{wheel.name}") == b"wheel"
        assert bundle.read("CrystalSketch/install.ps1") == (
            Path(__file__).parents[1] / "scripts" / "install.ps1"
        ).read_bytes()


def _source_distribution(tmp_path: Path, paths: list[str]) -> Path:
    target = tmp_path / "crystalsketch-0.2.1.tar.gz"
    with tarfile.open(target, "w:gz") as archive:
        for path in paths:
            entry = tarfile.TarInfo(f"crystalsketch-0.2.1/{path}")
            entry.size = 7
            archive.addfile(entry, io.BytesIO(b"content"))
    return target


def test_source_distribution_accepts_frontend_sources_patch_and_bundled_static(
    tmp_path: Path,
) -> None:
    build_release = _load_build_release_module()
    source_distribution = _source_distribution(tmp_path, [
        "pyproject.toml", "web/package.json", "web/bun.lock", "web/src/app/App.tsx",
        "web/patches/three-gpu-pathtracer@0.0.23.patch",
        "src/crystalsketch/web_static/index.html",
        "src/crystalsketch/web_static/assets/pathTracingBVH.worker.js",
    ])
    build_release.verify_source_distribution(source_distribution)


@pytest.mark.parametrize("path", [
    "web/node_modules/three/package.json", "web/dist/index.html", ".venv/pyvenv.cfg",
    "src/crystalsketch/__pycache__/cli.pyc", ".pytest_cache/v/cache/nodeids",
])
def test_source_distribution_rejects_generated_development_files(tmp_path: Path, path: str) -> None:
    build_release = _load_build_release_module()
    source_distribution = _source_distribution(tmp_path, ["pyproject.toml", path])
    with pytest.raises(SystemExit, match="development output entries") as error:
        build_release.verify_source_distribution(source_distribution)
    assert path in str(error.value)
