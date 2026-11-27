#!/usr/bin/env python3
"""
Sets up concurrent Git worktrees (w1-w9) for benchmark participant runs.
Ensures worktrees point to the target commit and share the Python 3.12 .venv.
"""
import os
import subprocess
import sys

TARGET_COMMIT = "d06277caa78a64816e74afc3085be193c64cf434"
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SOURCE_REPO = os.path.join(BASE_DIR, "target")
WORKTREES_DIR = os.path.join(BASE_DIR, "worktrees")
SOURCE_VENV = os.path.join(SOURCE_REPO, ".venv")


def setup_worktrees(num_lanes=9):
    if not os.path.exists(SOURCE_REPO):
        print(f"Error: Target repository not found at {SOURCE_REPO}")
        sys.exit(1)

    if not os.path.exists(SOURCE_VENV):
        print(f"Error: Target .venv not found at {SOURCE_VENV}. Please create it first.")
        sys.exit(1)

    os.makedirs(WORKTREES_DIR, exist_ok=True)
    subprocess.run(["git", "-C", SOURCE_REPO, "worktree", "prune"], check=True)

    for lane in range(1, num_lanes + 1):
        wt = os.path.join(WORKTREES_DIR, f"w{lane}")
        if not os.path.exists(wt):
            print(f"Creating worktree w{lane}...")
            subprocess.run(
                ["git", "-C", SOURCE_REPO, "worktree", "add", "--force", "--detach", wt, TARGET_COMMIT],
                check=True,
            )
        else:
            print(f"Resetting worktree w{lane}...")
            subprocess.run(["git", "checkout", "--", "."], cwd=wt, check=True)
            subprocess.run(["git", "clean", "-fd"], cwd=wt, check=True)
            subprocess.run(["git", "checkout", "-q", TARGET_COMMIT], cwd=wt, check=True)

        venv_link = os.path.join(wt, ".venv")
        if os.path.islink(venv_link) or os.path.exists(venv_link):
            os.remove(venv_link)
        os.symlink(SOURCE_VENV, venv_link)
        print(f"  w{lane}: linked .venv -> {SOURCE_VENV}")

    print(f"\n[SUCCESS] Successfully initialized {num_lanes} worktrees in {WORKTREES_DIR}")


if __name__ == "__main__":
    setup_worktrees()
