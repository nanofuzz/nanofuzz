#!/usr/bin/env python3
import os
import sys

# Auto-re-execute using target .venv python if target venv is present and current interpreter lacks msgpack/pandas
_VENV_PY = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "target", ".venv", "bin", "python"))
if os.path.exists(_VENV_PY) and os.path.realpath(sys.executable) != os.path.realpath(_VENV_PY):
    try:
        import msgpack  # noqa: F401
        import pandas  # noqa: F401
    except ImportError:
        os.execv(_VENV_PY, [_VENV_PY] + sys.argv)

"""
NaNofuzz CLI Empirical Generator Evaluation Driver
Executes 6 canonical generator treatments (SCRAM, CR, R, RA, RM, SR) across 5 PUTs.

Design:
  - 10 Replicates x 6 Treatments x 5 Tasks = 300 Trials.
  - Multi-lane concurrent execution with hard timeouts.
  - Integer CPU allocation: workers = max(1, (total_cpus - unused_cpus) // lanes).
  - 15s randomized per-lane warmup runs prior to live trials.
  - Strict zero-guessing policy: missing or corrupt .mpk files fail the task immediately.
  - Dual defect detection: compares bug_interceptor events with harness companion validators.
  - Generates data.csv under benchmark/cli/<timestamp>/ and updates benchmark/cli/latest symlink.
"""

import argparse
import datetime
import glob
import json
import math
import multiprocessing
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

import msgpack
import pandas as pd

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BENCHMARK_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
WORKSPACE_ROOT = os.path.abspath(os.path.join(BENCHMARK_DIR, ".."))
CLI_BASE_DIR = os.path.join(BENCHMARK_DIR, "cli")
HARNESSES_DIR = os.path.join(BENCHMARK_DIR, "harnesses")
TARGET_DIR = os.path.join(BENCHMARK_DIR, "target")
WORKTREES_DIR = os.path.join(BENCHMARK_DIR, "worktrees")
TARGET_COVERAGE_PATH = os.path.join(SCRIPT_DIR, "target_coverage_files.json")
RUBRIC_PATH = os.path.join(SCRIPT_DIR, "ground_truth_rubric.json")
TREATMENTS_CONFIG_PATH = os.path.join(SCRIPT_DIR, "cli_treatments.json")
INTERCEPTOR_SCRIPT = os.path.join(SCRIPT_DIR, "bug_interceptor.py")

CLI_JS_PATH = os.path.join(WORKSPACE_ROOT, "build", "cli", "cli.cjs")

TASKS_MAP = {
    "make_def": {
        "harness": "nanofuzz_harness_make_def.py",
        "function": "fuzz_make_def",
        "relative_target": "src/fandango/language/stdlib.py",
        "branches_total": 8,
    },
    "TreeValue": {
        "harness": "nanofuzz_harness_TreeValue.py",
        "function": "fuzz_TreeValue",
        "relative_target": "src/fandango/language/tree_value.py",
        "branches_total": 124,
    },
    "_distance_norm": {
        "harness": "nanofuzz_harness__distance_norm.py",
        "function": "fuzz__distance_norm",
        "relative_target": "src/fandango/constraints/comparison.py",
        "branches_total": 54,
    },
    "parse": {
        "harness": "nanofuzz_harness_parse.py",
        "function": "fuzz_parse",
        "relative_target": "src/fandango/language/parse/parse.py",
        "branches_total": 122,
    },
    "DerivationTree": {
        "harness": "nanofuzz_harness_DerivationTree.py",
        "function": "fuzz_DerivationTree",
        "relative_target": "src/fandango/language/tree.py",
        "branches_total": 246,
    },
}

ALL_DEFECT_COLUMNS = [
    "SIGMOID_OVERFLOW", "NORM_ZERO_DIV", "NORM_NAN_PROPAGATE",
    "TV_EQ_NONE", "TV_HASH_CONTRACT", "TV_TO_INT_VAL", "TV_RADD_STR", "TV_ENCODING", "TV_DEEPCOPY_SHARED",
    "DT_TO_GRAMMAR_ASSERT", "DT_ROUNDTRIP", "DT_REPR_CRASH", "DT_PREFIX_SLICE", "DT_CHILD_SLICE", "DT_SLICE_PARENT_HIJACK",
    "PARSE_EMPTY_CONSTRAINT", "PARSE_LEXER_STALL", "PARSE_NAME_ERROR", "PARSE_SILENT_DROP", "PARSE_DESC_RECUR", "PARSE_EMPTY_FAN_FILES",
    "DEF_EMPTY_RHS", "DEF_UNICODE_CORRUPT", "DEF_HEX_OVERFLOW"
]


def load_json(path_str: str) -> dict:
    if not os.path.exists(path_str):
        raise FileNotFoundError(f"Required configuration file not found: {path_str}")
    with open(path_str, "r", encoding="utf-8") as f:
        return json.load(f)


def calculate_workers(lanes: int, unused_cpus: int, explicit_workers: Optional[int] = None) -> int:
    if explicit_workers is not None and explicit_workers >= 1:
        return int(explicit_workers)
    total_cpus = os.cpu_count() or 4
    effective_cpus = max(1, total_cpus - unused_cpus)
    workers_per_lane = max(1, effective_cpus // lanes)
    return int(workers_per_lane)


def seeded_shuffle(items: list, seed_val: str) -> list:
    rng = random.Random(seed_val)
    shuffled = list(items)
    rng.shuffle(shuffled)
    return shuffled


def setup_lane_worktree(lane_idx: int) -> str:
    wt_dir = os.path.join(WORKTREES_DIR, f"w{lane_idx}")
    if not os.path.exists(wt_dir):
        raise RuntimeError(f"Worktree directory for lane {lane_idx} not found at {wt_dir}. Run setup_worktrees.py first.")
    return wt_dir


def execute_nanofuzz_run(
    lane_idx: int,
    worktree_dir: str,
    harness_path: str,
    fn_name: str,
    config_file_path: str,
    cli_args: List[str],
    runtime_ms: int,
    output_mpk_path: str,
    workers: int,
    interceptor_log_path: str,
    target_rel_path: str,
    seed_str: str
) -> Tuple[int, float, str, str]:
    venv_bin = os.path.join(worktree_dir, ".venv", "bin")
    python_bin = os.path.join(venv_bin, "python")
    target_abs_path = os.path.join(worktree_dir, target_rel_path)

    cmd = [
        "node",
        "--max-old-space-size=8192",
        CLI_JS_PATH,
        harness_path,
        fn_name,
        "--config-file", config_file_path,
        "--output-file", output_mpk_path,
        "--max-runtime", str(runtime_ms),
        "--max-failures", "0",
        "--output-results", "all",
        "--workers", str(workers),
        "--seed", seed_str,
    ] + cli_args

    env = dict(os.environ)
    env["PATH"] = f"{venv_bin}:{env.get('PATH', '')}"
    env["VIRTUAL_ENV"] = os.path.join(worktree_dir, ".venv")
    env["PYTHONPATH"] = f"{os.path.join(worktree_dir, 'src')}:{SCRIPT_DIR}"
    env["NANOFUZZ_PROJECT_ROOT"] = worktree_dir
    env["NANOFUZZ_COVERAGE_INCLUDE_FILES"] = json.dumps([target_abs_path])
    env["NANOFUZZ_DYNAMIC_BUG_ELICITATION"] = "1"
    env["NANOFUZZ_ELICITATION_LOG"] = interceptor_log_path

    timeout_sec = (runtime_ms / 1000.0) + 20.0
    start_time = time.time()

    proc = subprocess.Popen(
        cmd,
        cwd=worktree_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        preexec_fn=os.setsid if sys.platform != "win32" else None
    )

    try:
        stdout, stderr = proc.communicate(timeout=timeout_sec)
        retcode = proc.returncode
    except subprocess.TimeoutExpired:
        if sys.platform != "win32":
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        else:
            proc.kill()
        stdout, stderr = proc.communicate()
        retcode = -9

    elapsed = time.time() - start_time
    return retcode, elapsed, stdout, stderr


def run_warmup_lane(lane_idx: int, worktree_dir: str, workers: int, warmup_cfg: dict, tasks_list: list):
    if not warmup_cfg.get("enabled", True):
        return

    runs_count = warmup_cfg.get("runsPerLane", 3)
    runtime_ms = warmup_cfg.get("runtimeMs", 15000)
    rng = random.Random(f"warmup_lane_{lane_idx}")
    selected_tasks = rng.sample(tasks_list, min(runs_count, len(tasks_list)))

    print(f"[Lane {lane_idx}] Warming up with {len(selected_tasks)} tasks ({runtime_ms//1000}s each)...")

    for task_name in selected_tasks:
        task_meta = TASKS_MAP[task_name]
        harness_file = os.path.join(HARNESSES_DIR, task_meta["harness"])
        cfg_file = os.path.join(HARNESSES_DIR, f"{task_meta['harness']}.nano.json5")
        tmp_mpk = f"/tmp/nanofuzz_warmup_l{lane_idx}_{task_name}.mpk"
        tmp_log = f"/tmp/nanofuzz_warmup_l{lane_idx}_{task_name}.json"

        execute_nanofuzz_run(
            lane_idx=lane_idx,
            worktree_dir=worktree_dir,
            harness_path=harness_file,
            fn_name=task_meta["function"],
            config_file_path=cfg_file,
            cli_args=["--no-ai-input-generator"],
            runtime_ms=runtime_ms,
            output_mpk_path=tmp_mpk,
            workers=workers,
            interceptor_log_path=tmp_log,
            target_rel_path=task_meta["relative_target"],
            seed_str=f"warmup_{lane_idx}_{task_name}"
        )

        for p in (tmp_mpk, tmp_log):
            if os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass

    print(f"[Lane {lane_idx}] Warmup completed.")


def process_trial_result(
    trial: dict,
    run_id: str,
    artifacts_dir: str,
    output_mpk_path: str,
    interceptor_log_path: str,
    stdout: str,
    stderr: str,
    retcode: int,
    elapsed_sec: float,
    rubric: dict
) -> dict:
    if not os.path.exists(output_mpk_path):
        raise RuntimeError(
            f"STRICT POLICY VIOLATION: Output file {output_mpk_path} not found for trial {run_id} "
            f"({trial['Task']} under {trial['Treatment']}). CLI exit code: {retcode}. Stderr: {stderr[:500]}"
        )

    with open(output_mpk_path, "rb") as f:
        data = msgpack.unpackb(f.read())

    stats = data.get("stats", {})
    counters = stats.get("counters", {})
    measures = stats.get("measures", {})

    total_tests = counters.get("passedTests", 0) + counters.get("failedTests", 0) + counters.get("erroredTests", 0)
    dupes_generated = counters.get("dupesGenerated", 0)
    inputs_skipped = counters.get("inputsSkipped", 0)
    stop_reason = str(data.get("stopReason", "unknown"))

    task_name = trial["Task"]
    task_meta = TASKS_MAP[task_name]
    expected_total_branches = task_meta["branches_total"]

    cov_measure = measures.get("CodeCoverageMeasure", {})
    cov_files = cov_measure.get("files", [])

    branches_covered = 0
    branches_total = expected_total_branches

    target_found = False
    for finfo in cov_files:
        fpath = finfo.get("path", "").replace("\\", "/")
        if task_meta["relative_target"] in fpath:
            fcounters = finfo.get("counters", {})
            branches_covered = fcounters.get("branchesCovered", 0)
            branches_total = fcounters.get("branchesTotal", expected_total_branches)
            target_found = True
            break

    if not target_found:
        target_norm = os.path.normpath(task_meta["relative_target"])
        for finfo in cov_files:
            if os.path.normpath(finfo.get("path", "")).endswith(target_norm):
                fcounters = finfo.get("counters", {})
                branches_covered = fcounters.get("branchesCovered", 0)
                branches_total = fcounters.get("branchesTotal", expected_total_branches)
                target_found = True
                break

    if not target_found:
        raise RuntimeError(
            f"STRICT POLICY VIOLATION: Target file {task_meta['relative_target']} not present in coverage files "
            f"for trial {run_id}. Files measured: {[f.get('path') for f in cov_files]}"
        )

    if branches_total != expected_total_branches:
        raise ValueError(
            f"STRICT POLICY VIOLATION: Branch denominator mismatch for {task_name} in {run_id}: "
            f"expected {expected_total_branches}, got {branches_total}."
        )

    branch_cov_pct = round((branches_covered / branches_total) * 100.0, 1) if branches_total > 0 else 0.0

    task_rubric_bugs = rubric.get("tasks", {}).get(task_name, {}).get("bugs", {})
    task_bug_count = len(task_rubric_bugs)

    interceptor_hits: Dict[str, dict] = {}
    if os.path.exists(interceptor_log_path):
        with open(interceptor_log_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    bid = entry.get("bug_id")
                    if bid in task_rubric_bugs:
                        interceptor_hits[bid] = entry
                except Exception:
                    pass

    # Extract validator outcomes from results
    validator_detected_bugs = set()
    raw_results = data.get("results", [])
    for r in raw_results:
        if r.get("passedValidator") == "fail" or r.get("exception"):
            # Check if this input matches a specific ground-truth bug
            for bid in task_rubric_bugs:
                if bid in interceptor_hits:
                    validator_detected_bugs.add(bid)

    defects_elicited_count = len(interceptor_hits)
    defects_detected_count = sum(1 for e in interceptor_hits.values() if e.get("detected") == 1)

    bug_elicitation_rate = round(defects_elicited_count / float(task_bug_count), 3) if task_bug_count > 0 else 0.0

    generators_chain = []
    for bid, ev in interceptor_hits.items():
        gen = ev.get("generator", "Unknown")
        generators_chain.append(f"{bid}:{gen}")
    eliciting_generators_str = ";".join(generators_chain)

    row = {
        "RunID": run_id,
        "Task": task_name,
        "Treatment": trial["Treatment"],
        "Replicate": trial["Replicate"],
        "Sequence": trial["Sequence"],
        "Date": datetime.date.today().isoformat(),
        "ElapsedSec": int(round(elapsed_sec)),
        "TotalTestsExecuted": total_tests,
        "DupesGenerated": dupes_generated,
        "InputsSkipped": inputs_skipped,
        "StopReason": stop_reason,
        "BranchCoveragePct": branch_cov_pct,
        "BranchesCovered": branches_covered,
        "BranchesTotal": branches_total,
        "TaskBugCount": task_bug_count,
        "BugsElicited": defects_elicited_count,
        "BugsDetected": defects_detected_count,
        "BugElicitationRate": bug_elicitation_rate,
        "ElicitingGenerators": eliciting_generators_str,
        "Status": "COMPLETED" if retcode == 0 or total_tests > 0 else "FAILED",
    }

    for b in ALL_DEFECT_COLUMNS:
        if b in task_rubric_bugs:
            elicited_val = 1 if b in interceptor_hits else 0
            row[b] = elicited_val
            row[f"{b}_Validator"] = 1 if (b in interceptor_hits and (b in validator_detected_bugs or interceptor_hits[b].get("detected") == 1)) else 0
        else:
            row[b] = "#N/A"
            row[f"{b}_Validator"] = "#N/A"

    return row


def lane_worker_loop(
    lane_idx: int,
    task_queue: multiprocessing.Queue,
    result_queue: multiprocessing.Queue,
    worktree_dir: str,
    workers: int,
    run_dir: str,
    rubric: dict,
    warmup_cfg: dict,
    treatments_cfg: dict
):
    try:
        run_warmup_lane(lane_idx, worktree_dir, workers, warmup_cfg, list(TASKS_MAP.keys()))

        while True:
            item = task_queue.get()
            if item is None:
                break

            run_id = item["RunID"]
            task_name = item["Task"]
            treatment_name = item["Treatment"]
            runtime_ms = treatments_cfg.get("runtimeMs", 180000)

            treatment_info = treatments_cfg["treatments"][treatment_name]
            cli_args = list(treatment_info.get("cliArgs", []))

            trial_artifact_dir = os.path.join(run_dir, "artifacts", run_id)
            os.makedirs(trial_artifact_dir, exist_ok=True)

            task_meta = TASKS_MAP[task_name]
            harness_path = os.path.join(HARNESSES_DIR, task_meta["harness"])
            config_file_path = os.path.join(HARNESSES_DIR, f"{task_meta['harness']}.nano.json5")
            output_mpk_path = os.path.join(trial_artifact_dir, f"{run_id}.mpk")
            interceptor_log_path = os.path.join(trial_artifact_dir, "elicited_bugs.json")

            seed_str = f"{item['Sequence']}_{run_id}_{task_name}_{treatment_name}"

            print(f"[Lane {lane_idx}] Starting {run_id}: {task_name} under {treatment_name} (Replicate {item['Replicate']})...")

            retcode, elapsed, stdout, stderr = execute_nanofuzz_run(
                lane_idx=lane_idx,
                worktree_dir=worktree_dir,
                harness_path=harness_path,
                fn_name=task_meta["function"],
                config_file_path=config_file_path,
                cli_args=cli_args,
                runtime_ms=runtime_ms,
                output_mpk_path=output_mpk_path,
                workers=workers,
                interceptor_log_path=interceptor_log_path,
                target_rel_path=task_meta["relative_target"],
                seed_str=seed_str
            )

            with open(os.path.join(trial_artifact_dir, "stdout.txt"), "w", encoding="utf-8") as f:
                f.write(stdout)
            with open(os.path.join(trial_artifact_dir, "stderr.txt"), "w", encoding="utf-8") as f:
                f.write(stderr)

            processed_row = process_trial_result(
                trial=item,
                run_id=run_id,
                artifacts_dir=trial_artifact_dir,
                output_mpk_path=output_mpk_path,
                interceptor_log_path=interceptor_log_path,
                stdout=stdout,
                stderr=stderr,
                retcode=retcode,
                elapsed_sec=elapsed,
                rubric=rubric
            )

            result_queue.put(processed_row)
            print(f"[Lane {lane_idx}] Finished {run_id} in {elapsed:.1f}s | Cov: {processed_row['BranchCoveragePct']}% | Elicited: {processed_row['BugsElicited']}/{processed_row['TaskBugCount']}")

    except Exception as exc:
        print(f"[Lane {lane_idx} ERROR]: {exc}", file=sys.stderr)
        result_queue.put({"ERROR": str(exc), "Lane": lane_idx})


def update_latest_symlink(run_dir: str):
    latest_symlink = os.path.join(CLI_BASE_DIR, "latest")
    try:
        if os.path.islink(latest_symlink) or os.path.exists(latest_symlink):
            os.remove(latest_symlink)
        rel_target = os.path.basename(run_dir)
        os.symlink(rel_target, latest_symlink)
        print(f"[SYMLINK] Updated {latest_symlink} -> {rel_target}")
    except Exception as e:
        print(f"[WARN] Failed to update latest symlink: {e}")


def main():
    parser = argparse.ArgumentParser(description="NaNofuzz CLI Empirical Factorial Study Driver")
    parser.add_argument("--lanes", type=int, default=4, help="Number of concurrent execution lanes (default: 4)")
    parser.add_argument("--unused-cpus", type=int, default=2, help="Number of host CPUs reserved (default: 2)")
    parser.add_argument("--workers", type=int, default=None, help="Explicit workers per lane (default: computed)")
    parser.add_argument("--replicates", type=int, default=10, help="Replicates per condition (default: 10)")
    parser.add_argument("--resume", type=str, default=None, help="Resume an existing run directory")
    args = parser.parse_args()

    workers_per_lane = calculate_workers(args.lanes, args.unused_cpus, args.workers)
    print(f"[HARDWARE] Total Host CPUs: {os.cpu_count()}, Unused CPUs: {args.unused_cpus}")
    print(f"[ALLOCATION] Concurrency: {args.lanes} lanes x {workers_per_lane} workers/lane = {args.lanes * workers_per_lane} active worker processes")

    treatments_cfg = load_json(TREATMENTS_CONFIG_PATH)
    rubric = load_json(RUBRIC_PATH)

    replicates = args.replicates
    canonical_treatments = list(treatments_cfg["treatments"].keys())
    tasks_list = treatments_cfg.get("tasks", list(TASKS_MAP.keys()))

    if args.resume:
        run_dir = os.path.abspath(args.resume)
        if not os.path.isdir(run_dir):
            raise FileNotFoundError(f"Resume directory not found: {run_dir}")
        print(f"[RESUME] Resuming benchmark in: {run_dir}")
    else:
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        run_dir = os.path.join(CLI_BASE_DIR, timestamp)
        os.makedirs(os.path.join(run_dir, "artifacts"), exist_ok=True)
        print(f"[START] Starting new benchmark in: {run_dir}")

    update_latest_symlink(run_dir)

    data_csv_path = os.path.join(run_dir, "data.csv")
    completed_runs = {}

    if os.path.exists(data_csv_path):
        existing_df = pd.read_csv(data_csv_path)
        for _, r in existing_df.iterrows():
            if r.get("Status") == "COMPLETED":
                completed_runs[r["RunID"]] = r.to_dict()
        print(f"[RESUME] Found {len(completed_runs)} already completed trials in {data_csv_path}")

    # Build factorial schedule
    schedule_items = []
    for rep in range(1, replicates + 1):
        for tr in canonical_treatments:
            for tsk in tasks_list:
                schedule_items.append({
                    "Task": tsk,
                    "Treatment": tr,
                    "Replicate": rep,
                })

    shuffled_schedule = seeded_shuffle(schedule_items, treatments_cfg.get("randomSeed", "qwertonyuiop"))

    full_trial_list = []
    for idx, item in enumerate(shuffled_schedule):
        run_id = f"R{idx+1:03d}"
        item["RunID"] = run_id
        item["Sequence"] = idx + 1
        full_trial_list.append(item)

    pending_trials = [t for t in full_trial_list if t["RunID"] not in completed_runs]
    print(f"[SCHEDULE] Total Factorial Matrix: {len(full_trial_list)} trials. Remaining to execute: {len(pending_trials)}")

    if not pending_trials:
        print("[COMPLETE] All trials have already been executed!")
        sys.exit(0)

    # Initialize worktrees for each lane
    for lane in range(1, args.lanes + 1):
        setup_lane_worktree(lane)

    task_queue = multiprocessing.Queue()
    result_queue = multiprocessing.Queue()

    for trial in pending_trials:
        task_queue.put(trial)

    for _ in range(args.lanes):
        task_queue.put(None)

    workers_processes = []
    for lane in range(1, args.lanes + 1):
        wt_dir = os.path.join(WORKTREES_DIR, f"w{lane}")
        p = multiprocessing.Process(
            target=lane_worker_loop,
            args=(
                lane,
                task_queue,
                result_queue,
                wt_dir,
                workers_per_lane,
                run_dir,
                rubric,
                treatments_cfg.get("warmup", {}),
                treatments_cfg
            )
        )
        p.start()
        workers_processes.append(p)

    results_rows = list(completed_runs.values())
    pending_count = len(pending_trials)

    def write_csv():
        if results_rows:
            df = pd.DataFrame(results_rows)
            df = df.sort_values(by="Sequence")
            df.to_csv(data_csv_path, index=False)

    try:
        while pending_count > 0:
            res = result_queue.get()
            if "ERROR" in res:
                print(f"[FATAL ERROR IN WORKER]: {res['ERROR']}", file=sys.stderr)
                for p in workers_processes:
                    p.terminate()
                sys.exit(1)

            results_rows.append(res)
            write_csv()
            pending_count -= 1
            print(f"[PROGRESS] Completed {len(results_rows)} / {len(full_trial_list)} trials.")

    finally:
        for p in workers_processes:
            p.join(timeout=5)
        write_csv()

    print(f"\n[DONE] Experiment run successfully completed. Dataset written to:\n  {data_csv_path}")


if __name__ == "__main__":
    main()
