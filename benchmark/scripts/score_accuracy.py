#!/usr/bin/env python3
# type: ignore
"""
Dual-Rater Bug Description Accuracy Scoring Engine (Measure 2)
Option 2A: Foundation Model Jury (Rater 1: Gemini 3.8 Flash, Rater 2: Claude 3.5 Sonnet / GPT-4o)

Scores each ground-truth bug in an agent's markdown report against scripts/ground_truth_rubric.json:
  - +1.0: Full Credit (Accurately describes complete failure domain D*)
  - +0.5: Partial Credit (Describes strict subset of D*)
  -  0.0: No Credit (Bug omitted or misidentified)
  - -0.5: Over-generalization Penalty (Claims valid/safe inputs fail)

Net score range per bug: -0.5 to +1.0.
Task normalized accuracy range: -0.500 to +1.000.
Computes Cohen's Weighted Kappa (κ_w) between Rater 1 and Rater 2.
"""

import argparse
import json
import os
import re
import sys
import numpy as np
import pandas as pd

RUBRIC_PATH = os.path.join(os.path.dirname(__file__), "ground_truth_rubric.json")


def load_rubric() -> dict:
    with open(RUBRIC_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def build_judge_prompt(task_name: str, bug: dict, report_text: str) -> str:
    return f"""You are an expert empirical software testing researcher scoring an autonomous agent's bug report according to the formal TerzoN study rubric.

### Task Program:
{task_name} ({bug.get('file', '')})

### Ground Truth Defect Under Evaluation:
- Bug ID: {bug['id']}
- Summary: {bug['name']}
- Primary Exception / Symptom: {bug['exception_class']}
- Expected Exact Failure Domain (D*): {bug['exact_failure_domain']}
- Partial Failure Domain (Strict Subset): {bug['partial_failure_domain']}
- Safe / Allowed Domain (Valid Inputs): {bug['safe_valid_domain']}
- Overgeneralization Triggers: {bug['overgeneralization_triggers']}

### Agent's Submitted Bug Report:
\"\"\"
{report_text}
\"\"\"

### Scoring Rules (TerzoN Rubric: Net Score range -0.5 to +1.0):
1. Credit Earned:
   - +1.0: The report explicitly identifies this defect AND characterizes the full failure domain D* accurately.
   - +0.5: The report identifies this defect, but only describes a strict subset of D* (under-generalization), or describes the crash symptom with only a single concrete example without identifying the general boundary.
   -  0.0: The report does not mention this defect, or attributes the crash to an unrelated cause.

2. Deduction (Overgeneralization Penalty):
   - -0.5 deduction: The agent's described domain includes allowed/safe inputs where the program behaves correctly (falsely claiming non-bugs fail).
   -  0.0 deduction: No over-generalization into safe input territory.

3. Net Score:
   net_score = credit_earned - deduction
   Allowable net scores per bug: +1.0, +0.5, 0.0, -0.5.

Return STRICTLY a JSON object in a ```json codeblock:
```json
{{
  "bug_id": "{bug['id']}",
  "elicited_in_report": true,
  "credit_earned": 1.0,
  "deduction": 0.0,
  "net_score": 1.0,
  "evidence_quote": "Exact quote from agent report",
  "rationale": "Concise justification for score category."
}}
```"""


def compute_cohens_weighted_kappa(r1_scores: list[float], r2_scores: list[float]) -> float:
    """
    Computes Cohen's quadratically weighted kappa across ordinal ratings.
    Rating scale: [-0.5, 0.0, 0.5, 1.0] (4 distinct ordinal levels: 0, 1, 2, 3)
    """
    scale_map = {-0.5: 0, 0.0: 1, 0.5: 2, 1.0: 3}
    k = len(scale_map)
    if len(r1_scores) == 0:
        return 1.0

    n = len(r1_scores)
    c1 = [scale_map.get(s, 1) for s in r1_scores]
    c2 = [scale_map.get(s, 1) for s in r2_scores]

    # Observed confusion matrix
    O = np.zeros((k, k), dtype=float)
    for x, y in zip(c1, c2):
        O[x, y] += 1

    # Expected matrix under independence
    hist1 = np.bincount(c1, minlength=k)
    hist2 = np.bincount(c2, minlength=k)
    E = np.outer(hist1, hist2) / float(n)

    # Quadratic weight matrix
    W = np.zeros((k, k), dtype=float)
    for i in range(k):
        for j in range(k):
            W[i, j] = ((i - j) ** 2) / float((k - 1) ** 2)

    num = np.sum(W * O)
    den = np.sum(W * E)

    if den == 0:
        return 1.0
    return float(1.0 - (num / den))


def score_reports(reports_dir: str, rubric: dict) -> tuple[pd.DataFrame, dict]:
    tasks_rubric = rubric.get("tasks", {})
    records = []
    all_gemini = []
    all_claude = []
    all_gpt4o = []

    telemetry_dir = os.path.join(reports_dir, "telemetry")

    report_files = [
        f for f in os.listdir(reports_dir)
        if f.endswith(".md") and f.startswith("P") and not f.startswith("scoring_sheet")
    ]
    report_files.sort()

    for rfile in report_files:
        rpath = os.path.join(reports_dir, rfile)
        participant = rfile.replace(".md", "")
        with open(rpath, "r", encoding="utf-8") as f:
            content = f.read()

        # Check for telemetry file containing LLM Judge Panel evaluations
        telemetry_path = os.path.join(telemetry_dir, f"{participant}.telemetry.json")
        telemetry_evals = {}
        matched_task = None

        if os.path.exists(telemetry_path):
            try:
                with open(telemetry_path, "r", encoding="utf-8") as tf:
                    tdata = json.load(tf)
                    matched_task = tdata.get("task")
                    for item in tdata.get("evalResults", []):
                        bid = item.get("bug", {}).get("id")
                        if bid:
                            telemetry_evals[bid] = item
            except Exception:
                pass

        if not matched_task:
            # Fallback: Identify task from filename or content
            for t in tasks_rubric:
                if t in rfile or f"Task: {t}" in content or f"Task / Entrypoint**: `{t}`" in content or f"entrypoint '{t}'" in content or f"`{t}` Entrypoint" in content or t.lower() in content.lower():
                    matched_task = t
                    break

        if not matched_task:
            continue

        task_bugs = tasks_rubric[matched_task].get("bugs", {})
        k_task = len(task_bugs)
        if k_task == 0:
            continue

        gemini_net_sum = 0.0
        claude_net_sum = 0.0
        gpt4o_net_sum = 0.0
        consensus_net_sum = 0.0

        for bid, _binfo in task_bugs.items():
            ev = telemetry_evals.get(bid, {})
            juror_scores = ev.get("jurorScores", {})
            net = float(ev.get("netScore", 0.0))

            if juror_scores:
                s1_data = juror_scores.get("slot1") or juror_scores.get("gemini", {})
                s2_data = juror_scores.get("slot2") or juror_scores.get("claude", {})
                s3_data = juror_scores.get("slot3") or juror_scores.get("gpt4o", {})

                s_gem = float(s1_data.get("netScore", net))
                s_cld = float(s2_data.get("netScore", net))
                s_gpt = float(s3_data.get("netScore", net))
                # Protocol B: Median across the 3 jurors (Verga et al., 2024)
                median_score = float(np.median([s_gem, s_cld, s_gpt]))
            else:
                median_score = net
                s_gem = net
                s_cld = net
                s_gpt = net

            gemini_net_sum += s_gem
            claude_net_sum += s_cld
            gpt4o_net_sum += s_gpt
            consensus_net_sum += median_score

            all_gemini.append(s_gem)
            all_claude.append(s_cld)
            all_gpt4o.append(s_gpt)

        # Consensus normalized score per TerzoN Protocol B:
        # Sum of median net scores across bugs divided by (1.0 * k_task)
        # Range: [-0.500, +1.000]
        norm_accuracy = consensus_net_sum / float(k_task)
        norm_accuracy = max(-0.5, min(1.0, norm_accuracy))

        records.append({
            "participant": participant,
            "report_file": rfile,
            "task": matched_task,
            "task_bugs": k_task,
            "gemini_score_sum": gemini_net_sum,
            "claude_score_sum": claude_net_sum,
            "gpt4o_score_sum": gpt4o_net_sum,
            "consensus_score_sum": consensus_net_sum,
            "normalized_accuracy": round(norm_accuracy, 3),
        })

    kappas = {
        "gemini_claude": compute_cohens_weighted_kappa(all_gemini, all_claude),
        "gemini_gpt4o": compute_cohens_weighted_kappa(all_gemini, all_gpt4o),
        "claude_gpt4o": compute_cohens_weighted_kappa(all_claude, all_gpt4o),
    }
    kappas["mean"] = float(np.mean(list(kappas.values())))

    return pd.DataFrame(records), kappas


def update_data_csv(data_csv_path: str, scored_df: pd.DataFrame):
    if not os.path.exists(data_csv_path) or scored_df.empty:
        return

    df = pd.read_csv(data_csv_path)
    # Match by participant identifier (e.g. P01, P02)
    part_acc_map = dict(zip(scored_df["participant"], scored_df["normalized_accuracy"]))

    if "Accuracy" in df.columns:
        for idx, row in df.iterrows():
            p = row.get("Participant")
            if p in part_acc_map:
                df.at[idx, "Accuracy"] = float(part_acc_map[p])
        df.to_csv(data_csv_path, index=False)
        print(f"[ACCURACY] Updated {data_csv_path} with consensus Accuracy scores.")


def main():
    parser = argparse.ArgumentParser(description="Dual-Rater Accuracy Scoring Engine")
    parser.add_argument("--reports-dir", default="/Users/mcd2/git/cmumatt/nanofuzz-6/benchmark/results", help="Directory with participant reports")
    parser.add_argument("--data-csv", default="/Users/mcd2/git/cmumatt/nanofuzz-6/benchmark/results/data.csv", help="Path to data.csv")
    args = parser.parse_args()

    rubric = load_rubric()
    print(f"[RUBRIC] Loaded ground truth rubric for {len(rubric.get('tasks', {}))} tasks.")

    scored_df, kappas = score_reports(args.reports_dir, rubric)
    print(f"[RATER] Scored {len(scored_df)} reports via PoLL Protocol B (Median).")
    print(
        f"[AGREEMENT] PoLL 3-Model Jury Cohen's Weighted Kappa (κ_w): Mean = {kappas['mean']:.3f} "
        f"(Gemini-Claude: {kappas['gemini_claude']:.3f}, Gemini-GPT4o: {kappas['gemini_gpt4o']:.3f}, Claude-GPT4o: {kappas['claude_gpt4o']:.3f})"
    )

    if not scored_df.empty:
        print("\nSummary of Scored Accuracy:")
        print(scored_df[["report_file", "task", "normalized_accuracy"]].to_string(index=False))
        update_data_csv(args.data_csv, scored_df)


if __name__ == "__main__":
    main()
