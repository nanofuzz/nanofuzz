import importlib.util
import json
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).parents[1] / "prebuild.py"
SPEC = importlib.util.spec_from_file_location("python_runtime_prebuild", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
PREBUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREBUILD)


def _write_package_files(
    root: Path, package: Path, root_version: str, package_version: str
):
    root.mkdir()
    package.mkdir(parents=True)
    (root / "package.json").write_text(json.dumps({"version": root_version}))
    (root / "LICENSE").write_text("current license\n")
    (package / "pyproject.toml").write_text(
        f'[project]\nversion = "{package_version}"\n'
    )


def test_sync_package_metadata_copies_license(tmp_path):
    root = tmp_path / "repository"
    package = root / "packages" / "runtime" / "python"
    _write_package_files(root, package, "1.2.3-beta.1", "1.2.3")
    (package / "LICENSE").write_text("stale license\n")

    PREBUILD.sync_package_metadata(root, package)

    assert (package / "LICENSE").read_text() == "current license\n"


def test_sync_package_metadata_rejects_version_mismatch(tmp_path):
    root = tmp_path / "repository"
    package = root / "packages" / "runtime" / "python"
    _write_package_files(root, package, "1.2.3", "1.2.4")

    with pytest.raises(RuntimeError, match="Package versions are not the same"):
        PREBUILD.sync_package_metadata(root, package)
