#!/usr/bin/env python3
import os
import sys
import shutil
import json
import glob
from datetime import datetime
import pandas as pd

TOTAL_BRANCHES = {
    "DerivationTree": 246,
    "TreeValue": 124,
    "parse": 122,
    "_distance_norm": 54,
    "make_def": 8,
}

def main():
    base_results_dir = os.path.abspath("benchmark/results")
    prior_dir = os.path.join(base_results_dir, "20261113_024157")
    if not os.path.isdir(prior_dir):
        print(f"Error: Prior run directory not found: {prior_dir}")
        sys.exit(1)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    new_run_dir = os.path.join(base_results_dir, stamp)
    new_results_dir = os.path.join(new_run_dir, "results")
    new_parts_dir = os.path.join(new_results_dir, "parts")
    new_telemetry_dir = os.path.join(new_run_dir, "telemetry")
    new_scoring_dir = os.path.join(new_run_dir, "scoring_sheets")
    new_artifacts_dir = os.path.join(new_run_dir, "artifacts")

    os.makedirs(new_parts_dir, exist_ok=True)
    os.makedirs(new_telemetry_dir, exist_ok=True)
    os.makedirs(new_scoring_dir, exist_ok=True)
    os.makedirs(new_artifacts_dir, exist_ok=True)

    print(f"[1/6] Created synthetic run directory: {new_run_dir}")

    # Copy markdown reports
    report_files = glob.glob(os.path.join(prior_dir, "P*.md"))
    for f in report_files:
        shutil.copy2(f, new_run_dir)
        shutil.copy2(f, new_results_dir)
        pid = os.path.splitext(os.path.basename(f))[0]
        p_dir = os.path.join(new_artifacts_dir, pid)
        os.makedirs(p_dir, exist_ok=True)
        shutil.copy2(f, p_dir)
    print(f"[2/6] Copied {len(report_files)} participant reports.")

    # Copy scoring sheets
    sheet_files = glob.glob(os.path.join(prior_dir, "scoring_sheets", "*"))
    for f in sheet_files:
        shutil.copy2(f, new_scoring_dir)
    print(f"[3/6] Copied {len(sheet_files)} scoring sheets.")

    # Copy state and dashboard
    for meta_name in ["benchmark_state.json", "DASHBOARD.md", "survey_responses.csv"]:
        src_meta = os.path.join(prior_dir, meta_name)
        if os.path.exists(src_meta):
            shutil.copy2(src_meta, new_run_dir)
            if meta_name == "survey_responses.csv":
                shutil.copy2(src_meta, new_results_dir)

    # Process and update data.csv with BranchesCovered and BranchesTotal
    data_csv_src = os.path.join(prior_dir, "data.csv")
    df = pd.read_csv(data_csv_src)

    # Insert BranchesCovered and BranchesTotal if not present
    if "BranchesCovered" not in df.columns or "BranchesTotal" not in df.columns:
        cov_idx = df.columns.get_loc("BranchCoveragePct")
        
        branches_total = []
        branches_covered = []
        for _, row in df.iterrows():
            task = row["Task"]
            tot = TOTAL_BRANCHES.get(task, 0)
            pct = float(row["BranchCoveragePct"]) if pd.notnull(row["BranchCoveragePct"]) else 0.0
            cov = int(round((pct / 100.0) * tot)) if tot > 0 else 0
            branches_total.append(tot)
            branches_covered.append(cov)

        df.insert(cov_idx + 1, "BranchesCovered", branches_covered)
        df.insert(cov_idx + 2, "BranchesTotal", branches_total)

    dst_data_csv = os.path.join(new_results_dir, "data.csv")
    df.to_csv(dst_data_csv, index=False)
    df.to_csv(os.path.join(new_run_dir, "data.csv"), index=False)
    print(f"[4/6] Generated updated data.csv with {len(df)} participant records.")

    # Process and update telemetry JSON files
    telemetry_files = glob.glob(os.path.join(prior_dir, "telemetry", "*.json"))
    for tpath in telemetry_files:
        with open(tpath, "r", encoding="utf-8") as fp:
            tel = json.load(fp)
        task = tel.get("task", "")
        tot = TOTAL_BRANCHES.get(task, 0)
        for r in tel.get("fuzzRuns", []):
            pct = r.get("branchCoveragePct")
            r["branchesTotal"] = tot
            r["branchesCovered"] = int(round(((pct or 0.0) / 100.0) * tot)) if tot > 0 else 0
        
        fname = os.path.basename(tpath)
        with open(os.path.join(new_telemetry_dir, fname), "w", encoding="utf-8") as fp:
            json.dump(tel, fp, indent=2)

        # Extract created code artifacts (harnesses, reproducers) into artifacts/<pid>/
        pid = tel.get("participant", os.path.splitext(fname)[0])
        p_dir = os.path.join(new_artifacts_dir, pid)
        os.makedirs(p_dir, exist_ok=True)
        for ev in tel.get("events", []):
            if ev.get("tool") == "copilot_createFile" and "args" in ev:
                fp_created = ev["args"].get("filePath")
                content = ev["args"].get("content")
                if fp_created and content is not None and not fp_created.endswith(".md"):
                    with open(os.path.join(p_dir, os.path.basename(fp_created)), "w", encoding="utf-8") as out:
                        out.write(content)
    print(f"[5/6] Updated telemetry JSON files with branch numerators and denominators.")

    # Run QuartoN dissertation analysis pipeline
    print(f"[6/6] Running QuartoN analysis pipeline...")
    analyze_script = os.path.abspath("benchmark/scripts/analyze_quarton.py")
    python_bin = os.path.abspath("benchmark/target/.venv/bin/python")
    survey_path = os.path.join(new_results_dir, "survey_responses.csv")
    
    cmd = (
        f'"{python_bin}" "{analyze_script}" '
        f'--data "{dst_data_csv}" '
        f'--survey "{survey_path}" '
        f'--local-parts-dir "{new_parts_dir}"'
    )
    rc = os.system(cmd)
    if rc != 0:
        print(f"Warning: analyze_quarton.py exited with return code {rc}")

    # Update latest symlink
    latest_symlink = os.path.join(base_results_dir, "latest")
    try:
        if os.path.islink(latest_symlink) or os.path.exists(latest_symlink):
            os.remove(latest_symlink)
        os.symlink(stamp, latest_symlink)
        print(f"[DONE] Updated symlink {latest_symlink} -> {stamp}")
    except Exception as e:
        print(f"Warning: Could not update symlink: {e}")

    print(f"\nSynthetic benchmark run complete!")
    print(f"Output directory: {new_run_dir}")

if __name__ == "__main__":
    main()
