"""Synchronize package metadata before building the Python runtime."""

from __future__ import annotations

import json
import shutil
import tomllib
from pathlib import Path


PACKAGE_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = PACKAGE_DIR.parents[2]


def _release_version(version: str) -> str:
    """Return the major, minor, and patch portion used by the npm runtime check."""
    return version.split("-", 1)[0]


def sync_package_metadata(
    repository_root: Path = REPOSITORY_ROOT,
    package_dir: Path = PACKAGE_DIR,
) -> None:
    """Verify package versions and copy the repository license into the package."""
    root_package = json.loads((repository_root / "package.json").read_text())
    with (package_dir / "pyproject.toml").open("rb") as pyproject_file:
        python_package = tomllib.load(pyproject_file)

    root_version = _release_version(root_package["version"])
    python_version = _release_version(python_package["project"]["version"])
    if python_version != root_version:
        raise RuntimeError(
            "Package versions are not the same! "
            f"Package: {root_version}; Python runtime: {python_version}"
        )

    shutil.copyfile(repository_root / "LICENSE", package_dir / "LICENSE")
    print("Package versions match")
    print("Copied repository license")


if __name__ == "__main__":
    sync_package_metadata()
