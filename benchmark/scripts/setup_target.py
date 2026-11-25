#!/usr/bin/env python3
"""
Sets up benchmark/target from scratch:
  1. Clones https://github.com/fandango-fuzzer/fandango.git into benchmark/target (or fetches if existing).
  2. Checks out the target commit d06277caa78a64816e74afc3085be193c64cf434.
  3. Injects the parse_string entrypoint into src/fandango/language/parse/parse.py.
  4. Copies all 5 benchmark harnesses and .nano.json5 configs into benchmark/target/.
  5. Creates benchmark/target/.venv and installs requirements + editable package.
  6. Copies NaNofuzz runtime package into the virtual environment.
  7. Invokes setup_worktrees.py to initialize worktrees w1-w9.
"""

import glob
import os
import shutil
import subprocess
import sys

TARGET_REPO_URL = "https://github.com/fandango-fuzzer/fandango.git"
TARGET_COMMIT = "d06277caa78a64816e74afc3085be193c64cf434"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BENCHMARK_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
WORKSPACE_ROOT = os.path.abspath(os.path.join(BENCHMARK_DIR, ".."))
TARGET_DIR = os.path.join(BENCHMARK_DIR, "target")
HARNESSES_DIR = os.path.join(BENCHMARK_DIR, "harnesses")
TARGET_VENV = os.path.join(TARGET_DIR, ".venv")
VENV_PYTHON = os.path.join(TARGET_VENV, "bin", "python")
VENV_PIP = os.path.join(TARGET_VENV, "bin", "pip")

PARSE_PY_PATH = os.path.join(TARGET_DIR, "src", "fandango", "language", "parse", "parse.py")

PARSE_STRING_SNIPPET = '''

def parse_string(
    spec: str | list[str],
    constraints: Optional[list[str]] = None,
    *,
    use_stdlib: bool = True,
    check: bool = True,
    start_symbol: Optional[str] = None,
) -> tuple[Optional[Grammar], list[Constraint | SoftValue]]:
    """
    Convenience wrapper around parse() accepting grammar specification as a string or list of strings.
    """
    return parse(
        spec,
        constraints,
        use_stdlib=use_stdlib,
        check=check,
        start_symbol=start_symbol,
    )
'''


def run_cmd(cmd, cwd=None, check=True):
    print(f"--> {' '.join(cmd)}" if isinstance(cmd, list) else f"--> {cmd}")
    return subprocess.run(cmd, cwd=cwd, check=check)


def setup_target_repo():
    if not os.path.exists(TARGET_DIR):
        print(f"[1/7] Cloning Fandango into {TARGET_DIR}...")
        run_cmd(["git", "clone", TARGET_REPO_URL, TARGET_DIR])
    else:
        print(f"[1/7] Found existing repo at {TARGET_DIR}. Fetching origin...")
        run_cmd(["git", "fetch", "origin"], cwd=TARGET_DIR)

    print(f"[2/7] Checking out commit {TARGET_COMMIT}...")
    run_cmd(["git", "checkout", "-f", TARGET_COMMIT], cwd=TARGET_DIR)


def inject_parse_string():
    print(f"[3/7] Injecting parse_string entrypoint into {PARSE_PY_PATH}...")
    if not os.path.exists(PARSE_PY_PATH):
        raise FileNotFoundError(f"Target file not found: {PARSE_PY_PATH}")

    with open(PARSE_PY_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    if "def parse_string(" not in content:
        with open(PARSE_PY_PATH, "a", encoding="utf-8") as f:
            f.write(PARSE_STRING_SNIPPET)
        print("  ✓ parse_string appended to parse.py")
    else:
        print("  ✓ parse_string already present in parse.py")


def copy_harnesses():
    print(f"[4/7] Copying benchmark harnesses and nano.json5 configs into {TARGET_DIR}...")
    if not os.path.exists(HARNESSES_DIR):
        raise FileNotFoundError(f"Harnesses directory not found: {HARNESSES_DIR}")

    files_to_copy = glob.glob(os.path.join(HARNESSES_DIR, "nanofuzz_harness_*"))
    for src in files_to_copy:
        dst = os.path.join(TARGET_DIR, os.path.basename(src))
        shutil.copy2(src, dst)
        print(f"  ✓ Copied {os.path.basename(src)}")


def setup_venv():
    print(f"[5/7] Setting up Python virtual environment at {TARGET_VENV}...")
    use_uv = shutil.which("uv") is not None

    if not os.path.exists(TARGET_VENV):
        if use_uv:
            print("  Creating venv via uv...")
            run_cmd(["uv", "venv", TARGET_VENV, "--python", "3.12"])
        else:
            run_cmd([sys.executable, "-m", "venv", TARGET_VENV])

    extra_pkgs = ["msgpack", "pandas", "scipy", "pytest", "coverage", "hypothesis"]

    if use_uv:
        print("  Installing Fandango and benchmark dependencies via uv pip...")
        run_cmd(["uv", "pip", "install", "-p", VENV_PYTHON, "-e", "."] + extra_pkgs, cwd=TARGET_DIR)
    else:
        # Fallback to python -m pip
        run_cmd([VENV_PYTHON, "-m", "ensurepip", "--upgrade"], check=False)
        run_cmd([VENV_PYTHON, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"])
        run_cmd([VENV_PYTHON, "-m", "pip", "install", "-e", "."], cwd=TARGET_DIR)
        run_cmd([VENV_PYTHON, "-m", "pip", "install"] + extra_pkgs)


def install_nanofuzz_runtime():
    print("[6/7] Installing NaNofuzz Python runtime into .venv...")
    runtime_dir = os.path.join(WORKSPACE_ROOT, "packages", "runtime", "python")
    use_uv = shutil.which("uv") is not None

    if os.path.exists(os.path.join(runtime_dir, "pyproject.toml")) or os.path.exists(os.path.join(runtime_dir, "setup.py")):
        if use_uv:
            run_cmd(["uv", "pip", "install", "-p", VENV_PYTHON, "-e", "."], cwd=runtime_dir)
        else:
            run_cmd([VENV_PYTHON, "-m", "pip", "install", "-e", "."], cwd=runtime_dir)
    else:
        runtime_src = os.path.join(runtime_dir, "src")
        site_packages = glob.glob(os.path.join(TARGET_VENV, "lib", "python*", "site-packages"))
        if site_packages and os.path.exists(runtime_src):
            sp = site_packages[0]
            pth_file = os.path.join(sp, "nanofuzz_runtime.pth")
            with open(pth_file, "w", encoding="utf-8") as f:
                f.write(runtime_src + "\n")
            print(f"  ✓ Linked runtime via {pth_file} -> {runtime_src}")


def setup_all_worktrees():
    print("[7/7] Initializing Git worktrees...")
    setup_wt_script = os.path.join(SCRIPT_DIR, "setup_worktrees.py")
    if os.path.exists(setup_wt_script):
        run_cmd([sys.executable, setup_wt_script])


def main():
    print("=================================================================")
    print("           Setting up Benchmark Target (Fandango v1.3.1)         ")
    print("=================================================================")
    setup_target_repo()
    inject_parse_string()
    copy_harnesses()
    setup_venv()
    install_nanofuzz_runtime()
    setup_all_worktrees()
    print("\n[SUCCESS] Benchmark target setup complete and ready to run.")


if __name__ == "__main__":
    main()
