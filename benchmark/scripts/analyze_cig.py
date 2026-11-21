#!/usr/bin/env python3
# type: ignore
"""
CIG Empirical Factorial Study Analysis Pipeline
Composite Input Generator (CIG) evaluation across 6 treatments:
SCRAM, CR, R (control), RA, RM, SR.

Generates complete suite of dissertation-aligned tables and figures:
  parts/data-cig.tex (LaTeX macros and statistical indicators)
  parts/tab-cig-trials.tex (Table: Factorial Matrix Allocation)
  parts/tab-cig-results.tex (Table: Factorial Results vs Control R)
  parts/tab-cig-results-detail.tex (Table: Detailed Results by Measure and PUT)
  parts/tab-cig-ttests.tex (Table: Statistical Significance vs Control R)
  parts/tab-cig-bugs.tex (Table: Ground-Truth Defect Elicitation Matrix)
  parts/tab-cig-generators.tex (Table: Generator Provenance Breakdown)
  parts/provenance-cig.tex (Listing: Representative Mutation Lineages)
  figures/pyplots-cig.pdf & parts/pyplots-cig.pdf (Distribution Plots)
"""

import argparse
import glob
import json
import os
import sys
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

from analysis_common import (
    pvalrange,
    pvalstars,
    star_alignment,
    format_delta_pct,
    compute_ttest,
    compute_fisher_exact,
    compute_mann_whitney,
    format_sig_cell,
    parse_generator_chain,
    put_mathtt,
)

import numpy as np
import pandas as pd
import scipy.stats as st

mpl = None
plt = None
HAS_MATPLOTLIB = False

try:
    import matplotlib as mpl  # type: ignore
    import matplotlib.pyplot as plt  # type: ignore
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False

TASKS = ["TreeValue", "DerivationTree", "parse", "_distance_norm", "make_def"]
TASK_LABELS = {
    "TreeValue": r"\texttt{TreeValue}",
    "DerivationTree": r"\texttt{Derivation}",
    "parse": r"\texttt{parse}",
    "_distance_norm": r"\texttt{\_distance}",
    "make_def": r"\texttt{make\_def}",
}

TASKS_MAP = {
    "TreeValue": {"branches_total": 124, "bugs_count": 6},
    "DerivationTree": {"branches_total": 246, "bugs_count": 6},
    "parse": {"branches_total": 122, "bugs_count": 6},
    "_distance_norm": {"branches_total": 54, "bugs_count": 2},
    "make_def": {"branches_total": 8, "bugs_count": 3},
}

TREATMENTS = ["SCRAM", "CR", "R", "RA", "RM", "SR"]
CONTROL_TREATMENT = "R"

TREATMENT_LABELS = {
    "SCRAM": r"\textbf{SCRAM}",
    "CR": r"\textbf{CR}",
    "R": r"\textbf{R} \textit{(Control)}",
    "RA": r"\textbf{RA}",
    "RM": r"\textbf{RM}",
    "SR": r"\textbf{SR}",
}

TREATMENT_SHORT_TEXT = ["SCRAM", "CR", "R", "RA", "RM", "SR"]


def sanitize_dataset(df: pd.DataFrame):
    """Strictly validates data.csv: rejects missing, out-of-range, or corrupted data."""
    if df.empty:
        raise ValueError("CRITICAL: data.csv is empty! Rejecting invalid dataset.")

    required_cols = [
        "RunID", "Task", "Treatment", "Replicate",
        "ToolVersion",
        "BranchCoveragePct", "BranchesCovered", "BranchesTotal",
        "BugsElicited", "TaskBugCount", "BugElicitationRate",
        "TotalTestsExecuted", "ElapsedSec", "ExitCode", "StopReason", "Attempts", "Status"
    ]
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        raise ValueError(f"CRITICAL: data.csv is missing required columns: {missing}")

    for _, row in df.iterrows():
        rid = row["RunID"]
        task = row["Task"]
        tr = row["Treatment"]

        if row["Status"] != "COMPLETED":
            raise ValueError(
                f"CRITICAL: Trial {rid} ({task} under {tr}) has Status='{row['Status']}'. "
                f"Failed or incomplete runs cannot be admitted into analysis."
            )

        if task not in TASKS_MAP:
            raise ValueError(f"CRITICAL: Unknown task '{task}' in trial {rid}.")

        if tr not in TREATMENTS:
            raise ValueError(f"CRITICAL: Unknown treatment '{tr}' in trial {rid}.")

        expected_branches = TASKS_MAP[task]["branches_total"]
        actual_branches = row["BranchesTotal"]
        if actual_branches != expected_branches:
            raise ValueError(
                f"CRITICAL: Branch denominator mismatch in trial {rid} ({task}): "
                f"expected {expected_branches}, got {actual_branches}."
            )

        cov = row["BranchCoveragePct"]
        if pd.isna(cov) or cov < 0.0 or cov > 100.0:
            raise ValueError(f"CRITICAL: Invalid BranchCoveragePct={cov} in trial {rid}.")

        rate = row["BugElicitationRate"]
        if pd.isna(rate) or rate < 0.0 or rate > 1.0:
            raise ValueError(f"CRITICAL: Invalid BugElicitationRate={rate} in trial {rid}.")

        tests = row["TotalTestsExecuted"]
        if pd.isna(tests) or tests <= 0:
            raise ValueError(f"CRITICAL: Trial {rid} executed {tests} tests. TotalTestsExecuted must be strictly positive.")

        elapsed = row["ElapsedSec"]
        if pd.isna(elapsed) or elapsed < 0:
            raise ValueError(f"CRITICAL: Invalid ElapsedSec={elapsed} in trial {rid}.")

        exit_code = row["ExitCode"]
        if exit_code not in (0, 1):
            raise ValueError(
                f"CRITICAL: Trial {rid} has invalid ExitCode={exit_code}. "
                f"Only 0 (clean run) or 1 (test failures found) are valid completed trials."
            )

        stop_reason = str(row["StopReason"])
        if not stop_reason or stop_reason in ("unknown", "None", "nan"):
            raise ValueError(f"CRITICAL: Trial {rid} has missing or unknown StopReason='{stop_reason}'.")

        tool_ver = str(row.get("ToolVersion", ""))
        if not tool_ver or tool_ver in ("unknown", "None", "nan"):
            raise ValueError(f"CRITICAL: Trial {rid} has missing or unknown ToolVersion='{tool_ver}'.")

    # Assert balanced, even factorial matrix across all tasks and treatments
    cell_counts = {}
    for task in TASKS:
        for tr in TREATMENTS:
            cnt = len(df[(df["Task"] == task) & (df["Treatment"] == tr)])
            if cnt == 0:
                raise ValueError(
                    f"CRITICAL: Uneven / incomplete matrix: Cell ({task}, {tr}) has 0 observations. "
                    f"Rejecting uneven dataset to prevent skewed and fabricated aggregates."
                )
            cell_counts[(task, tr)] = cnt

    expected_reps = list(cell_counts.values())[0]
    for cell, cnt in cell_counts.items():
        if cnt != expected_reps:
            raise ValueError(
                f"CRITICAL: Uneven matrix: Cell {cell} has {cnt} trials, expected {expected_reps}. "
                f"All cells must have equal replicates for balanced factorial analysis."
            )


def analyze_cig_dataset(df: pd.DataFrame) -> dict:
    """Computes descriptive and inferential statistics across treatments and tasks."""
    stats = {}
    measures = ["BugElicitationRate", "BranchCoveragePct", "BugsElicited", "TotalTestsExecuted", "ElapsedSec"]

    for tr in TREATMENTS:
        stats[tr] = {}
        tr_df = df[df["Treatment"] == tr] if not df.empty else pd.DataFrame()

        for task in TASKS:
            stats[tr][task] = {}
            task_df = tr_df[tr_df["Task"] == task] if not tr_df.empty else pd.DataFrame()
            ctl_df = df[(df["Treatment"] == CONTROL_TREATMENT) & (df["Task"] == task)] if not df.empty else pd.DataFrame()

            for col in measures:
                s_int = task_df[col].dropna().values.astype(float) if col in task_df.columns else np.array([])
                s_ctl = ctl_df[col].dropna().values.astype(float) if col in ctl_df.columns else np.array([])

                # No observation does NOT mean zero: use NaN when unobserved, and undefined SD for n < 2
                m_val = float(np.mean(s_int)) if len(s_int) > 0 else float(np.nan)
                sd_val = float(np.std(s_int, ddof=1)) if len(s_int) > 1 else float(np.nan)
                p_val = compute_ttest(s_int, s_ctl) if tr != CONTROL_TREATMENT else float(np.nan)
                mw_p, mw_stat = compute_mann_whitney(s_int, s_ctl) if tr != CONTROL_TREATMENT else (float(np.nan), float(np.nan))

                stats[tr][task][col] = {
                    "mean": m_val,
                    "sd": sd_val,
                    "pvalue": p_val,
                    "mann_whitney_p": mw_p,
                    "mann_whitney_u": mw_stat,
                    "n": len(s_int),
                }

        # Overall summary across all tasks
        stats[tr]["All"] = {}
        ctl_all_df = df[df["Treatment"] == CONTROL_TREATMENT] if not df.empty else pd.DataFrame()
        for col in measures:
            s_int = tr_df[col].dropna().values.astype(float) if col in tr_df.columns else np.array([])
            s_ctl = ctl_all_df[col].dropna().values.astype(float) if col in ctl_all_df.columns else np.array([])

            m_val = float(np.mean(s_int)) if len(s_int) > 0 else float(np.nan)
            sd_val = float(np.std(s_int, ddof=1)) if len(s_int) > 1 else float(np.nan)
            p_val = compute_ttest(s_int, s_ctl) if tr != CONTROL_TREATMENT else float(np.nan)
            mw_p, mw_stat = compute_mann_whitney(s_int, s_ctl) if tr != CONTROL_TREATMENT else (float(np.nan), float(np.nan))

            stats[tr]["All"][col] = {
                "mean": m_val,
                "sd": sd_val,
                "pvalue": p_val,
                "mann_whitney_p": mw_p,
                "mann_whitney_u": mw_stat,
                "n": len(s_int),
            }

    return stats


def generate_pyplots(df: pd.DataFrame, pdf_paths: List[str]):
    """Generates distribution violin and jitter plots for CIG treatments."""
    if not HAS_MATPLOTLIB:
        print("[WARN] matplotlib not available, skipping plot generation.")
        return

    # Crash if any cell is missing: no observation cannot be plotted as 0.0
    for task in TASKS:
        for t in TREATMENTS:
            sub = df[(df["Task"] == task) & (df["Treatment"] == t)]
            vals = sub["BranchCoveragePct"].dropna().values.astype(float) if not sub.empty else []
            if len(vals) == 0:
                raise ValueError(
                    f"CRITICAL: Cannot generate pyplots: Task '{task}' has missing observations for treatment '{t}'. "
                    f"Fabricating data or plotting unobserved tasks is strictly prohibited."
                )

    mpl.rcParams["font.family"] = "serif"
    mpl.rcParams["font.size"] = 7.5
    mpl.rcParams["axes.labelweight"] = "bold"

    fig = plt.figure(figsize=(8.5, 5.8))
    subfigs = fig.subfigures(2, 1, height_ratios=[1, 1])

    subfigs[0].subplots_adjust(left=0.07, right=0.98, bottom=0.26, top=0.92, wspace=0.35)
    axs_r1 = subfigs[0].subplots(1, 4)
    fig.canvas.draw()

    pos0 = axs_r1[0].get_position()
    pos3 = axs_r1[3].get_position()
    width = pos0.width
    height = pos0.height
    y0 = pos0.y0
    x0_left = pos0.x0
    x3_left = pos3.x0
    x_mid = (x0_left + x3_left) / 2.0

    axs_r2 = [
        subfigs[1].add_axes([x0_left, y0, width, height]),
        subfigs[1].add_axes([x_mid, y0, width, height]),
        subfigs[1].add_axes([x3_left, y0, width, height]),
    ]

    def render_violin_cell(ax, data, group_labels, xlabel, ylabel, ylim):
        ax.set_xticks(list(range(1, len(group_labels) + 1)))
        ax.set_xticklabels(group_labels, rotation=35, ha="right", fontsize=6.5)
        ax.spines[:].set_visible(False)
        ax.tick_params(axis="both", which="both", bottom=False, left=False)
        ax.set_xlabel(xlabel, fontsize=7.5, labelpad=4)
        ax.set_ylabel(ylabel, fontsize=7)
        if ylim:
            ax.set_ylim(ylim)

        violins = ax.violinplot(data, widths=0.7, showextrema=False)
        for pc in violins.get("bodies", []):
            pc.set_facecolor("none")
            pc.set_edgecolor("black")
            pc.set_alpha(1.0)
            pc.set_linewidth(1.0)

        for i, vals in enumerate(data):
            x = i + 1
            if len(vals) > 0:
                jitter = x + np.random.normal(0, 0.04, len(vals))
                ax.scatter(jitter, vals, s=11, color="grey", alpha=0.5, edgecolors="none")
                ax.scatter(x, np.mean(vals), s=32, color="black", zorder=3)

    # Row 1: Branch Coverage (%) for first 4 PUTs
    for c_idx, task in enumerate(TASKS[:4]):
        ax = axs_r1[c_idx]
        data = []
        for t in TREATMENTS:
            sub = df[(df["Task"] == task) & (df["Treatment"] == t)]
            vals = sub["BranchCoveragePct"].dropna().values.astype(float)
            data.append(vals)
        render_violin_cell(ax, data, TREATMENT_SHORT_TEXT, f"Branch Coverage\n{put_mathtt(task)}", "Branch Cov. (%)", (0, 105))

    # Row 2: 5th PUT Coverage, Task Time, Bugs Elicited
    task_5 = TASKS[4]
    ax_5 = axs_r2[0]
    data_5 = []
    for t in TREATMENTS:
        sub = df[(df["Task"] == task_5) & (df["Treatment"] == t)]
        vals = sub["BranchCoveragePct"].dropna().values.astype(float)
        data_5.append(vals)
    render_violin_cell(ax_5, data_5, TREATMENT_SHORT_TEXT, f"Branch Coverage\n{put_mathtt(task_5)}", "Branch Cov. (%)", (0, 105))

    ax_time = axs_r2[1]
    data_time = []
    for t in TREATMENTS:
        sub = df[df["Treatment"] == t]
        vals = sub["ElapsedSec"].dropna().values.astype(float)
        data_time.append(vals)
    render_violin_cell(ax_time, data_time, TREATMENT_SHORT_TEXT, "Task Time (s)", "Elapsed Time (s)", None)

    ax_bugs = axs_r2[2]
    data_bugs = []
    for t in TREATMENTS:
        sub = df[df["Treatment"] == t]
        vals = sub["BugsElicited"].dropna().values.astype(float)
        data_bugs.append(vals)
    render_violin_cell(ax_bugs, data_bugs, TREATMENT_SHORT_TEXT, "Bugs Elicited", "Bugs Elicited (Count)", (0, 6.5))

    for p in pdf_paths:
        os.makedirs(os.path.dirname(os.path.abspath(p)), exist_ok=True)
        fig.savefig(p, format="pdf", bbox_inches="tight")
        print(f"[PLOT] Generated distribution plot: {p}")
    plt.close(fig)


def generate_trials_table(df: pd.DataFrame, out_path: str):
    """Generates the trial allocation matrix table."""
    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \small",
        r"  \caption{Empirical Trial Allocation Matrix across Generator Treatments and Target PUTs}",
        r"  \label{tab:cig-trials}",
        r"  \begin{tabular}{l|ccccc}",
        r"    \toprule",
        r"    \textbf{Treatment} & \textbf{\texttt{TreeValue}} & \textbf{\texttt{Derivation}} & \textbf{\texttt{parse}} & \textbf{\texttt{\_distance}} & \textbf{\texttt{make\_def}} \\",
        r"    \midrule",
    ]

    for tr in TREATMENTS:
        row_cells = [TREATMENT_LABELS.get(tr, tr)]
        for task in TASKS:
            sub = df[(df["Treatment"] == tr) & (df["Task"] == task)] if not df.empty else pd.DataFrame()
            rids = sub["RunID"].tolist() if "RunID" in sub.columns else []
            cell_text = ", ".join(rids) if rids else "--"
            row_cells.append(cell_text)
        lines.append("    " + " & ".join(row_cells) + r" \\")

    lines.extend([
        r"    \bottomrule",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Trial Allocation Table: {out_path}")


def generate_cig_results_table(df: pd.DataFrame, out_path: str, stats: dict):
    """Generates the main LaTeX factorial results table comparing treatments vs control R."""
    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \setlength{\tabcolsep}{3pt}",
        r"  \definecolor{bettergreen}{RGB}{169,223,192}",
        r"  \definecolor{worsered}{RGB}{245,183,177}",
        r"  \caption{Empirical Evaluation of Composite Input Generator (CIG) Treatments vs.\ Control (R)}",
        r"  \label{tab:cig-results}",
        r"  \begin{tabular}{l|rr|rr|rr|rr|rr||rr}",
        r"    \toprule",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{TreeValue}}}",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{Derivation}}}",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{parse}}}",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{\_distance}}}",
        r"    & \multicolumn{2}{c||}{\textbf{\texttt{make\_def}}}",
        r"    & \multicolumn{2}{c}{\textbf{Overall ($\Sigma$)}} \\",
        r"    \midrule",
        r"    \multicolumn{1}{c|}{\textbf{Treatment}} ",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} & \textbf{SD} \\",
    ]

    measures = [
        ("BugElicitationRate", r"Measure 1: Bug Elicitation Rate; higher is better", 3),
        ("BranchCoveragePct", r"Measure 2: Branch Coverage (\%); higher is better", 1),
        ("TotalTestsExecuted", r"Measure 3: Total Tests Executed; higher is better", 0),
        ("ElapsedSec", r"Measure 4: Wall-clock Runtime (seconds); lower is better", 0),
    ]

    for col, title, dec in measures:
        lines.extend([
            r"    \midrule",
            f"    \\multicolumn{{13}}{{c}}{{\\textbf{{{title}}}}} \\\\",
            r"    \midrule",
        ])

        for tr in TREATMENTS:
            label = TREATMENT_LABELS.get(tr, tr)
            row_items = [f"    {label}"]
            ctl_m_all = stats[CONTROL_TREATMENT]["All"][col]["mean"]

            for task in TASKS:
                m_val = stats[tr][task][col]["mean"]
                sd_val = stats[tr][task][col]["sd"]
                ctl_m = stats[CONTROL_TREATMENT][task][col]["mean"]
                p_val = stats[tr][task][col].get("pvalue", None)
                # Formats as \multicolumn{2}{c}{--} if unobserved (NaN)
                row_items.append(format_sig_cell(tr, col, m_val, sd_val, ctl_m, p_val, dec, base_tool=CONTROL_TREATMENT))

            all_m = stats[tr]["All"][col]["mean"]
            all_sd = stats[tr]["All"][col]["sd"]
            all_p_val = stats[tr]["All"][col].get("pvalue", None)
            row_items.append(format_sig_cell(tr, col, all_m, all_sd, ctl_m_all, all_p_val, dec, base_tool=CONTROL_TREATMENT))

            lines.append(" & ".join(row_items) + r" \\")
            if tr != TREATMENTS[-1]:
                lines.append(r"    \hline")

    lines.extend([
        r"    \bottomrule",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated CIG Results Table: {out_path}")


def generate_results_detail_table(df: pd.DataFrame, out_path: str, stats: dict):
    """Generates detailed summary table with min, mean, max, and totals across treatments."""
    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \small",
        r"  \caption{Detailed Experimental Outcomes by Generator Treatment across Measures}",
        r"  \label{tab:cig-results-detail}",
        r"  \begin{tabular}{l|cccccc}",
        r"    \toprule",
        r"    \textbf{Metric} & \textbf{SCRAM} & \textbf{CR} & \textbf{R} & \textbf{RA} & \textbf{RM} & \textbf{SR} \\",
        r"    \midrule",
        r"    \multicolumn{7}{c}{\textbf{Measure 1: Branch Coverage (\%)}} \\",
        r"    \midrule",
    ]

    for label, col, fmt in [
        ("Max Coverage", "BranchCoveragePct", ".1f"),
        ("Mean Coverage", "BranchCoveragePct", ".1f"),
        ("Min Coverage", "BranchCoveragePct", ".1f"),
    ]:
        row = [f"    {label}"]
        for tr in TREATMENTS:
            sub = df[df["Treatment"] == tr] if not df.empty else pd.DataFrame()
            vals = sub[col].dropna().values.astype(float) if col in sub.columns else []
            if len(vals) == 0:
                row.append("--")
            elif label.startswith("Max"):
                row.append(f"{np.max(vals):{fmt}}\\%")
            elif label.startswith("Mean"):
                row.append(f"{np.mean(vals):{fmt}}\\%")
            else:
                row.append(f"{np.min(vals):{fmt}}\\%")
        lines.append(" & ".join(row) + r" \\")

    lines.extend([
        r"    \midrule",
        r"    \multicolumn{7}{c}{\textbf{Measure 2: Bugs Elicited}} \\",
        r"    \midrule",
    ])

    total_el_row = ["    Total Bugs Elicited"]
    for tr in TREATMENTS:
        sub = df[df["Treatment"] == tr] if not df.empty else pd.DataFrame()
        tot = int(sub["BugsElicited"].sum()) if "BugsElicited" in sub.columns and len(sub) > 0 else 0
        total_el_row.append(str(tot) if len(sub) > 0 else "--")
    lines.append(" & ".join(total_el_row) + r" \\")

    mean_el_row = ["    Mean Bugs / Trial"]
    for tr in TREATMENTS:
        sub = df[df["Treatment"] == tr] if not df.empty else pd.DataFrame()
        m = float(sub["BugsElicited"].mean()) if "BugsElicited" in sub.columns and len(sub) > 0 else float(np.nan)
        mean_el_row.append(f"{m:.2f}" if not np.isnan(m) else "--")
    lines.append(" & ".join(mean_el_row) + r" \\")

    lines.extend([
        r"    \midrule",
        r"    \multicolumn{7}{c}{\textbf{Measure 3: Execution Scale}} \\",
        r"    \midrule",
    ])

    mean_tests_row = ["    Mean Tests Executed"]
    for tr in TREATMENTS:
        sub = df[df["Treatment"] == tr] if not df.empty else pd.DataFrame()
        m = float(sub["TotalTestsExecuted"].mean()) if "TotalTestsExecuted" in sub.columns and len(sub) > 0 else float(np.nan)
        mean_tests_row.append(f"{m:.0f}" if not np.isnan(m) else "--")
    lines.append(" & ".join(mean_tests_row) + r" \\")

    mean_time_row = ["    Mean Task Time (s)"]
    for tr in TREATMENTS:
        sub = df[df["Treatment"] == tr] if not df.empty else pd.DataFrame()
        m = float(sub["ElapsedSec"].mean()) if "ElapsedSec" in sub.columns and len(sub) > 0 else float(np.nan)
        mean_time_row.append(f"{m:.1f}s" if not np.isnan(m) else "--")
    lines.append(" & ".join(mean_time_row) + r" \\")

    lines.extend([
        r"    \bottomrule",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Results Detail Table: {out_path}")


def generate_ttest_table(df: pd.DataFrame, out_path: str, stats: dict):
    """Generates formal hypothesis testing results table comparing treatments vs Control R."""
    def t_stats(s1, s2):
        s1 = s1.dropna().values.astype(float)
        s2 = s2.dropna().values.astype(float)
        if len(s1) < 2 or len(s2) < 2:
            return {
                "m1": float(np.mean(s1)) if len(s1) else float(np.nan),
                "m2": float(np.mean(s2)) if len(s2) else float(np.nan),
                "delta_pct": float(np.nan),
                "t": float(np.nan),
                "df": float(np.nan),
                "p": float(np.nan),
            }
        res = st.ttest_ind(s1, s2, equal_var=False)
        m1, m2 = float(np.mean(s1)), float(np.mean(s2))
        delta_pct = (m1 / m2 - 1.0) * 100.0 if m2 != 0 else 0.0
        df_val = float(getattr(res, "df", np.nan))
        return {
            "m1": m1, "m2": m2,
            "delta_pct": delta_pct,
            "t": float(res.statistic),
            "df": df_val,
            "p": float(res.pvalue)
        }

    measures = [
        ("BugElicitationRate", r"Measure 1: Bug Elicitation Rate", True),
        ("BranchCoveragePct", r"Measure 2: Branch Coverage", True),
        ("TotalTestsExecuted", r"Measure 3: Tests Executed", True),
        ("ElapsedSec", r"Measure 4: Task Time (s)", False),
    ]

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \small",
        r"  \definecolor{bettergreen}{RGB}{169,223,192}",
        r"  \definecolor{worsered}{RGB}{245,183,177}",
        r"  \caption{Statistical Significance of Generator Treatments vs.\ Control (R)}",
        r"  \label{tab:cig-ttests}",
        r"  \begin{tabular}{l | r l c r}",
        r"    \toprule",
        r"    \multicolumn{1}{c|}{\textbf{Measure}} & \multicolumn{1}{c}{\textbf{$\Delta$}} & \multicolumn{1}{c}{\textbf{Test}} & \multicolumn{1}{c}{\textbf{Statistic}} & \multicolumn{1}{c}{\textbf{$p$}} \\",
    ]

    compare_treatments = [t for t in TREATMENTS if t != CONTROL_TREATMENT]

    for tr in compare_treatments:
        header = f"\\textbf{{{tr} vs.\\ {CONTROL_TREATMENT} (Control)}}"
        lines.extend([
            r"    \midrule",
            f"    \\multicolumn{{5}}{{c}}{{{header}}} \\\\",
            r"    \midrule",
        ])

        for col, name, higher_is_better in measures:
            if col == "BranchCoveragePct":
                s_tool = df[df["Treatment"] == tr][col].dropna().values
                s_ctl = df[df["Treatment"] == CONTROL_TREATMENT][col].dropna().values
                p_val, u_stat = compute_mann_whitney(s_tool, s_ctl)
                test_str = "Mann--Whitney $U$"

                if np.isnan(p_val) or np.isnan(u_stat):
                    row = f"    {name} & -- & {test_str} & -- & n/a \\\\"
                else:
                    m1 = float(np.mean(s_tool)) if len(s_tool) else 0.0
                    m2 = float(np.mean(s_ctl)) if len(s_ctl) else 0.0
                    delta_pct = (m1 / m2 - 1.0) * 100.0 if m2 != 0 else 0.0
                    sign = "+" if delta_pct >= 0 else ""
                    delta_str = f"{sign}{delta_pct:.1f}\\%"
                    stat_str = f"$U = {u_stat:.0f}$"
                    p_str = f"{p_val:.4f}" if p_val >= 0.0001 else "$<$0.0001"
                    star = star_alignment(p_val)
                    is_sig = p_val < 0.05
                    is_better = delta_pct > 0
                    color = "bettergreen" if is_better else "worsered"
                    if is_sig:
                        row = f"    {name} & \\cellcolor{{{color}}}{delta_str} & \\cellcolor{{{color}}}{test_str} & \\cellcolor{{{color}}}{stat_str} & \\cellcolor{{{color}}}{p_str}{star} \\\\"
                    else:
                        row = f"    {name} & {delta_str} & {test_str} & {stat_str} & {p_str}{star} \\\\"

            elif col == "BugsElicited":
                el_tool = int(df[df["Treatment"] == tr]["BugsElicited"].sum()) if not df.empty and len(df[df["Treatment"] == tr]) > 0 else 0
                el_ctl = int(df[df["Treatment"] == CONTROL_TREATMENT]["BugsElicited"].sum()) if not df.empty and len(df[df["Treatment"] == CONTROL_TREATMENT]) > 0 else 0
                tot_tool = int(df[df["Treatment"] == tr]["TaskBugCount"].sum()) if not df.empty and len(df[df["Treatment"] == tr]) > 0 else 0
                tot_ctl = int(df[df["Treatment"] == CONTROL_TREATMENT]["TaskBugCount"].sum()) if not df.empty and len(df[df["Treatment"] == CONTROL_TREATMENT]) > 0 else 0
                test_str = "Fisher's exact"

                if tot_tool == 0 or tot_ctl == 0:
                    row = f"    {name} & -- & {test_str} & -- & n/a \\\\"
                else:
                    p_val = compute_fisher_exact(el_tool, tot_tool, el_ctl, tot_ctl)
                    if np.isnan(p_val):
                        row = f"    {name} & -- & {test_str} & -- & n/a \\\\"
                    else:
                        delta_pct = (el_tool / el_ctl - 1.0) * 100.0 if el_ctl != 0 else 0.0
                        sign = "+" if delta_pct >= 0 else ""
                        delta_str = f"{sign}{delta_pct:.1f}\\%"
                        fish_table = [[el_tool, max(0, tot_tool - el_tool)], [el_ctl, max(0, tot_ctl - el_ctl)]]
                        try:
                            odds_ratio = float(st.fisher_exact(fish_table).statistic)
                        except Exception:
                            odds_ratio = float(np.nan)
                        stat_str = f"$\\text{{OR}} = {odds_ratio:.2f}$" if not np.isnan(odds_ratio) else "--"
                        p_str = f"{p_val:.4f}"
                        star = star_alignment(p_val)
                        is_sig = p_val < 0.05
                        is_better = delta_pct > 0
                        color = "bettergreen" if is_better else "worsered"
                        if is_sig:
                            row = f"    {name} & \\cellcolor{{{color}}}{delta_str} & \\cellcolor{{{color}}}{test_str} & \\cellcolor{{{color}}}{stat_str} & \\cellcolor{{{color}}}{p_str}{star} \\\\"
                        else:
                            row = f"    {name} & {delta_str} & {test_str} & {stat_str} & {p_str}{star} \\\\"
            else:
                s_tool = df[df["Treatment"] == tr][col] if not df.empty else pd.Series([])
                s_ctl = df[df["Treatment"] == CONTROL_TREATMENT][col] if not df.empty else pd.Series([])
                r = t_stats(s_tool, s_ctl)
                test_str = "Two-tailed $t$-test"

                if np.isnan(r["p"]) or np.isnan(r["t"]):
                    row = f"    {name} & -- & {test_str} & -- & n/a \\\\"
                else:
                    is_sig = r["p"] < 0.05
                    is_better = (r["m1"] > r["m2"]) if higher_is_better else (r["m1"] < r["m2"])
                    color = "bettergreen" if is_better else "worsered"
                    star = star_alignment(r["p"])
                    sign = "+" if r["delta_pct"] >= 0 else ""
                    delta_str = f"{sign}{r['delta_pct']:.1f}\\%"
                    stat_str = f"$t({r['df']:.1f}) = {r['t']:+.2f}$"
                    p_str = f"{r['p']:.4f}" if r["p"] >= 0.0001 else "$<$0.0001"
                    if is_sig:
                        row = f"    {name} & \\cellcolor{{{color}}}{delta_str} & \\cellcolor{{{color}}}{test_str} & \\cellcolor{{{color}}}{stat_str} & \\cellcolor{{{color}}}{p_str}{star} \\\\"
                    else:
                        row = f"    {name} & {delta_str} & {test_str} & {stat_str} & {p_str}{star} \\\\"

            lines.append(row)

    lines.extend([
        r"    \bottomrule",
        r"    \multicolumn{5}{c}{Statistically significant differences are marked as: $\ast$ ($p\!<\!0.05$), $\ast\ast$ ($p\!<\!0.01$). Uncomputed tests with $n<2$ are reported as n/a.} \\",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Hypothesis Testing Table: {out_path}")


def generate_bugs_elicited_table(df: pd.DataFrame, out_path: str):
    """Generates the ground-truth defect elicitation and detection matrix across treatments."""
    rubric_path = os.path.join(os.path.dirname(__file__), "ground_truth_rubric.json")
    if not os.path.exists(rubric_path):
        raise FileNotFoundError(f"CRITICAL: ground_truth_rubric.json not found at {rubric_path}")

    with open(rubric_path, "r", encoding="utf-8") as f:
        rubric = json.load(f)

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \small",
        r"  \caption{Ground-Truth Defect Elicitation Counts across Generator Treatments}",
        r"  \label{tab:cig-bugs}",
        r"  \begin{tabular}{ll|rrrrrr}",
        r"    \toprule",
        r"    \textbf{Target PUT} & \textbf{Defect ID} & \textbf{SCRAM} & \textbf{CR} & \textbf{R} & \textbf{RA} & \textbf{RM} & \textbf{SR} \\",
        r"    \midrule",
    ]

    treatment_totals = {t: 0 for t in TREATMENTS}
    treatment_unique = {t: 0 for t in TREATMENTS}

    for task in TASKS:
        bugs = rubric.get("tasks", {}).get(task, {}).get("bugs", {})
        task_label = TASK_LABELS.get(task, task)
        first_row = True

        for bid in sorted(bugs.keys()):
            prefix = task_label if first_row else ""
            first_row = False
            escaped_bid = bid.replace("_", r"\_")

            counts = []
            for t in TREATMENTS:
                sub = df[df["Treatment"] == t] if not df.empty else pd.DataFrame()
                hits = 0
                if bid in sub.columns:
                    hits = int((sub[bid] == 1).sum())
                counts.append(str(hits))
                treatment_totals[t] += hits
                if hits > 0:
                    treatment_unique[t] += 1

            lines.append(f"    {prefix} & \\texttt{{{escaped_bid}}} & " + " & ".join(counts) + r" \\")
        lines.append(r"    \midrule")

    total_rubric_bugs = sum(len(rubric.get("tasks", {}).get(t, {}).get("bugs", {})) for t in TASKS)
    lines.extend([
        f"    \\multicolumn{{2}}{{l|}}{{\\textbf{{Total Elicitations}}}} & " + " & ".join(str(treatment_totals[t]) for t in TREATMENTS) + r" \\",
        r"    \hline",
        f"    \\multicolumn{{2}}{{l|}}{{\\textbf{{Unique Defects Elicited (out of {total_rubric_bugs})}}}} & " + " & ".join(str(treatment_unique[t]) for t in TREATMENTS) + r" \\",
        r"    \bottomrule",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Ground-Truth Defect Matrix Table: {out_path}")


def generate_stop_reasons_table(df: pd.DataFrame, out_path: str):
    """Generates stop reason and exit code breakdown table across tasks and treatments."""
    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \small",
        r"  \caption{Fuzzer Termination Reasons and Exit Codes by Target PUT and Treatment}",
        r"  \label{tab:cig-stop-reasons}",
        r"  \begin{tabular}{ll|rrrr|rr}",
        r"    \toprule",
        r"    \textbf{Target PUT} & \textbf{Treatment} & \textbf{maxTime} & \textbf{maxDupes} & \textbf{maxTests} & \textbf{Other} & \textbf{Exit 0} & \textbf{Exit 1} \\",
        r"    \midrule",
    ]

    for task in TASKS:
        task_label = TASK_LABELS.get(task, task)
        first_row = True
        for tr in TREATMENTS:
            prefix = task_label if first_row else ""
            first_row = False
            sub = df[(df["Task"] == task) & (df["Treatment"] == tr)] if not df.empty else pd.DataFrame()
            n_time = int((sub["StopReason"] == "maxTime").sum()) if "StopReason" in sub.columns else 0
            n_dupes = int((sub["StopReason"] == "maxDupes").sum()) if "StopReason" in sub.columns else 0
            n_tests = int((sub["StopReason"] == "maxTests").sum()) if "StopReason" in sub.columns else 0
            n_other = len(sub) - (n_time + n_dupes + n_tests)
            n_exit0 = int((sub["ExitCode"] == 0).sum()) if "ExitCode" in sub.columns else 0
            n_exit1 = int((sub["ExitCode"] == 1).sum()) if "ExitCode" in sub.columns else 0
            tr_label = TREATMENT_LABELS.get(tr, tr)
            lines.append(
                f"    {prefix} & {tr_label} & {n_time} & {n_dupes} & {n_tests} & {n_other} & {n_exit0} & {n_exit1} \\\\"
            )
        lines.append(r"    \midrule")

    tot_time = int((df["StopReason"] == "maxTime").sum()) if "StopReason" in df.columns else 0
    tot_dupes = int((df["StopReason"] == "maxDupes").sum()) if "StopReason" in df.columns else 0
    tot_tests = int((df["StopReason"] == "maxTests").sum()) if "StopReason" in df.columns else 0
    tot_other = len(df) - (tot_time + tot_dupes + tot_tests)
    tot_exit0 = int((df["ExitCode"] == 0).sum()) if "ExitCode" in df.columns else 0
    tot_exit1 = int((df["ExitCode"] == 1).sum()) if "ExitCode" in df.columns else 0

    lines.extend([
        f"    \\multicolumn{{2}}{{l|}}{{\\textbf{{Total across all {len(df)} trials}}}} & {tot_time} & {tot_dupes} & {tot_tests} & {tot_other} & {tot_exit0} & {tot_exit1} \\\\",
        r"    \bottomrule",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Stop Reason Breakdown Table: {out_path}")


def generate_cig_generator_table(run_dir: str, out_path: str):
    """Generates generator provenance breakdown table for CIG trials."""
    rubric_path = os.path.join(os.path.dirname(__file__), "ground_truth_rubric.json")
    if not os.path.exists(rubric_path):
        raise FileNotFoundError(f"CRITICAL: ground_truth_rubric.json not found at {rubric_path}")

    with open(rubric_path, "r", encoding="utf-8") as f:
        rubric = json.load(f)

    artifact_pattern = os.path.join(run_dir, "artifacts", "*", "elicited_bugs.json")
    generator_hits: Dict[str, Dict[str, int]] = {}

    log_files = glob.glob(artifact_pattern)
    for logf in log_files:
        with open(logf, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                entry = json.loads(line)
                if entry.get("summary"):
                    continue
                bid = entry.get("bug_id")
                gen_chain = entry.get("generator", "")
                if bid and gen_chain:
                    eliciting, originating = parse_generator_chain(gen_chain)
                    if bid not in generator_hits:
                        generator_hits[bid] = {"seed": 0, "random": 0, "custom": 0, "ai": 0, "mutation": 0}
                    if eliciting in generator_hits[bid]:
                        generator_hits[bid][eliciting] += 1

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \caption{Defect Elicitation by Generator Class across CIG Empirical Trials}",
        r"  \label{tab:cig-generators}",
        r"  \begin{tabular}{ll|rrrrr|r}",
        r"    \toprule",
        r"    \textbf{Target PUT} & \textbf{Defect ID} & \textbf{Seed} & \textbf{Random} & \textbf{Custom} & \textbf{AI} & \textbf{Mutation} & \textbf{Total} \\",
        r"    \midrule",
    ]

    for task_name in TASKS:
        bugs = rubric.get("tasks", {}).get(task_name, {}).get("bugs", {})
        task_label = TASK_LABELS.get(task_name, task_name)
        first_row = True
        for bid in sorted(bugs.keys()):
            prefix = task_label if first_row else ""
            first_row = False
            b_counts = generator_hits.get(bid, {"seed": 0, "random": 0, "custom": 0, "ai": 0, "mutation": 0})
            tot = sum(b_counts.values())
            escaped_bid = bid.replace("_", r"\_")
            lines.append(
                f"    {prefix} & \\texttt{{{escaped_bid}}} & {b_counts['seed']} & {b_counts['random']} & {b_counts['custom']} & {b_counts['ai']} & {b_counts['mutation']} & {tot} \\\\"
            )
        lines.append(r"    \midrule")

    lines.extend([
        r"    \bottomrule",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated CIG Generator Breakdown Table: {out_path}")


def generate_provenance_listing(run_dir: str, out_path: str, df: Optional[pd.DataFrame] = None):
    """
    Generates representative multi-step mutation lineage listing for thesis integration.
    Selection hierarchy:
      1. Longest chain for a defect found by SCRAM but not by any other treatment.
      2. If none, longest chain for a defect not elicited by SR.
      3. If none, longest chain for a defect not elicited by R.
      4. Fallback to longest overall chain.
    Caption mentions the treatments that did not elicit it, with no bold, and uses 'Task Program'.
    """
    bug_treatments = defaultdict(set)
    run_tasks = {}
    if df is not None and not df.empty:
        for b in [c for c in df.columns if not c.endswith("_Validator") and c.isupper()]:
            for tr in TREATMENTS:
                sub = df[df["Treatment"] == tr]
                if not sub.empty and b in sub.columns and (sub[b] == 1).any():
                    bug_treatments[b].add(tr)
        for _, r in df.iterrows():
            run_tasks[r["RunID"]] = r["Task"]

    artifact_pattern = os.path.join(run_dir, "artifacts", "*", "elicited_bugs.json")
    all_candidates = []

    log_files = glob.glob(artifact_pattern)
    for logf in log_files:
        rid = os.path.basename(os.path.dirname(logf))
        with open(logf, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                entry = json.loads(line)
                if entry.get("summary"):
                    continue
                bid = entry.get("bug_id")
                chain = entry.get("generator", "")
                if bid and chain:
                    steps = len(chain.split("->"))
                    all_candidates.append({
                        "run_id": rid,
                        "bug_id": bid,
                        "task": run_tasks.get(rid, "unknown"),
                        "chain": chain,
                        "steps": steps,
                        "args": entry.get("args", []),
                    })

    if not all_candidates:
        return

    # Bucket candidates according to selection hierarchy
    p1 = [c for c in all_candidates if len(bug_treatments.get(c["bug_id"], set())) == 1 and "SCRAM" in bug_treatments.get(c["bug_id"], set())]
    p2 = [c for c in all_candidates if "SR" not in bug_treatments.get(c["bug_id"], set())]
    p3 = [c for c in all_candidates if "R" not in bug_treatments.get(c["bug_id"], set())]

    if p1:
        selected_pool = p1
    elif p2:
        selected_pool = p2
    elif p3:
        selected_pool = p3
    else:
        selected_pool = all_candidates

    selected = max(selected_pool, key=lambda x: x["steps"])
    max_steps = selected["steps"]

    chain_parts = selected["chain"].split("->")
    formatted_lines = []
    for i, p in enumerate(chain_parts):
        prefix = "Origin:  " if i == 0 else ("Elicit:  " if i == len(chain_parts) - 1 else "Mutate:  ")
        formatted_lines.append(f"{prefix}{p.strip()}")

    bid_tex = selected["bug_id"].replace("_", r"\_")
    task_tex = TASK_LABELS.get(selected["task"], selected["task"])

    not_elicited_by = [tr for tr in TREATMENTS if tr not in bug_treatments.get(selected["bug_id"], set())]
    unelicited_str = ", ".join(not_elicited_by) if not_elicited_by else "none"

    caption_text = (
        f"Multi-step generator lineage for defect \\texttt{{{bid_tex}}} in Task Program {task_tex}. "
        f"Trial Run: \\texttt{{{selected['run_id']}}}. "
        f"Total mutation steps: {max_steps}. "
        f"This defect was not elicited by: {unelicited_str}."
    )

    lines = [
        r"\begin{figure}[!htbp]",
        r"  \centering",
        r"  \small",
        r"  \begin{verbatim}",
        "\n".join(formatted_lines),
        "",
        f"Eliciting Input Args: {selected['args']}",
        r"  \end{verbatim}",
        f"  \\caption{{{caption_text}}}",
        f"  \\label{{fig:cig-provenance-{selected['bug_id'].lower().replace('_', '-')}}}",
        r"\end{figure}",
    ]

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[LISTING] Generated Representative Provenance Listing: {out_path}")


def generate_data_cig_tex(df: pd.DataFrame, out_path: str, stats: dict):
    """Outputs LaTeX macro definitions with key experimental metrics."""
    total_trials = len(df)
    completed_trials = len(df[df["Status"] == "COMPLETED"]) if not df.empty else 0
    total_runtime_sec = float(df["ElapsedSec"].sum()) if "ElapsedSec" in df.columns else 0.0

    tool_ver_str = str(df["ToolVersion"].dropna().iloc[0]) if "ToolVersion" in df.columns and not df["ToolVersion"].dropna().empty else "NaNofuzz"

    lines = [
        r"% Auto-generated summary variables for CIG empirical benchmark",
        f"\\newcommand{{\\cigToolVersion}}{{{tool_ver_str}}}",
        f"\\newcommand{{\\cigTotalTrials}}{{{total_trials}}}",
        f"\\newcommand{{\\cigCompletedTrials}}{{{completed_trials}}}",
        f"\\newcommand{{\\cigTotalRuntimeHours}}{{{total_runtime_sec / 3600.0:.1f}}}",
    ]

    for tr in TREATMENTS:
        tr_clean = tr.replace("_", "")
        rate_all = stats[tr]["All"]["BugElicitationRate"]["mean"]
        cov_all = stats[tr]["All"]["BranchCoveragePct"]["mean"]
        tests_all = stats[tr]["All"]["TotalTestsExecuted"]["mean"]
        p_rate = stats[tr]["All"]["BugElicitationRate"]["pvalue"]

        rate_str = f"{rate_all:.1%}" if not np.isnan(rate_all) else "--"
        cov_str = f"{cov_all:.1f}\\%" if not np.isnan(cov_all) else "--"
        tests_str = f"{tests_all:.0f}" if not np.isnan(tests_all) else "--"
        p_str = pvalrange(p_rate) if not np.isnan(p_rate) else "n/a"

        lines.extend([
            f"\\newcommand{{\\cig{tr_clean}ElicitationRate}}{{{rate_str}}}",
            f"\\newcommand{{\\cig{tr_clean}CoveragePct}}{{{cov_str}}}",
            f"\\newcommand{{\\cig{tr_clean}MeanTests}}{{{tests_str}}}",
            f"\\newcommand{{\\cig{tr_clean}PRange}}{{{p_str}}}",
        ])

    tot_time = int((df["StopReason"] == "maxTime").sum()) if "StopReason" in df.columns else 0
    tot_dupes = int((df["StopReason"] == "maxDupes").sum()) if "StopReason" in df.columns else 0
    tot_exit0 = int((df["ExitCode"] == 0).sum()) if "ExitCode" in df.columns else 0
    tot_exit1 = int((df["ExitCode"] == 1).sum()) if "ExitCode" in df.columns else 0

    lines.extend([
        f"\\newcommand{{\\cigTotalMaxTime}}{{{tot_time}}}",
        f"\\newcommand{{\\cigTotalMaxDupes}}{{{tot_dupes}}}",
        f"\\newcommand{{\\cigTotalExitCodeZero}}{{{tot_exit0}}}",
        f"\\newcommand{{\\cigTotalExitCodeOne}}{{{tot_exit1}}}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TEX] Generated CIG LaTeX Variables: {out_path}")


def main():
    parser = argparse.ArgumentParser(description="Analyze CIG experimental benchmark dataset")
    parser.add_argument("--data", type=str, default=None, help="Path to data.csv (defaults to latest)")
    parser.add_argument("--parts-dir", type=str, default=None, help="Destination directory for LaTeX parts")
    parser.add_argument("--smoke", action="store_true", help="Flag indicating dataset is a partial smoke test")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    bench_dir = os.path.abspath(os.path.join(script_dir, ".."))

    data_path = args.data
    if not data_path:
        latest_sym = os.path.join(bench_dir, "cli", "latest", "data.csv")
        if os.path.exists(latest_sym):
            data_path = latest_sym
        else:
            raise FileNotFoundError("CRITICAL: data.csv not specified and latest run not found.")

    print(f"[ANALYSIS] Loading dataset from: {data_path}")
    df = pd.read_csv(data_path)

    # FIRST STEP: Gatekeeper sanitization - crash immediately on corrupted/invalid data
    sanitize_dataset(df)
    print("  ✓ Strict input sanitization passed: 0 missing fields, valid ranges, all denominators verified.")

    run_dir = os.path.dirname(os.path.abspath(data_path))

    parts_dir = args.parts_dir or os.path.join(run_dir, "parts")
    os.makedirs(parts_dir, exist_ok=True)
    figures_dir = os.path.join(run_dir, "figures")
    os.makedirs(figures_dir, exist_ok=True)

    stats = analyze_cig_dataset(df)

    tab_trials = os.path.join(parts_dir, "tab-cig-trials.tex")
    generate_trials_table(df, tab_trials)

    tab_results = os.path.join(parts_dir, "tab-cig-results.tex")
    generate_cig_results_table(df, tab_results, stats)

    tab_detail = os.path.join(parts_dir, "tab-cig-results-detail.tex")
    generate_results_detail_table(df, tab_detail, stats)

    tab_ttests = os.path.join(parts_dir, "tab-cig-ttests.tex")
    generate_ttest_table(df, tab_ttests, stats)

    tab_bugs = os.path.join(parts_dir, "tab-cig-bugs.tex")
    generate_bugs_elicited_table(df, tab_bugs)

    tab_stops = os.path.join(parts_dir, "tab-cig-stop-reasons.tex")
    generate_stop_reasons_table(df, tab_stops)

    tab_gen = os.path.join(parts_dir, "tab-cig-generators.tex")
    generate_cig_generator_table(run_dir, tab_gen)

    lst_prov = os.path.join(parts_dir, "provenance-cig.tex")
    generate_provenance_listing(run_dir, lst_prov, df)

    tex_vars = os.path.join(parts_dir, "data-cig.tex")
    generate_data_cig_tex(df, tex_vars, stats)

    plot_paths = [
        os.path.join(parts_dir, "pyplots-cig.pdf"),
        os.path.join(figures_dir, "pyplots-cig.pdf"),
    ]
    generate_pyplots(df, plot_paths)

    print(f"\n[SUCCESS] CIG complete analysis suite generated in:\n  {parts_dir}\n  {figures_dir}")


if __name__ == "__main__":
    main()
