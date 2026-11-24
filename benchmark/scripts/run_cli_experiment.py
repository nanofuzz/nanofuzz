#!/usr/bin/env python3
import argparse
import datetime
import json
import multiprocessing
import os
import random
import shutil
import signal
import subprocess
import sys
import time
from typing import Any

# Auto-re-execute using target .venv python if target venv is present and current interpreter lacks msgpack/pandas
_VENV_PY = os.path.abspath(os.path.join(os.path.dirname(
    __file__), "..", "target", ".venv", "bin", "python"))
if os.path.exists(_VENV_PY) and os.path.realpath(sys.executable) != os.path.realpath(_VENV_PY):
    try:
        import msgpack
        import pandas  # noqa: F401
    except ImportError:
        os.execv(_VENV_PY, [_VENV_PY] + sys.argv)

import msgpack
import pandas as pd

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
    "SIGMOID_OVERFLOW", "NORM_NAN_PROPAGATE",
    "TV_EQ_NONE", "TV_HASH_CONTRACT", "TV_TO_INT_VAL", "TV_RADD_STR", "TV_ENCODING", "TV_DEEPCOPY_SHARED",
    "DT_TO_GRAMMAR_ASSERT", "DT_ROUNDTRIP", "DT_REPR_CRASH", "DT_PREFIX_SLICE", "DT_CHILD_SLICE", "DT_SLICE_PARENT_MUT",
    "PARSE_EMPTY_CONSTRAINT", "PARSE_NAME_ERROR", "PARSE_SILENT_DROP", "PARSE_DESC_RECUR", "PARSE_EMPTY_FAN_FILES",
    "DEF_EMPTY_RHS", "DEF_UNICODE_CORRUPT", "DEF_HEX_OVERFLOW"
]


def load_json(path_str: str) -> dict:
    if not os.path.exists(path_str):
        raise FileNotFoundError(
            f"Required configuration file not found: {path_str}")
    with open(path_str, "r", encoding="utf-8") as f:
        return json.load(f)


def calculate_workers(lanes: int, unused_cpus: int, explicit_workers: int | None = None) -> int:
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


def format_time_duration(seconds: float) -> str:
    s = int(round(seconds))
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}h {m:02d}m {s:02d}s"
    return f"{m}m {s:02d}s"


def tprint(msg: str, **kwargs):
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    flush = kwargs.pop("flush", True)
    print(f"[{ts}] {msg}", flush=flush, **kwargs)


def sanitize_command_for_log(cmd: list[str], worktree_dir: str) -> str:
    home_dir = os.path.expanduser("~")
    parts = []
    for arg in cmd:
        val = str(arg)
        if worktree_dir in val:
            val = val.replace(worktree_dir, "<worktree>")
        if WORKSPACE_ROOT in val:
            val = val.replace(WORKSPACE_ROOT, "<nanofuzz-root>")
        if home_dir in val:
            val = val.replace(home_dir, "~")
        if " " in val:
            val = f'"{val}"'
        parts.append(val)
    return " ".join(parts)


def setup_lane_worktree(lane_idx: int) -> str:
    wt_dir = os.path.join(WORKTREES_DIR, f"w{lane_idx}")
    if not os.path.exists(wt_dir):
        raise RuntimeError(
            f"Worktree directory for lane {lane_idx} not found at {wt_dir}. Run setup_worktrees.py first.")
    return wt_dir


def execute_nanofuzz_run(
    lane_idx: int,
    worktree_dir: str,
    harness_path: str,
    fn_name: str,
    config_file_path: str,
    cli_args: list[str],
    runtime_ms: int,
    output_mpk_path: str,
    workers: int,
    interceptor_log_path: str,
    target_rel_path: str,
    seed_str: str
) -> tuple[int, float, str, str]:
    venv_bin = os.path.join(worktree_dir, ".venv", "bin")

    cmd = [
        "node",
        "--max-old-space-size=8192",
        CLI_JS_PATH,
        harness_path,
        fn_name,
        "--config-file", config_file_path,
        "--output-file", output_mpk_path,
        "--max-runtime", str(runtime_ms),
        "--max-tests", "0",
        "--max-dupe-inputs", "100000",
        "--max-failures", "0",
        "--fn-timeout", "1500",
        "--host-startup-timeout", "60000",
        "--no-shrink",
        "--no-progress-bar",
        "--no-failed-test-measure",
        "--coverage-scope", "project",
        "--cig-stats-checkpoints",
        "--workers", str(workers),
        "--seed", seed_str,
    ] + cli_args

    env = dict(os.environ)
    env["PATH"] = f"{venv_bin}:{env.get('PATH', '')}"
    env["VIRTUAL_ENV"] = os.path.join(worktree_dir, ".venv")
    env["PYTHONPATH"] = f"{os.path.join(worktree_dir, 'src')}:{SCRIPT_DIR}"
    env["NANOFUZZ_PROJECT_ROOT"] = worktree_dir
    # Pass Gemini API key from environment or benchmark/scripts/llm_config.json
    if "GEMINI_API_KEY" not in env:
        local_cfg = os.path.join(SCRIPT_DIR, "llm_config.json")
        pbt_cfg = os.path.join(WORKSPACE_ROOT, "..",
                               "pbt-bench", "eval", "llm_config.json")
        for cfg_cand in (local_cfg, pbt_cfg):
            if os.path.exists(cfg_cand):
                try:
                    with open(cfg_cand, "r") as f:
                        env["GEMINI_API_KEY"] = json.load(f).get("api_key", "")
                        if env["GEMINI_API_KEY"]:
                            break
                except Exception:
                    pass
    env["NANOFUZZ_DYNAMIC_BUG_ELICITATION"] = "1"
    env["NANOFUZZ_ELICITATION_LOG"] = interceptor_log_path

    # Nanofuzz tracks suite runtime from generation start.
    # Provide a generous 120-second grace period for Python host startup (16 workers),
    # AST analysis, Gemini API network calls (up to 30s timeout), and final coverage serialization.
    timeout_sec = (runtime_ms / 1000.0) + 120.0
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
        # Graceful timeout handling: send SIGINT first so NaNofuzz can stop runners and write .mpk
        tprint(
            f"[Lane {lane_idx}] Process exceeded {timeout_sec:.0f}s. Sending SIGINT for graceful teardown...")
        if sys.platform != "win32":
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGINT)
            except ProcessLookupError:
                pass
        else:
            proc.send_signal(signal.CTRL_C_EVENT)

        try:
            stdout, stderr = proc.communicate(timeout=30.0)
            retcode = proc.returncode
        except subprocess.TimeoutExpired:
            # Force kill with SIGKILL if still hung after 30s grace period
            tprint(
                f"[Lane {lane_idx}] Process failed to exit after 30s of SIGINT. Escalating to SIGKILL.")
            if sys.platform != "win32":
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                proc.kill()
            stdout, stderr = proc.communicate()
            retcode = -9

    elapsed = time.time() - start_time
    cmd_str = sanitize_command_for_log(cmd, worktree_dir)
    stdout_with_cmd = f"COMMAND: {cmd_str}\n{'=' * 80}\n{stdout}"
    return retcode, elapsed, stdout_with_cmd, stderr


def run_warmup_lane(lane_idx: int, worktree_dir: str, workers: int, warmup_cfg: dict, tasks_list: list):
    if not warmup_cfg.get("enabled", True):
        return

    runtime_ms = warmup_cfg.get("runtimeMs", 15000)
    all_tasks = list(tasks_list)

    tprint(
        f"[Lane {lane_idx}] Warming up all {len(all_tasks)} tasks ({runtime_ms//1000}s each)...")

    for task_name in all_tasks:
        task_meta = TASKS_MAP[task_name]
        src_harness = os.path.join(HARNESSES_DIR, task_meta["harness"])
        src_nano_cfg = os.path.join(
            HARNESSES_DIR, f"{task_meta['harness']}.nano.json5")
        local_harness = os.path.join(worktree_dir, task_meta["harness"])
        local_nano_cfg = os.path.join(
            worktree_dir, f"{task_meta['harness']}.nano.json5")
        shutil.copy2(src_harness, local_harness)
        shutil.copy2(src_nano_cfg, local_nano_cfg)

        tmp_mpk = f"/tmp/nanofuzz_warmup_l{lane_idx}_{task_name}.mpk"
        tmp_log = f"/tmp/nanofuzz_warmup_l{lane_idx}_{task_name}.json"

        execute_nanofuzz_run(
            lane_idx=lane_idx,
            worktree_dir=worktree_dir,
            harness_path=local_harness,
            fn_name=task_meta["function"],
            config_file_path=local_nano_cfg,
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

    tprint(f"[Lane {lane_idx}] Warmup completed.")


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
    rubric: dict,
    attempts: int = 1
) -> dict:
    if retcode not in (0, 1):
        raise RuntimeError(
            f"Trial execution error: Trial {run_id} ({trial['Task']} under {trial['Treatment']}) "
            f"exited with code {retcode} (valid: 0=clean, 1=defects found). Stderr: {stderr[:500]}"
        )

    if not os.path.exists(output_mpk_path):
        raise RuntimeError(
            f"Missing output file: {output_mpk_path} was not created for trial {run_id} "
            f"({trial['Task']} under {trial['Treatment']}). CLI exit code: {retcode}. Stderr: {stderr[:500]}"
        )

    with open(output_mpk_path, "rb") as f:
        data = msgpack.unpackb(f.read())

    stats = data.get("stats", {})
    counters = stats.get("counters", {})
    measures = stats.get("measures", {})

    total_tests = counters.get(
        "passedTests", 0) + counters.get("failedTests", 0) + counters.get("erroredTests", 0)
    dupes_generated = counters.get("dupesGenerated", 0)
    inputs_skipped = counters.get("inputsSkipped", 0)
    stop_reason = str(data.get("stopReason", "unknown"))
    tool_version = str(data.get("toolVersion", "unknown"))

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
            branches_total = fcounters.get(
                "branchesTotal", expected_total_branches)
            target_found = True
            break

    if not target_found:
        target_norm = os.path.normpath(task_meta["relative_target"])
        for finfo in cov_files:
            if os.path.normpath(finfo.get("path", "")).endswith(target_norm):
                fcounters = finfo.get("counters", {})
                branches_covered = fcounters.get("branchesCovered", 0)
                branches_total = fcounters.get(
                    "branchesTotal", expected_total_branches)
                target_found = True
                break

    if not target_found:
        raise RuntimeError(
            f"Coverage error: Target file {task_meta['relative_target']} not present in coverage files "
            f"for trial {run_id}. Files measured: {[f.get('path') for f in cov_files]}"
        )

    if branches_total != expected_total_branches:
        raise ValueError(
            f"Denominator mismatch: Branch denominator mismatch for {task_name} in {run_id}: "
            f"expected {expected_total_branches}, got {branches_total}."
        )

    branch_cov_pct = round((branches_covered / branches_total)
                           * 100.0, 1) if branches_total > 0 else 0.0

    task_rubric_bugs = rubric.get("tasks", {}).get(
        task_name, {}).get("bugs", {})
    task_bug_count = len(task_rubric_bugs)

    interceptor_hits: dict[str, dict] = {}
    interceptor_total_calls = 0
    if os.path.exists(interceptor_log_path):
        with open(interceptor_log_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception as e:
                    raise RuntimeError(
                        f"CRITICAL: Corrupted JSON line in {interceptor_log_path}: {line}") from e

                if entry.get("summary") and "total_calls" in entry:
                    interceptor_total_calls += int(entry["total_calls"])
                    continue
                bid = entry.get("bug_id")
                if bid in task_rubric_bugs:
                    interceptor_hits[bid] = entry

    # Extract validator outcomes and input sources from results
    validator_detected_bugs = set()
    raw_results = data.get("results", [])
    interesting_inputs = data.get("interesting", {}).get("inputs", [])

    # Compile provenance from fuzzer's internal results/interesting structures
    provenance_from_fuzzer: list[str] = []
    for item in interesting_inputs:
        src = item.get("input", {}).get("source", {})
        gtype = src.get("type")
        if gtype == "generator":
            gen = src.get("generator")
            if gen:
                provenance_from_fuzzer.append(gen)
        elif gtype == "user":
            provenance_from_fuzzer.append("SeedInput")

    for r in raw_results:
        # Extract bug IDs directly from the harness output tuple [put_input, bug_ids]
        output = r.get("output")
        if output and len(output) > 0:
            val = output[0].get("value") if isinstance(
                output[0], dict) else output[0]
            if isinstance(val, (list, tuple)) and len(val) >= 2:
                for bid in val[1]:
                    if bid in task_rubric_bugs:
                        validator_detected_bugs.add(bid)
        elif r.get("exception"):
            # Unhandled exception escaped from harness: attribute to matching rubric bugs in interceptor
            for bid in task_rubric_bugs:
                if bid in interceptor_hits:
                    validator_detected_bugs.add(bid)

    defects_elicited_count = len(interceptor_hits)
    defects_detected_count = len(validator_detected_bugs)

    bug_elicitation_rate = round(
        defects_elicited_count / float(task_bug_count), 3) if task_bug_count > 0 else 0.0

    generators_chain = []
    for bid, ev in interceptor_hits.items():
        gen = ev.get("generator", "Unknown")
        generators_chain.append(f"{bid}:{gen}")
    eliciting_generators_str = ";".join(generators_chain)
    eliciting_generators_validator_str = ";".join(
        sorted(set(provenance_from_fuzzer))) if provenance_from_fuzzer else "None"

    row = {
        "RunID": run_id,
        "Task": task_name,
        "Treatment": trial["Treatment"],
        "Replicate": trial["Replicate"],
        "Sequence": trial["Sequence"],
        "Date": datetime.date.today().isoformat(),
        "ToolVersion": tool_version,
        "ElapsedSec": int(round(elapsed_sec)),
        "ExitCode": retcode,
        "StopReason": stop_reason,
        "Attempts": attempts,
        "TotalTestsExecuted": total_tests,
        "TotalTestsInterceptor": interceptor_total_calls,
        "DupesGenerated": dupes_generated,
        "InputsSkipped": inputs_skipped,
        "BranchCoveragePct": branch_cov_pct,
        "BranchesCovered": branches_covered,
        "BranchesTotal": branches_total,
        "TaskBugCount": task_bug_count,
        "BugsElicited": defects_elicited_count,
        "BugsDetected": defects_detected_count,
        "BugElicitationRate": bug_elicitation_rate,
        "ElicitingGenerators": eliciting_generators_str,
        "ElicitingGeneratorsValidator": eliciting_generators_validator_str,
        "Status": "COMPLETED" if retcode == 0 or total_tests > 0 else "FAILED",
    }

    for b in ALL_DEFECT_COLUMNS:
        if b in task_rubric_bugs:
            elicited_val = 1 if b in interceptor_hits else 0
            row[b] = elicited_val
            row[f"{b}_Validator"] = 1 if b in validator_detected_bugs else 0
        else:
            row[b] = "#N/A"
            row[f"{b}_Validator"] = "#N/A"

    # Strict Post-Validation Assertions & Cross-Checks:
    # Denominator check:
    if branches_total != expected_total_branches:
        raise ValueError(
            f"CROSS-CHECK FAILED: Denominator mismatch for {task_name} in {run_id}. Expected {expected_total_branches}, got {branches_total}"
        )

    # Treatment provenance consistency check:
    treatment_name = trial["Treatment"]
    if treatment_name == "R":
        for _bid, ev in interceptor_hits.items():
            g = ev.get("generator", "")
            if "SeedInput" in g or "Custom" in g or "Ai" in g or "Mutation" in g:
                raise ValueError(
                    f"CROSS-CHECK FAILED: Non-random generator '{g}' recorded for pure random treatment R on {run_id}"
                )
    elif "S" not in treatment_name:
        for _bid, ev in interceptor_hits.items():
            g = ev.get("generator", "")
            if "SeedInput" in g:
                raise ValueError(
                    f"CROSS-CHECK FAILED: SeedInput recorded for non-seed treatment {treatment_name} on {run_id}"
                )

    # Dual defect validation two-way match check: Both MUST agree!
    for b in task_rubric_bugs:
        elicited_interceptor = row[b]
        validator_val = row[f"{b}_Validator"]
        if elicited_interceptor != validator_val:
            raise ValueError(
                f"CROSS-CHECK FAILED: Defect {b} mismatch on {run_id}: Interceptor elicited={elicited_interceptor} vs Validator={validator_val}. Both must agree!"
            )

    return row


def create_failed_trial_row(trial: dict, run_id: str, attempts: int, last_error: str, rubric: dict) -> dict:
    task_name = trial["Task"]
    task_rubric_bugs = rubric.get("tasks", {}).get(
        task_name, {}).get("bugs", {})
    row = {
        "RunID": run_id,
        "Task": task_name,
        "Treatment": trial["Treatment"],
        "Replicate": trial["Replicate"],
        "Sequence": trial["Sequence"],
        "Date": datetime.date.today().isoformat(),
        "ToolVersion": "NaNofuzz",
        "ElapsedSec": 0,
        "ExitCode": -1,
        "StopReason": "FAILED",
        "Attempts": attempts,
        "TotalTestsExecuted": "#N/A",
        "TotalTestsInterceptor": "#N/A",
        "DupesGenerated": "#N/A",
        "InputsSkipped": "#N/A",
        "BranchCoveragePct": "#N/A",
        "BranchesCovered": "#N/A",
        "BranchesTotal": TASKS_MAP[task_name]["branches_total"],
        "TaskBugCount": len(task_rubric_bugs),
        "BugsElicited": "#N/A",
        "BugsDetected": "#N/A",
        "BugElicitationRate": "#N/A",
        "ElicitingGenerators": "#N/A",
        "ElicitingGeneratorsValidator": "#N/A",
        "Status": "FAILED",
        "Error": str(last_error)[:300],
    }
    for b in ALL_DEFECT_COLUMNS:
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
    treatments_cfg: dict,
    warmup_barrier: Any | None = None
):
    try:
        run_warmup_lane(lane_idx, worktree_dir, workers,
                        warmup_cfg, list(TASKS_MAP.keys()))

        if warmup_barrier is not None and warmup_cfg.get("enabled", True):
            tprint(
                f"[Lane {lane_idx}] Finished warmup. Waiting for all other lanes to finish warmup...", flush=True)
            warmup_barrier.wait()
            if lane_idx == 1:
                tprint(
                    "[WARMUP] All lanes have completed warmup. Commencing live experimental trials.", flush=True)

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
            if treatments_cfg.get("noFailedTestMeasure"):
                cli_args.append("--no-failed-test-measure")

            trial_artifact_dir = os.path.join(run_dir, "artifacts", run_id)
            os.makedirs(trial_artifact_dir, exist_ok=True)

            task_meta = TASKS_MAP[task_name]
            # Copy harness directly into the worktree root so it executes as a local project file
            src_harness = os.path.join(HARNESSES_DIR, task_meta["harness"])
            src_nano_cfg = os.path.join(
                HARNESSES_DIR, f"{task_meta['harness']}.nano.json5")
            local_harness = os.path.join(worktree_dir, task_meta["harness"])
            local_nano_cfg = os.path.join(
                worktree_dir, f"{task_meta['harness']}.nano.json5")
            shutil.copy2(src_harness, local_harness)
            shutil.copy2(src_nano_cfg, local_nano_cfg)

            output_mpk_path = os.path.join(trial_artifact_dir, f"{run_id}.mpk")
            interceptor_log_path = os.path.join(
                trial_artifact_dir, "elicited_bugs.json")

            seed_str = f"{item['Sequence']}_{run_id}_{task_name}_{treatment_name}"

            MAX_TRIAL_ATTEMPTS = 3
            processed_row = None
            last_err = None

            for attempt in range(1, MAX_TRIAL_ATTEMPTS + 1):
                attempt_suffix = f" (Attempt {attempt}/{MAX_TRIAL_ATTEMPTS})" if attempt > 1 else ""
                ts_start = datetime.datetime.now().strftime("%H:%M:%S")
                print(
                    f"[{ts_start}] [Lane {lane_idx}] Starting {run_id}: {task_name} under {treatment_name} (Repetition {item['Replicate']}){attempt_suffix}...",
                    flush=True)

                retcode, elapsed, stdout, stderr = execute_nanofuzz_run(
                    lane_idx=lane_idx,
                    worktree_dir=worktree_dir,
                    harness_path=local_harness,
                    fn_name=task_meta["function"],
                    config_file_path=local_nano_cfg,
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

                try:
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
                        rubric=rubric,
                        attempts=attempt
                    )
                    break
                except Exception as exc:
                    last_err = exc
                    err_file = os.path.join(
                        trial_artifact_dir, f"attempt_{attempt}_error.txt")
                    with open(err_file, "w", encoding="utf-8") as ef:
                        ef.write(
                            f"Timestamp: {datetime.datetime.now().isoformat()}\n")
                        ef.write(
                            f"Attempt: {attempt} of {MAX_TRIAL_ATTEMPTS}\n")
                        ef.write(f"ExitCode: {retcode}\n")
                        ef.write(f"Elapsed: {elapsed:.2f}s\n")
                        ef.write(f"Error: {exc}\n\n")
                        ef.write(f"Stderr:\n{stderr}\n\n")
                        ef.write(f"Stdout:\n{stdout}\n")

                    ts_err = datetime.datetime.now().strftime("%H:%M:%S")
                    if attempt < MAX_TRIAL_ATTEMPTS:
                        print(
                            f"[{ts_err}] [Lane {lane_idx}] Trial {run_id} failed on attempt {attempt}: {exc}. Retrying...", flush=True)
                        time.sleep(2)
                    else:
                        print(f"[{ts_err}] [Lane {lane_idx} ERROR] Trial {run_id} failed after {MAX_TRIAL_ATTEMPTS} attempts: {exc}. Logging as FAILED and continuing remaining tasks.", flush=True)

            if processed_row is None:
                processed_row = create_failed_trial_row(
                    trial=item,
                    run_id=run_id,
                    attempts=MAX_TRIAL_ATTEMPTS,
                    last_error=str(last_err),
                    rubric=rubric
                )

            result_queue.put(processed_row)
            ts_end = datetime.datetime.now().strftime("%H:%M:%S")
            print(
                f"[{ts_end}] [Lane {lane_idx}] Finished {run_id}: {task_name} under {treatment_name} in {elapsed:.1f}s | Cov: {processed_row['BranchCoveragePct']}% | Elicited: {processed_row['BugsElicited']}/{processed_row['TaskBugCount']}",
                flush=True)

    except Exception as exc:
        print(f"[Lane {lane_idx} ERROR]: {exc}", file=sys.stderr)
        result_queue.put({"ERROR": str(exc), "Lane": lane_idx})


def print_post_check_summary(results_rows: list, rubric: dict):
    print("\n" + "=" * 80)
    print("                    POST-CHECK VALIDATION REPORT")
    print("=" * 80)

    total_trials = len(results_rows)
    completed = [r for r in results_rows if r.get("Status") == "COMPLETED"]
    print(
        f"Total Trials: {total_trials} | Completed: {len(completed)} | Failed: {total_trials - len(completed)}")

    # 1. Denominator Cross-Checks
    denom_errors = []
    for r in results_rows:
        task = r["Task"]
        expected_denom = TASKS_MAP[task]["branches_total"]
        actual_denom = r.get("BranchesTotal")
        if actual_denom != expected_denom:
            denom_errors.append(
                (r["RunID"], task, expected_denom, actual_denom))

    if not denom_errors:
        print(
            "✓ Branch Coverage Denominators: ALL PASSED (100% matched ground-truth rubric)")
    else:
        print(
            f"✗ Branch Coverage Denominators: {len(denom_errors)} MISMATCHES:")
        for rid, tsk, exp, act in denom_errors:
            print(f"    - {rid} ({tsk}): expected {exp}, got {act}")

    # 2. Defect Cross-Checks (Interceptor vs Validator)
    print("\n✓ Defect Cross-Checks:")
    for r in sorted(results_rows, key=lambda x: x["Sequence"]):
        rid = r["RunID"]
        task = r["Task"]
        tr = r["Treatment"]
        status = r.get("Status", "COMPLETED")
        if status != "COMPLETED":
            print(
                f"    [{rid}] {task:<15} under {tr:<6} => FAILED ({status}): {r.get('Error', '')[:100]}")
            continue
        el = r["BugsElicited"]
        tot = r["TaskBugCount"]
        cov = r["BranchCoveragePct"]
        tests = r["TotalTestsExecuted"]
        rate = r["BugElicitationRate"]
        print(f"    [{rid}] {task:<15} under {tr:<6} => Elicited {el}/{tot} bugs ({rate:.1%}) | Cov: {cov}% ({r['BranchesCovered']}/{r['BranchesTotal']}) | Tests: {tests}")

    # 3. Provenance Verification
    prov_empty = [r["RunID"] for r in results_rows if r.get(
        "BugsElicited", 0) > 0 and not r.get("ElicitingGenerators")]
    if not prov_empty:
        print("\n✓ Generator Provenance Chains: ALL VERIFIED (non-empty provenance for all elicited defects)")
    else:
        print(f"\n✗ Generator Provenance: Missing for {prov_empty}")

    print("=" * 80 + "\n")


def update_latest_symlink(run_dir: str):
    latest_symlink = os.path.join(CLI_BASE_DIR, "latest")
    try:
        if os.path.islink(latest_symlink) or os.path.exists(latest_symlink):
            os.remove(latest_symlink)
        rel_target = os.path.basename(run_dir)
        os.symlink(rel_target, latest_symlink)
        tprint(f"[SYMLINK] Updated {latest_symlink} -> {rel_target}")
    except Exception as e:
        tprint(f"[WARN] Failed to update latest symlink: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="NaNofuzz CLI Empirical Factorial Study Driver")
    parser.add_argument("--lanes", type=int, default=4,
                        help="Number of concurrent execution lanes (default: 4)")
    parser.add_argument("--unused-cpus", type=int, default=2,
                        help="Number of host CPUs reserved (default: 2)")
    parser.add_argument("--workers", type=int, default=None,
                        help="Explicit workers per lane (default: computed)")
    parser.add_argument("--repetitions", "--replicates", type=int, default=10, dest="repetitions",
                        help="Repetitions per condition (default: 10)")
    parser.add_argument("--runtime-ms", type=int, default=None,
                        help="Override runtimeMs per trial (ms)")
    parser.add_argument("--smoke", action="store_true",
                        help="Run fast smoke test with 1 full factorial repetition (30 trials) covering all treatments and PUTs")
    parser.add_argument("--treatments", nargs="+", default=None,
                        help="Filter to specific treatments (e.g. --treatments SCRAM)")
    parser.add_argument("--tasks", nargs="+", default=None,
                        help="Filter to specific tasks (e.g. --tasks TreeValue make_def)")
    parser.add_argument("--no-failed-test-measure", action="store_true",
                        help="Disable FailedTestMeasure in NaNofuzz CLI")
    parser.add_argument("--no-warmup", action="store_true",
                        help="Disable warmup runs")
    parser.add_argument("--resume", type=str, default=None,
                        help="Resume an existing run directory")
    args = parser.parse_args()

    workers_per_lane = calculate_workers(
        args.lanes, args.unused_cpus, args.workers)
    tprint(
        f"[HARDWARE] Total Host CPUs: {os.cpu_count()}, Unused CPUs: {args.unused_cpus}")
    tprint(
        f"[ALLOCATION] Concurrency: {args.lanes} lanes x {workers_per_lane} workers/lane = {args.lanes * workers_per_lane} active worker processes")

    treatments_cfg = load_json(TREATMENTS_CONFIG_PATH)
    rubric = load_json(RUBRIC_PATH)

    repetitions = args.repetitions
    canonical_treatments = list(treatments_cfg["treatments"].keys())
    if args.treatments:
        canonical_treatments = [
            t for t in args.treatments if t in treatments_cfg["treatments"]]
    tasks_list = treatments_cfg.get("tasks", list(TASKS_MAP.keys()))
    if args.tasks:
        tasks_list = [t for t in args.tasks if t in TASKS_MAP]

    if args.resume:
        run_dir = os.path.abspath(args.resume)
        if not os.path.isdir(run_dir):
            raise FileNotFoundError(f"Resume directory not found: {run_dir}")
        tprint(f"[RESUME] Resuming benchmark in: {run_dir}")
    else:
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        run_dir = os.path.join(CLI_BASE_DIR, timestamp)
        os.makedirs(os.path.join(run_dir, "artifacts"), exist_ok=True)
        tprint(f"[START] Starting new benchmark in: {run_dir}")

    update_latest_symlink(run_dir)

    data_csv_path = os.path.join(run_dir, "data.csv")
    completed_runs = {}

    if os.path.exists(data_csv_path):
        existing_df = pd.read_csv(data_csv_path)
        for _, r in existing_df.iterrows():
            if r.get("Status") == "COMPLETED":
                completed_runs[r["RunID"]] = r.to_dict()
        tprint(
            f"[RESUME] Found {len(completed_runs)} already completed trials in {data_csv_path}")

    if args.runtime_ms is not None:
        treatments_cfg["runtimeMs"] = args.runtime_ms
    if args.no_warmup or args.smoke:
        treatments_cfg["warmup"]["enabled"] = False
    if args.smoke:
        repetitions = 1
    if args.no_failed_test_measure:
        treatments_cfg["noFailedTestMeasure"] = True

    # Build schedule
    schedule_items = []
    for rep in range(1, repetitions + 1):
        for tr in canonical_treatments:
            for tsk in tasks_list:
                schedule_items.append({
                    "Task": tsk,
                    "Treatment": tr,
                    "Replicate": rep,
                })
    shuffled_schedule = seeded_shuffle(
        schedule_items, treatments_cfg.get("randomSeed", "qwertonyuiop"))

    full_trial_list = []
    for idx, item in enumerate(shuffled_schedule):
        run_id = f"R{idx+1:03d}"
        item["RunID"] = run_id
        item["Sequence"] = idx + 1
        full_trial_list.append(item)

    pending_trials = [
        t for t in full_trial_list if t["RunID"] not in completed_runs]
    tprint(
        f"[SCHEDULE] Total Factorial Matrix: {len(full_trial_list)} trials. Remaining to execute: {len(pending_trials)}")

    if not pending_trials:
        tprint("[COMPLETE] All trials have already been executed!")
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

    warmup_barrier = multiprocessing.Barrier(args.lanes) if treatments_cfg.get(
        "warmup", {}).get("enabled", True) else None

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
                treatments_cfg,
                warmup_barrier
            )
        )
        p.start()
        workers_processes.append(p)

    results_rows = list(completed_runs.values())
    pending_count = len(pending_trials)
    benchmark_start_time = time.time()

    def write_csv():
        if results_rows:
            df = pd.DataFrame(results_rows)
            df = df.sort_values(by="Sequence")
            df.to_csv(data_csv_path, index=False)

    try:
        while pending_count > 0:
            res = result_queue.get()
            if "ERROR" in res:
                print(
                    f"[FATAL ERROR IN WORKER]: {res['ERROR']}", file=sys.stderr)
                for p in workers_processes:
                    p.terminate()
                sys.exit(1)

            results_rows.append(res)
            write_csv()
            pending_count -= 1

            if res.get("Status") == "FAILED":
                tprint(
                    f"[WARN] Trial {res['RunID']} failed after {res.get('Attempts', 1)} attempts ({res.get('Error')}). Logged to data.csv. Continuing remaining tasks.")

            completed_count = len(results_rows)
            total_count = len(full_trial_list)
            elapsed_sec = time.time() - benchmark_start_time
            time_per_trial = elapsed_sec / completed_count
            remaining_sec = time_per_trial * pending_count

            elapsed_str = format_time_duration(elapsed_sec)
            eta_str = format_time_duration(remaining_sec)
            pct = (completed_count / total_count) * 100.0

            # Live scores across treatments
            df_curr = pd.DataFrame(results_rows)
            bugs_parts = []
            bcov_parts = []
            for tr in canonical_treatments:
                sub = df_curr[df_curr["Treatment"] == tr]
                if not sub.empty and "BugElicitationRate" in sub.columns:
                    mean_rate = sub["BugElicitationRate"].mean()
                    bugs_parts.append(f"{tr}: {mean_rate:.1%}")
                else:
                    bugs_parts.append(f"{tr}: --")

                if not sub.empty and "BranchCoveragePct" in sub.columns:
                    mean_cov = sub["BranchCoveragePct"].mean()
                    bcov_parts.append(f"{tr}: {mean_cov:.1f}%")
                else:
                    bcov_parts.append(f"{tr}: --")

            bugs_str = " | ".join(bugs_parts)
            bcov_str = " | ".join(bcov_parts)

            ts_prog = datetime.datetime.now().strftime("%H:%M:%S")
            print(
                f"[{ts_prog}] [UPDATE] {completed_count}/{total_count} ({pct:.1f}%) | "
                f"Left: {pending_count} | Elapsed: {elapsed_str} | ETA: ~{eta_str}\n"
                f"[{ts_prog}] [ BUGS ] {bugs_str}\n"
                f"[{ts_prog}] [ BCOV ] {bcov_str}",
                flush=True
            )

    finally:
        for p in workers_processes:
            p.join(timeout=5)
        write_csv()

    print(
        f"\n[DONE] Experiment run successfully completed. Dataset written to:\n  {data_csv_path}")

    print_post_check_summary(results_rows, rubric)

    # Run analysis pipeline at the end of experiment
    analyze_script = os.path.join(SCRIPT_DIR, "analyze_cig.py")
    if os.path.exists(analyze_script):
        if args.treatments and len(canonical_treatments) < len(treatments_cfg["treatments"]):
            print(
                f"\n[ANALYSIS] Partial treatment run ({canonical_treatments}): comparative hypothesis "
                f"testing against control 'R' requires all 6 treatments. Full comparative analysis skipped."
            )
        else:
            print(
                f"\n[ANALYSIS] Running CIG analysis pipeline on {data_csv_path}...")
            cmd_analyze = [sys.executable,
                           analyze_script, "--data", data_csv_path]
            if args.smoke:
                cmd_analyze.append("--smoke")
            subprocess.run(cmd_analyze, check=True)


if __name__ == "__main__":
    main()
