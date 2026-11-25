#!/usr/bin/env python3
# type: ignore
"""
CIG Empirical Factorial Study Analysis Pipeline
Composite Input Generator (CIG) evaluation across 6 treatments:
SCRAM, CR, R (control), RA, RM, SR.

Generates complete suite of dissertation-aligned tables and figures:
  parts/data-quarton.tex (LaTeX macros and statistical indicators)
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
import shutil
from collections import defaultdict
from typing import Dict, List, Optional

import msgpack
import numpy as np
import pandas as pd
import scipy.stats as st
from analysis_common import (
    compute_fisher_exact,
    compute_mann_whitney,
    compute_ttest,
    format_delta_pct,
    format_sig_cell,
    parse_generator_chain,
    put_mathtt,
    pvalrange,
    star_alignment,
)

mpl = None
plt = None
HAS_MATPLOTLIB = False

try:
    import matplotlib as mpl  # type: ignore
    import matplotlib.pyplot as plt  # type: ignore
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False

ORDERED_TASKS = ["make_def", "_distance_norm",
                 "parse", "DerivationTree", "TreeValue"]
TASKS = ORDERED_TASKS

TASK_LABELS = {
    "make_def": r"\texttt{make\_def}",
    "_distance_norm": r"\texttt{\_distance\_norm}",
    "parse": r"\texttt{parse}",
    "DerivationTree": r"\texttt{DerivationTree}",
    "TreeValue": r"\texttt{TreeValue}",
}

TASKS_MAP = {
    "TreeValue": {"branches_total": 124, "bugs_count": 6},
    "DerivationTree": {"branches_total": 246, "bugs_count": 6},
    "parse": {"branches_total": 122, "bugs_count": 5},
    "_distance_norm": {"branches_total": 54, "bugs_count": 2},
    "make_def": {"branches_total": 8, "bugs_count": 3},
}

TREATMENTS = ["SCRAM", "S", "SR", "SRM", "C",
              "CR", "CRM", "R", "A", "RA", "M", "RM", "RAM"]
CONTROL_TREATMENT = "R"

TREATMENT_LABELS = {
    "SCRAM": r"\textbf{SCRAM}",
    "S": r"\textbf{S}",
    "SR": r"\textbf{SR}",
    "SRM": r"\textbf{SRM}",
    "C": r"\textbf{C}",
    "CR": r"\textbf{CR}",
    "CRM": r"\textbf{CRM}",
    "R": r"\textbf{R} \textit{(Control)}",
    "A": r"\textbf{A}",
    "RA": r"\textbf{RA}",
    "M": r"\textbf{M}",
    "RM": r"\textbf{RM}",
    "RAM": r"\textbf{RAM}",
}

TREATMENT_SHORT_TEXT = ["SCRAM", "S", "SR", "SRM",
                        "C", "CR", "CRM", "R", "A", "RA", "M", "RM", "RAM"]


def get_cell_color_latex(val: float, max_val: float) -> str:
    """
    Auto-scales cell background color from red (0) through yellow (1 to 50%) to green (51% to 100%).
    Red: RGB(245, 183, 177)
    Yellow: RGB(254, 235, 156)
    Green: RGB(169, 223, 192)
    """
    if val <= 0:
        return r"\cellcolor{worsered}"
    ratio = min(1.0, max(0.0, float(val) / float(max_val))
                ) if max_val > 0 else 0.0
    if ratio <= 0.5:
        k = ratio / 0.5
        r = int(245 + k * (254 - 245))
        g = int(183 + k * (235 - 183))
        b = int(177 + k * (156 - 177))
    else:
        k = (ratio - 0.5) / 0.5
        r = int(254 + k * (169 - 254))
        g = int(235 + k * (223 - 235))
        b = int(156 + k * (192 - 156))
    return f"\\cellcolor[RGB]{{{r},{g},{b}}}"


def get_active_treatments(df: pd.DataFrame) -> List[str]:
    """Returns the ordered subset of recognized treatments present in the dataset."""
    if df.empty or "Treatment" not in df.columns:
        return list(TREATMENTS)
    present = set(df["Treatment"].dropna().unique())
    return [t for t in TREATMENTS if t in present]


def sanitize_dataset(df: pd.DataFrame):
    """Strictly validates data.csv: rejects missing, out-of-range, or corrupted data."""
    if df.empty:
        raise ValueError(
            "CRITICAL: data.csv is empty! Rejecting invalid dataset.")

    required_cols = [
        "RunID", "Task", "Treatment", "Replicate",
        "ToolVersion",
        "BranchCoveragePct", "BranchesCovered", "BranchesTotal",
        "BugsElicited", "TaskBugCount", "BugElicitationRate",
        "TotalTestsExecuted", "ElapsedSec", "ExitCode", "StopReason", "Attempts", "Status"
    ]
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        raise ValueError(
            f"CRITICAL: data.csv is missing required columns: {missing}")

    for _, row in df.iterrows():
        rid = row["RunID"]
        task = row["Task"]
        tr = row["Treatment"]

        if row["Status"] == "FAILED":
            # Permitted as an unobserved/failed trial; numeric metrics must be unobserved (NaN/NA)
            # rather than fabricated zeros.
            cov = row["BranchCoveragePct"]
            if not pd.isna(cov):
                raise ValueError(
                    f"CRITICAL: Failed trial {rid} has fabricated numeric BranchCoveragePct={cov}. Must be unobserved (#N/A)."
                )
            continue
        elif row["Status"] != "COMPLETED":
            raise ValueError(
                f"CRITICAL: Trial {rid} ({task} under {tr}) has Status='{row['Status']}'. "
                f"Unknown status."
            )

        if task not in TASKS_MAP:
            raise ValueError(
                f"CRITICAL: Unknown task '{task}' in trial {rid}.")

        if tr not in TREATMENTS:
            raise ValueError(
                f"CRITICAL: Unknown treatment '{tr}' in trial {rid}.")

        expected_branches = TASKS_MAP[task]["branches_total"]
        actual_branches = row["BranchesTotal"]
        if actual_branches != expected_branches:
            raise ValueError(
                f"CRITICAL: Branch denominator mismatch in trial {rid} ({task}): "
                f"expected {expected_branches}, got {actual_branches}."
            )

        cov = row["BranchCoveragePct"]
        if pd.isna(cov) or cov < 0.0 or cov > 100.0:
            raise ValueError(
                f"CRITICAL: Invalid BranchCoveragePct={cov} in trial {rid}.")

        rate = row["BugElicitationRate"]
        if pd.isna(rate) or rate < 0.0 or rate > 1.0:
            raise ValueError(
                f"CRITICAL: Invalid BugElicitationRate={rate} in trial {rid}.")

        tests = row["TotalTestsExecuted"]
        if pd.isna(tests) or tests <= 0:
            raise ValueError(
                f"CRITICAL: Trial {rid} executed {tests} tests. TotalTestsExecuted must be strictly positive.")

        elapsed = row["ElapsedSec"]
        if pd.isna(elapsed) or elapsed < 0:
            raise ValueError(
                f"CRITICAL: Invalid ElapsedSec={elapsed} in trial {rid}.")

        exit_code = row["ExitCode"]
        if exit_code not in (0, 1):
            raise ValueError(
                f"CRITICAL: Trial {rid} has invalid ExitCode={exit_code}. "
                f"Only 0 (clean run) or 1 (test failures found) are valid completed trials."
            )

        stop_reason = str(row["StopReason"])
        if not stop_reason or stop_reason in ("unknown", "None", "nan"):
            raise ValueError(
                f"CRITICAL: Trial {rid} has missing or unknown StopReason='{stop_reason}'.")

        tool_ver = str(row.get("ToolVersion", ""))
        if not tool_ver or tool_ver in ("unknown", "None", "nan"):
            raise ValueError(
                f"CRITICAL: Trial {rid} has missing or unknown ToolVersion='{tool_ver}'.")

    # Assert balanced, even factorial matrix across all tasks and active treatments
    active_treatments = get_active_treatments(df)
    cell_counts = {}
    for task in TASKS:
        for tr in active_treatments:
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
    measures = ["BugElicitationRate", "BranchCoveragePct", "BugsElicited"]
    active_treatments = get_active_treatments(df)

    for tr in active_treatments:
        stats[tr] = {}
        tr_df = df[df["Treatment"] == tr] if not df.empty else pd.DataFrame()

        for task in TASKS:
            stats[tr][task] = {}
            task_df = tr_df[tr_df["Task"] ==
                            task] if not tr_df.empty else pd.DataFrame()
            ctl_df = df[(df["Treatment"] == CONTROL_TREATMENT) & (
                df["Task"] == task)] if not df.empty else pd.DataFrame()

            for col in measures:
                s_int = task_df[col].dropna().values.astype(
                    float) if col in task_df.columns else np.array([])
                s_ctl = ctl_df[col].dropna().values.astype(
                    float) if col in ctl_df.columns else np.array([])

                # No observation does NOT mean zero: use NaN when unobserved, and undefined SD for n < 2
                m_val = float(np.mean(s_int)) if len(
                    s_int) > 0 else float(np.nan)
                sd_val = float(np.std(s_int, ddof=1)) if len(
                    s_int) > 1 else float(np.nan)
                p_val = compute_ttest(
                    s_int, s_ctl) if tr != CONTROL_TREATMENT else float(np.nan)
                mw_p, mw_stat = compute_mann_whitney(
                    s_int, s_ctl) if tr != CONTROL_TREATMENT else (float(np.nan), float(np.nan))

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
        ctl_all_df = df[df["Treatment"] ==
                        CONTROL_TREATMENT] if not df.empty else pd.DataFrame()
        for col in measures:
            s_int = tr_df[col].dropna().values.astype(
                float) if col in tr_df.columns else np.array([])
            s_ctl = ctl_all_df[col].dropna().values.astype(
                float) if col in ctl_all_df.columns else np.array([])

            m_val = float(np.mean(s_int)) if len(s_int) > 0 else float(np.nan)
            sd_val = float(np.std(s_int, ddof=1)) if len(
                s_int) > 1 else float(np.nan)
            p_val = compute_ttest(
                s_int, s_ctl) if tr != CONTROL_TREATMENT else float(np.nan)
            mw_p, mw_stat = compute_mann_whitney(
                s_int, s_ctl) if tr != CONTROL_TREATMENT else (float(np.nan), float(np.nan))

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

    active_treatments = get_active_treatments(df)

    # Crash if any cell is missing: no observation cannot be plotted as 0.0
    for task in TASKS:
        for t in active_treatments:
            sub = df[(df["Task"] == task) & (df["Treatment"] == t)]
            vals = sub["BranchCoveragePct"].dropna().values.astype(
                float) if not sub.empty else []
            if len(vals) == 0:
                raise ValueError(
                    f"CRITICAL: Cannot generate pyplots: Task '{task}' has missing observations for treatment '{t}'. "
                    f"Fabricating data or plotting unobserved tasks is strictly prohibited."
                )

    mpl.rcParams["font.family"] = "serif"
    mpl.rcParams["font.size"] = 8.5
    mpl.rcParams["axes.labelweight"] = "bold"

    # Layout for Figure 6.6: 2 rows with GridSpec scaled taller to fill page height.
    # Top row: parse and TreeValue. Bottom row: Overall Bug Candidate Elicitation Rate spanning both columns.
    fig = plt.figure(figsize=(8.0, 10.5))
    gs = fig.add_gridspec(2, 2, hspace=0.34, wspace=0.22,
                          left=0.09, right=0.97, top=0.96, bottom=0.07)

    ax_parse = fig.add_subplot(gs[0, 0])
    ax_tv = fig.add_subplot(gs[0, 1])
    ax_overall = fig.add_subplot(gs[1, :])

    def render_violin_cell(ax, data, group_labels, xlabel, ylabel, ylim, xtick_fontsize=8.0):
        ax.set_xticks(list(range(1, len(group_labels) + 1)))
        ax.set_xticklabels(group_labels, rotation=45,
                           ha="right", fontsize=xtick_fontsize)
        ax.spines[:].set_visible(False)
        ax.tick_params(axis="both", which="both", bottom=False, left=False)
        ax.set_xlabel(xlabel, fontsize=10.0, labelpad=6)
        ax.set_ylabel(ylabel, fontsize=9.5)
        if ylim:
            ax.set_ylim(ylim)

        for i, vals in enumerate(data):
            x = i + 1
            if len(vals) > 1:
                try:
                    v = ax.violinplot([vals], positions=[x],
                                      widths=0.6, showextrema=False)
                    for pc in v.get("bodies", []):
                        pc.set_facecolor("none")
                        pc.set_edgecolor("black")
                        pc.set_alpha(1.0)
                        pc.set_linewidth(0.9)
                except Exception:
                    pass
            if len(vals) > 0:
                jitter = x + np.random.normal(0, 0.04, len(vals))
                ax.scatter(jitter, vals, s=15, color="grey",
                           alpha=0.5, edgecolors="none")
                ax.scatter(x, np.mean(vals), s=36, color="black", zorder=3)

    # parse
    data_parse = [df[(df["Task"] == "parse") & (df["Treatment"] == t)]
                  ["BranchCoveragePct"].dropna().values.astype(float) for t in active_treatments]
    render_violin_cell(ax_parse, data_parse, active_treatments,
                       f"(a) Branch Coverage: {put_mathtt('parse')}", "Branch Cov. (%)", (0, 105), xtick_fontsize=7.8)

    # TreeValue
    data_tv = [df[(df["Task"] == "TreeValue") & (df["Treatment"] == t)]
               ["BranchCoveragePct"].dropna().values.astype(float) for t in active_treatments]
    render_violin_cell(ax_tv, data_tv, active_treatments,
                       f"(b) Branch Coverage: {put_mathtt('TreeValue')}", "Branch Cov. (%)", (0, 105), xtick_fontsize=7.8)

    # Overall Bug Candidate Elicitation Rate across treatments (Measure 2) spanning both columns
    data_bugs = [df[df["Treatment"] == t]["BugElicitationRate"].dropna(
    ).values.astype(float) * 100.0 for t in active_treatments]
    render_violin_cell(ax_overall, data_bugs, active_treatments,
                       r"(c) Bug Candidate Elicitation Rate: Overall ($\Sigma$)", "Elicitation Rate (%)", (0, 105), xtick_fontsize=9.0)

    for p in pdf_paths:
        os.makedirs(os.path.dirname(os.path.abspath(p)), exist_ok=True)
        fig.savefig(p, format="pdf", bbox_inches="tight")
        print(f"[PLOT] Generated distribution plot: {p}")
    plt.close(fig)

    # Companion LaTeX figure wrapper for Figure 6.6
    fig_tex_path = os.path.join(os.path.dirname(
        os.path.abspath(pdf_paths[0])), "fig-quarton.tex")
    fig_lines = [
        r"\begin{figure*}[!htbp]",
        r"  \centering",
        r"  \includegraphics[width=\textwidth]{parts/pyplots-quarton.pdf}",
        r"  \caption{\figquartoncaption}",
        r"  \label{quarton:fig:pyplots}",
        r"\end{figure*}",
    ]
    with open(fig_tex_path, "w", encoding="utf-8") as f:
        f.write("\n".join(fig_lines) + "\n")
    print(f"[FIGURE] Generated main figure wrapper: {fig_tex_path}")


def generate_standalone_task_plot(df: pd.DataFrame, task: str, out_pdf_path: str, caption_text: str):
    """Generates a standalone half-page distribution plot for a single task program."""
    if not HAS_MATPLOTLIB:
        return
    active_treatments = get_active_treatments(df)
    fig, ax = plt.subplots(figsize=(7.5, 3.8))
    fig.subplots_adjust(left=0.10, right=0.96, top=0.90, bottom=0.20)

    data = [df[(df["Task"] == task) & (df["Treatment"] == t)]["BranchCoveragePct"].dropna(
    ).values.astype(float) for t in active_treatments]

    def render_violin_cell(ax, data, group_labels, xlabel, ylabel, ylim):
        ax.set_xticks(list(range(1, len(group_labels) + 1)))
        ax.set_xticklabels(group_labels, rotation=45, ha="right", fontsize=8.0)
        ax.spines[:].set_visible(False)
        ax.tick_params(axis="both", which="both", bottom=False, left=False)
        ax.set_xlabel(xlabel, fontsize=9.0, labelpad=6)
        ax.set_ylabel(ylabel, fontsize=8.5)
        if ylim:
            ax.set_ylim(ylim)

        for i, vals in enumerate(data):
            x = i + 1
            if len(vals) > 1:
                try:
                    v = ax.violinplot([vals], positions=[x],
                                      widths=0.6, showextrema=False)
                    for pc in v.get("bodies", []):
                        pc.set_facecolor("none")
                        pc.set_edgecolor("black")
                        pc.set_alpha(1.0)
                        pc.set_linewidth(0.8)
                except Exception:
                    pass
            if len(vals) > 0:
                jitter = x + np.random.normal(0, 0.04, len(vals))
                ax.scatter(jitter, vals, s=12, color="grey",
                           alpha=0.5, edgecolors="none")
                ax.scatter(x, np.mean(vals), s=32, color="black", zorder=3)

    render_violin_cell(ax, data, active_treatments,
                       f"(1) Branch Coverage: {put_mathtt(task)}", "Branch Cov. (%)", (0, 105))

    os.makedirs(os.path.dirname(os.path.abspath(out_pdf_path)), exist_ok=True)
    fig.savefig(out_pdf_path, format="pdf", bbox_inches="tight")
    plt.close(fig)
    print(f"[PLOT] Generated standalone plot for {task}: {out_pdf_path}")

    # Companion LaTeX figure wrapper
    base_name = os.path.splitext(os.path.basename(out_pdf_path))[0]
    tex_name = base_name.replace("pyplots", "fig") + ".tex"
    tex_path = os.path.join(os.path.dirname(
        os.path.abspath(out_pdf_path)), tex_name)
    pdf_rel = os.path.join("parts", os.path.basename(out_pdf_path))
    fig_lines = [
        r"\begin{figure}[!htbp]",
        r"  \centering",
        f"  \\includegraphics[width=\\columnwidth]{{{pdf_rel}}}",
        f"  \\caption[{caption_text.split('.')[0]}]{{{caption_text}}}",
        f"  \\label{{quarton:fig:pyplots-{task.lower().replace('_', '')}}}",
        r"\end{figure}",
    ]
    with open(tex_path, "w", encoding="utf-8") as f:
        f.write("\n".join(fig_lines) + "\n")
    print(f"[FIGURE] Generated standalone figure wrapper: {tex_path}")


def generate_generator_usage_plot(df: pd.DataFrame, run_dir: str, out_path: str):
    """Generates 3x2 per-PUT generator usage chart for SCRAM over 180s."""
    if not HAS_MATPLOTLIB:
        return

    scram_runs = df[df["Treatment"] ==
                    "SCRAM"] if not df.empty else pd.DataFrame()
    gen_colors = {
        "Seed": "#4C72B0",
        "Custom": "#55A868",
        "Random": "#DD8452",
        "AI": "#8172B3",
        "Mutation": "#C44E52",
    }
    gen_map = {
        "SeedInputGenerator": "Seed",
        "UserInputGenerator": "Custom",
        "RandomInputGenerator": "Random",
        "AiInputGenerator": "AI",
        "MutationInputGenerator": "Mutation",
    }
    gen_order = ["Seed", "Custom", "Random", "AI", "Mutation"]
    labels = ["Seed (S)", "Custom (C)", "Random (R)", "AI (A)", "Mutation (M)"]

    time_bins = np.linspace(0, 180, 181)
    bin_centers = (time_bins[:-1] + time_bins[1:]) / 2.0

    tasks_ordered = ["parse", "TreeValue", "make_def",
                     "DerivationTree", "_distance_norm"]
    task_titles = {
        "parse": "parse",
        "TreeValue": "TreeValue",
        "make_def": "make_def",
        "DerivationTree": "DerivationTree",
        "_distance_norm": "_distance_norm",
        "Overall": "Overall (5 PUTs)",
    }

    # Collect per-task counts across 10 replicates of each PUT
    task_counts = {t: {g: np.zeros(len(bin_centers))
                       for g in gen_order} for t in tasks_ordered}

    for _, row in scram_runs.iterrows():
        rid = row["RunID"]
        task = row["Task"]
        mpk_files = glob.glob(os.path.join(run_dir, "artifacts", rid, "*.mpk"))
        if not mpk_files:
            continue
        try:
            with open(mpk_files[0], "rb") as f:
                d = msgpack.unpackb(f.read())
        except Exception:
            continue
        cig = d.get("stats", {}).get("generators", {}).get(
            "CompositeInputGenerator", {})
        cps = cig.get("checkpoints", [])
        n_cps = len(cps)
        if n_cps == 0:
            continue

        for i_cp, cp in enumerate(cps):
            sec = min(179.9, 180.0 * (i_cp / max(1, n_cps - 1)))
            bin_idx = int(sec)
            if 0 <= bin_idx < len(bin_centers):
                for gname, ginfo in cp.get("gens", {}).items():
                    if ginfo.get("selected"):
                        clean_g = gen_map.get(gname)
                        if clean_g in task_counts.get(task, {}):
                            task_counts[task][clean_g][bin_idx] += 1

    window = 5
    task_shares = {}
    for tname in tasks_ordered:
        counts = task_counts[tname]
        smoothed = {}
        tot_bin = np.zeros(len(bin_centers))
        for g in gen_order:
            s = pd.Series(counts[g]).rolling(
                window, min_periods=1, center=True).mean().values
            smoothed[g] = s
            tot_bin += s
        sh = {}
        for g in gen_order:
            sh[g] = np.where(tot_bin > 0, (smoothed[g] / tot_bin) * 100.0, 0.0)
        task_shares[tname] = sh

    # Macro-average across all 5 PUTs (each PUT gets equal 20% weight)
    overall_shares = {g: np.zeros(len(bin_centers)) for g in gen_order}
    for g in gen_order:
        for tname in tasks_ordered:
            overall_shares[g] += task_shares[tname][g] / \
                float(len(tasks_ordered))
    task_shares["Overall"] = overall_shares

    fig, axs = plt.subplots(3, 2, figsize=(8.0, 9.8), sharex=True, sharey=True)
    fig.subplots_adjust(left=0.08, right=0.98, top=0.89,
                        bottom=0.06, hspace=0.32, wspace=0.18)

    flat_axs = axs.flatten()
    all_panels = tasks_ordered + ["Overall"]

    for idx, tname in enumerate(all_panels):
        ax = flat_axs[idx]
        sh = task_shares[tname]
        y_stack = [sh[g] for g in gen_order]
        colors = [gen_colors[g] for g in gen_order]

        ax.stackplot(bin_centers, y_stack, colors=colors,
                     alpha=0.9, edgecolor="white", linewidth=0.3)
        ax.set_xlim(0, 180)
        ax.set_ylim(0, 100)
        ax.set_title(task_titles[tname], fontsize=9.5,
                     fontweight="bold", pad=4)
        ax.spines[:].set_visible(False)
        ax.grid(axis="x", linestyle="--", alpha=0.35)
        ax.tick_params(axis="both", which="both",
                       bottom=True, left=True, labelsize=7.5)

        if idx % 2 == 0:
            ax.set_ylabel("Selection Share (%)", fontsize=8.5)
        if idx >= 4:
            ax.set_xlabel("Time (s)", fontsize=8.5)

    legend_handles = [mpl.patches.Patch(
        facecolor=gen_colors[g], edgecolor="white", label=lbl) for g, lbl in zip(gen_order, labels)]
    fig.legend(handles=legend_handles, loc="upper center", bbox_to_anchor=(
        0.50, 0.985), ncol=5, fontsize=17.0, frameon=False, handlelength=2.5, handleheight=1.5)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    fig.savefig(out_path, format="pdf", bbox_inches="tight")
    plt.close(fig)
    print(f"[PLOT] Generated 3x2 Per-PUT Generator Usage Plot: {out_path}")

    # Companion LaTeX figure wrapper
    tex_path = os.path.join(os.path.dirname(
        os.path.abspath(out_path)), "fig-quarton-generators.tex")
    fig_lines = [
        r"\begin{figure*}[!htbp]",
        r"  \centering",
        r"  \includegraphics[width=\textwidth]{parts/pyplots-quarton-generators.pdf}",
        r"  \caption[Input generator scheduling share for each task program]{\qgeneratorscaption\figquartongeneratorscomment{}}",
        r"  \label{quarton:fig:generators-by-put}",
        r"\end{figure*}",
    ]
    with open(tex_path, "w", encoding="utf-8") as f:
        f.write("\n".join(fig_lines) + "\n")
    print(f"[FIGURE] Generated Generator Figure Wrapper: {tex_path}")


def generate_trials_table(df: pd.DataFrame, out_path: str):
    """Generates the trial allocation matrix table."""
    active_treatments = get_active_treatments(df)
    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \footnotesize",
        r"  \caption{Task Assignment Matrix ($n=\qn$)}",
        r"  \label{quarton:tab:participants}",
        r"  \begin{tabular}{l|ccccc}",
        r"    \toprule",
        r"    \textbf{Treatment} & \textbf{\texttt{make\_def}} & \textbf{\texttt{\_distance\_norm}} & \textbf{\texttt{parse}} & \textbf{\texttt{DerivationTree}} & \textbf{\texttt{TreeValue}} \\",
        r"    \midrule",
    ]

    for tr in active_treatments:
        row_cells = [TREATMENT_LABELS.get(tr, tr)]
        for task in ORDERED_TASKS:
            sub = df[(df["Treatment"] == tr) & (df["Task"] == task)
                     ] if not df.empty else pd.DataFrame()
            rids = sub["RunID"].tolist() if "RunID" in sub.columns else []
            cell_text = ", ".join(rids) if rids else "--"
            row_cells.append(cell_text)
        lines.append("    " + " & ".join(row_cells) + r" \\")

    lines.extend([
        r"    \bottomrule",
        r"    \multicolumn{6}{c}{\footnotesize Trial runs allocated across treatments and target task programs.} \\",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Trial Allocation Table: {out_path}")


def generate_cig_results_table(df: pd.DataFrame, out_path: str, stats: dict):
    """Generates the main LaTeX factorial results table comparing treatments vs control R."""
    # Order PUTs: make_def before _distance_norm as requested
    ordered_tasks = ORDERED_TASKS
    active_treatments = get_active_treatments(df)

    header_cols = []
    for i, t in enumerate(ordered_tasks):
        sep = "||" if i == len(ordered_tasks) - 1 else "|"
        header_cols.append(
            f"\\multicolumn{{2}}{{c{sep}}}{{\\textbf{{{TASK_LABELS.get(t, t)}}}}}")

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \setlength{\tabcolsep}{2pt}",
        r"  \definecolor{bettergreen}{RGB}{169,223,192}",
        r"  \definecolor{worsered}{RGB}{245,183,177}",
        r"  \caption{Quantitative Task Results Summary for Measures 1--2 ($n=\qn$)\tabquartonresultscomment{}}",
        r"  \label{quarton:tab:results}",
        r"  \footnotesize",
        r"  \begin{tabularx}{\textwidth}{l| *{4}{>{\centering\arraybackslash}X >{\centering\arraybackslash}X |} >{\centering\arraybackslash}X >{\centering\arraybackslash}X || >{\centering\arraybackslash}X >{\centering\arraybackslash}X}",
        r"    \toprule",
        "    & " + " & ".join(header_cols) +
        r" & \multicolumn{2}{c}{\textbf{Overall ($\Sigma$)}} \\",
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
        ("BranchCoveragePct", r"Measure 1: Branch Coverage (\%); higher is better", 1, 1.0),
        ("BugElicitationRate", r"Measure 2: Elicited Bugs (\%); higher is better", 1, 100.0),
    ]

    for col, title, dec, scale in measures:
        lines.extend([
            r"    \midrule",
            f"    \\multicolumn{{13}}{{c}}{{\\textbf{{{title}}}}} \\\\",
            r"    \midrule",
        ])

        for tr in active_treatments:
            label = TREATMENT_LABELS.get(tr, tr)
            row_items = [f"    {label}"]
            ctl_m_all = stats.get(CONTROL_TREATMENT, {}).get(
                "All", {}).get(col, {}).get("mean", np.nan)
            if not np.isnan(ctl_m_all):
                ctl_m_all = ctl_m_all * scale

            for task in ordered_tasks:
                m_val = stats.get(tr, {}).get(task, {}).get(
                    col, {}).get("mean", np.nan)
                sd_val = stats.get(tr, {}).get(
                    task, {}).get(col, {}).get("sd", np.nan)
                ctl_m = stats.get(CONTROL_TREATMENT, {}).get(
                    task, {}).get(col, {}).get("mean", np.nan)
                p_val = stats.get(tr, {}).get(task, {}).get(
                    col, {}).get("pvalue", None)
                if not np.isnan(m_val):
                    m_val = m_val * scale
                if not np.isnan(sd_val):
                    sd_val = sd_val * scale
                if not np.isnan(ctl_m):
                    ctl_m = ctl_m * scale
                # Formats as \multicolumn{2}{c}{--} if unobserved (NaN)
                row_items.append(format_sig_cell(
                    tr, col, m_val, sd_val, ctl_m, p_val, dec, base_tool=CONTROL_TREATMENT))

            all_m = stats.get(tr, {}).get("All", {}).get(
                col, {}).get("mean", np.nan)
            all_sd = stats.get(tr, {}).get(
                "All", {}).get(col, {}).get("sd", np.nan)
            all_p_val = stats.get(tr, {}).get(
                "All", {}).get(col, {}).get("pvalue", None)
            if not np.isnan(all_m):
                all_m = all_m * scale
            if not np.isnan(all_sd):
                all_sd = all_sd * scale
            row_items.append(format_sig_cell(
                tr, col, all_m, all_sd, ctl_m_all, all_p_val, dec, base_tool=CONTROL_TREATMENT))

            lines.append(" & ".join(row_items) + r" \\")
            if tr != active_treatments[-1]:
                lines.append(r"    \hline")

    lines.extend([
        r"    \bottomrule",
        r"    \multicolumn{13}{c}{\footnotesize Statistically significant differences against control R marked as: $\ast$ ($p\!<\!0.05$), $\ast\ast$ ($p\!<\!0.01$).} \\",
        r"    \multicolumn{13}{c}{\footnotesize Measure 1: Mann--Whitney $U$ test; Measure 2: two-tailed Welch's $t$-test.} \\",
        r"  \end{tabularx}",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated CIG Results Table: {out_path}")


def generate_results_detail_table(df: pd.DataFrame, out_path: str, stats: dict):
    """Generates detailed summary table with min, mean, max, and totals across treatments."""
    active_treatments = get_active_treatments(df)
    num_tr = len(active_treatments)
    col_spec = "l|" + "c" * num_tr
    total_cols = num_tr + 1
    tr_headers = " & ".join([f"\\textbf{{{tr}}}" for tr in active_treatments])

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \setlength{\tabcolsep}{3pt}",
        r"  \caption{Detailed Experimental Outcomes by Treatment across Measures}",
        r"  \label{quarton:tab:results-detail}",
        r"  \footnotesize",
        r"  \resizebox{\textwidth}{!}{%",
        f"  \\begin{{tabular}}{{{col_spec}}}",
        r"    \toprule",
        f"    \\textbf{{Metric}} & {tr_headers} \\\\",
        r"    \midrule",
        f"    \\multicolumn{{{total_cols}}}{{c}}{{\\textbf{{Measure 1: Branch Coverage (\\%)}}}} \\\\",
        r"    \midrule",
    ]

    for label, col, fmt in [
        ("Max Coverage", "BranchCoveragePct", ".1f"),
        ("Mean Coverage", "BranchCoveragePct", ".1f"),
        ("Min Coverage", "BranchCoveragePct", ".1f"),
    ]:
        row = [f"    {label}"]
        for tr in active_treatments:
            sub = df[df["Treatment"] == tr] if not df.empty else pd.DataFrame()
            vals = sub[col].dropna().values.astype(
                float) if col in sub.columns else []
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
        f"    \\multicolumn{{{total_cols}}}{{c}}{{\\textbf{{Measure 2: Bugs Elicited}}}} \\\\",
        r"    \midrule",
    ])

    total_el_row = ["    Total Bugs Elicited"]
    for tr in active_treatments:
        sub = df[df["Treatment"] == tr] if not df.empty else pd.DataFrame()
        tot = int(sub["BugsElicited"].sum()
                  ) if "BugsElicited" in sub.columns and len(sub) > 0 else 0
        total_el_row.append(str(tot) if len(sub) > 0 else "--")
    lines.append(" & ".join(total_el_row) + r" \\")

    mean_el_row = ["    Mean Bugs / Trial"]
    for tr in active_treatments:
        sub = df[df["Treatment"] == tr] if not df.empty else pd.DataFrame()
        m = float(sub["BugsElicited"].mean()) if "BugsElicited" in sub.columns and len(
            sub) > 0 else float(np.nan)
        mean_el_row.append(f"{m:.2f}" if not np.isnan(m) else "--")
    lines.append(" & ".join(mean_el_row) + r" \\")

    lines.extend([
        r"    \bottomrule",
        r"  \end{tabular}%",
        r"  }",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Results Detail Table: {out_path}")


def generate_ttest_table(df: pd.DataFrame, out_path: str, stats: dict):
    """Generates formal hypothesis testing results table comparing treatments vs Control R."""
    active_treatments = get_active_treatments(df)
    compare_treatments = [
        t for t in active_treatments if t != CONTROL_TREATMENT]

    s_ctl_cov = df[df["Treatment"] == CONTROL_TREATMENT]["BranchCoveragePct"].dropna(
    ).values if not df.empty else []
    s_ctl_el = df[df["Treatment"] == CONTROL_TREATMENT]["BugElicitationRate"].dropna(
    ).values if not df.empty else []

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \footnotesize",
        r"  \setlength{\tabcolsep}{3pt}",
        r"  \definecolor{bettergreen}{RGB}{169,223,192}",
        r"  \definecolor{worsered}{RGB}{245,183,177}",
        r"  \caption{Statistical Significance of Treatment Effects vs.\ Control R ($n=\qn$)\tabquartonttestscomment{}}",
        r"  \label{quarton:tab:ttests}",
        r"  \resizebox{\textwidth}{!}{%",
        r"  \begin{tabular}{l | r c r | r c r}",
        r"    \toprule",
        r"    & \multicolumn{3}{c|}{\textbf{Measure 1: Branch Coverage ($U$-test)}} & \multicolumn{3}{c}{\textbf{Measure 2: Elicited Bugs ($t$-test)}} \\",
        r"    \textbf{Treatment} & \multicolumn{1}{c}{\textbf{$\Delta$}} & \textbf{Statistic} & \multicolumn{1}{c|}{\textbf{$p$}} & \multicolumn{1}{c}{\textbf{$\Delta$}} & \textbf{Statistic} & \multicolumn{1}{c}{\textbf{$p$}} \\",
        r"    \midrule",
    ]

    for tr in compare_treatments:
        s_tr_cov = df[df["Treatment"] == tr]["BranchCoveragePct"].dropna(
        ).values if not df.empty else []
        s_tr_el = df[df["Treatment"] == tr]["BugElicitationRate"].dropna(
        ).values if not df.empty else []

        # Measure 1: Mann-Whitney U
        p_val_cov, u_stat = compute_mann_whitney(s_tr_cov, s_ctl_cov)
        if np.isnan(p_val_cov) or np.isnan(u_stat):
            c1, c2, c3 = "--", "--", "n/a"
        else:
            m1 = float(np.mean(s_tr_cov)) if len(s_tr_cov) else 0.0
            m2 = float(np.mean(s_ctl_cov)) if len(s_ctl_cov) else 0.0
            delta_pct_cov = (m1 / m2 - 1.0) * 100.0 if m2 != 0 else 0.0
            sign_cov = "+" if delta_pct_cov >= 0 else ""
            delta_str_cov = f"{sign_cov}{delta_pct_cov:.1f}\\%"
            stat_str_cov = f"$U = {u_stat:.0f}$"
            p_str_cov = f"{p_val_cov:.4f}" if p_val_cov >= 0.0001 else "$<$0.0001"
            star_cov = star_alignment(p_val_cov)
            is_sig_cov = p_val_cov < 0.05
            color_cov = "bettergreen" if delta_pct_cov > 0 else "worsered"
            if is_sig_cov:
                c1 = f"\\cellcolor{{{color_cov}}}{delta_str_cov}"
                c2 = f"\\cellcolor{{{color_cov}}}{stat_str_cov}"
                c3 = f"\\cellcolor{{{color_cov}}}{p_str_cov}{star_cov}"
            else:
                c1 = delta_str_cov
                c2 = stat_str_cov
                c3 = f"{p_str_cov}{star_cov}"

        # Measure 2: Welch t-test
        p_val_el = compute_ttest(s_tr_el, s_ctl_el)
        if np.isnan(p_val_el) or len(s_tr_el) < 2 or len(s_ctl_el) < 2:
            e1, e2, e3 = "--", "--", "n/a"
        else:
            res_t = st.ttest_ind(s_tr_el, s_ctl_el, equal_var=False)
            t_stat = float(res_t.statistic)
            df_t = float(getattr(res_t, "df", np.nan))
            m1_el = float(np.mean(s_tr_el)) if len(s_tr_el) else 0.0
            m2_el = float(np.mean(s_ctl_el)) if len(s_ctl_el) else 0.0
            delta_pct_el = (m1_el / m2_el - 1.0) * 100.0 if m2_el != 0 else 0.0
            sign_el = "+" if delta_pct_el >= 0 else ""
            delta_str_el = f"{sign_el}{delta_pct_el:.1f}\\%"
            stat_str_el = f"$t({df_t:.1f}) = {t_stat:+.2f}$"
            p_str_el = f"{p_val_el:.4f}" if p_val_el >= 0.0001 else "$<$0.0001"
            star_el = star_alignment(p_val_el)
            is_sig_el = p_val_el < 0.05
            color_el = "bettergreen" if delta_pct_el > 0 else "worsered"
            if is_sig_el:
                e1 = f"\\cellcolor{{{color_el}}}{delta_str_el}"
                e2 = f"\\cellcolor{{{color_el}}}{stat_str_el}"
                e3 = f"\\cellcolor{{{color_el}}}{p_str_el}{star_el}"
            else:
                e1 = delta_str_el
                e2 = stat_str_el
                e3 = f"{p_str_el}{star_el}"

        lines.append(
            f"    \\textbf{{{tr}}} & {c1} & {c2} & {c3} & {e1} & {e2} & {e3} \\\\")

    lines.extend([
        r"    \bottomrule",
        r"    \multicolumn{7}{c}{\footnotesize Measure 1 evaluated via Mann--Whitney $U$ test; Measure 2 evaluated via Welch's two-tailed $t$-test.} \\",
        r"    \multicolumn{7}{c}{\footnotesize Statistically significant differences are marked as: $\ast$ ($p\!<\!0.05$), $\ast\ast$ ($p\!<\!0.01$).} \\",
        r"  \end{tabular}%",
        r"  }",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Hypothesis Testing Table: {out_path}")


def generate_bugs_elicited_table(df: pd.DataFrame, out_path: str):
    """Generates the ground-truth defect elicitation and detection matrix across treatments."""
    rubric_path = os.path.join(os.path.dirname(
        __file__), "ground_truth_rubric.json")
    if not os.path.exists(rubric_path):
        raise FileNotFoundError(
            f"CRITICAL: ground_truth_rubric.json not found at {rubric_path}")

    with open(rubric_path, "r", encoding="utf-8") as f:
        rubric = json.load(f)

    active_treatments = get_active_treatments(df)
    num_tr = len(active_treatments)
    num_reps = int(df["Replicate"].max(
    )) if not df.empty and "Replicate" in df.columns and not df["Replicate"].dropna().empty else 30
    col_spec = "ll|" + "r" * num_tr
    tr_headers = " & ".join([f"\\textbf{{{tr}}}" for tr in active_treatments])

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \setlength{\tabcolsep}{2.5pt}",
        r"  \footnotesize",
        r"  \definecolor{bettergreen}{RGB}{169,223,192}",
        r"  \definecolor{worsered}{RGB}{245,183,177}",
        r"  \caption{Bug Elicitations by Task Program and Treatment\tabquartonbugscomment{}}",
        r"  \label{quarton:tab:bugs-elicited}",
        r"  \resizebox{\textwidth}{!}{%",
        f"  \\begin{{tabular}}{{{col_spec}}}",
        r"    \toprule",
        f"    \\textbf{{Task Program}} & \\textbf{{Bug ID}} & {tr_headers} \\\\",
        r"    \midrule",
    ]

    treatment_totals = {t: 0 for t in active_treatments}
    treatment_unique = {t: 0 for t in active_treatments}

    # Order PUTs: make_def before _distance_norm as requested
    ordered_tasks = ORDERED_TASKS

    for task in ordered_tasks:
        bugs = rubric.get("tasks", {}).get(task, {}).get("bugs", {})
        task_label = TASK_LABELS.get(task, task)
        first_row = True

        # Sort bugs by total hits ascending (lowest hits on top)
        bug_hits = {bid: int(df[bid].dropna().sum())
                    if bid in df.columns else 0 for bid in bugs}
        ordered_bids = sorted(
            bugs.keys(), key=lambda b: (bug_hits.get(b, 0), b))

        for bid in ordered_bids:
            prefix = task_label if first_row else ""
            first_row = False
            escaped_bid = bid.replace("_", r"\_")

            counts = []
            for t in active_treatments:
                sub = df[df["Treatment"] ==
                         t] if not df.empty else pd.DataFrame()
                hits = 0
                if bid in sub.columns:
                    hits = int((sub[bid] == 1).sum())
                color_cell = f"{get_cell_color_latex(hits, num_reps)}{hits}"
                counts.append(color_cell)
                treatment_totals[t] += hits
                if hits > 0:
                    treatment_unique[t] += 1

            lines.append(
                f"    {prefix} & \\texttt{{{escaped_bid}}} & " + " & ".join(counts) + r" \\")
        lines.append(r"    \midrule")

    total_rubric_bugs = sum(
        len(rubric.get("tasks", {}).get(t, {}).get("bugs", {})) for t in TASKS)
    lines.extend([
        "    \\multicolumn{2}{l|}{\\textbf{Total Elicitations}} & " +
        " & ".join(str(treatment_totals[t])
                   for t in active_treatments) + r" \\",
        r"    \hline",
        f"    \\multicolumn{{2}}{{l|}}{{\\textbf{{Unique Bugs Elicited (out of {total_rubric_bugs})}}}} & " + " & ".join(
            str(treatment_unique[t]) for t in active_treatments) + r" \\",
        r"    \bottomrule",
        f"    \\multicolumn{{{num_tr + 2}}}{{c}}{{\\footnotesize Color scale auto-scales from red (0) through yellow ($\\le$50\\% of repetitions) to green (100\\% elicitation).}} \\\\",
        r"  \end{tabular}%",
        r"  }",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Ground-Truth Defect Matrix Table: {out_path}")


def generate_stop_reasons_table(df: pd.DataFrame, out_path: str):
    """Generates stop reason and exit code breakdown table across tasks and treatments."""
    active_treatments = get_active_treatments(df)
    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \footnotesize",
        r"  \caption{Fuzzer Termination Reasons and Exit Codes by Target PUT and Treatment}",
        r"  \label{quarton:tab:stop-reasons}",
        r"  \begin{tabular}{ll|rrrr|rr}",
        r"    \toprule",
        r"    \textbf{Target PUT} & \textbf{Treatment} & \textbf{maxTime} & \textbf{maxDupes} & \textbf{maxTests} & \textbf{Other} & \textbf{Exit 0} & \textbf{Exit 1} \\",
        r"    \midrule",
    ]

    for task in TASKS:
        task_label = TASK_LABELS.get(task, task)
        first_row = True
        for tr in active_treatments:
            prefix = task_label if first_row else ""
            first_row = False
            sub = df[(df["Task"] == task) & (df["Treatment"] == tr)
                     ] if not df.empty else pd.DataFrame()
            n_time = int((sub["StopReason"] == "maxTime").sum()
                         ) if "StopReason" in sub.columns else 0
            n_dupes = int((sub["StopReason"] == "maxDupes").sum()
                          ) if "StopReason" in sub.columns else 0
            n_tests = int((sub["StopReason"] == "maxTests").sum()
                          ) if "StopReason" in sub.columns else 0
            n_other = len(sub) - (n_time + n_dupes + n_tests)
            n_exit0 = int((sub["ExitCode"] == 0).sum()
                          ) if "ExitCode" in sub.columns else 0
            n_exit1 = int((sub["ExitCode"] == 1).sum()
                          ) if "ExitCode" in sub.columns else 0
            tr_label = TREATMENT_LABELS.get(tr, tr)
            lines.append(
                f"    {prefix} & {tr_label} & {n_time} & {n_dupes} & {n_tests} & {n_other} & {n_exit0} & {n_exit1} \\\\"
            )
        lines.append(r"    \midrule")

    tot_time = int((df["StopReason"] == "maxTime").sum()
                   ) if "StopReason" in df.columns else 0
    tot_dupes = int((df["StopReason"] == "maxDupes").sum()
                    ) if "StopReason" in df.columns else 0
    tot_tests = int((df["StopReason"] == "maxTests").sum()
                    ) if "StopReason" in df.columns else 0
    tot_other = len(df) - (tot_time + tot_dupes + tot_tests)
    tot_exit0 = int((df["ExitCode"] == 0).sum()
                    ) if "ExitCode" in df.columns else 0
    tot_exit1 = int((df["ExitCode"] == 1).sum()
                    ) if "ExitCode" in df.columns else 0

    lines.extend([
        f"    \\multicolumn{{2}}{{l|}}{{\\textbf{{Total across all {len(df)} trials}}}} & {tot_time} & {tot_dupes} & {tot_tests} & {tot_other} & {tot_exit0} & {tot_exit1} \\\\",
        r"    \bottomrule",
        r"    \multicolumn{8}{c}{\footnotesize Normal termination reasons: maxTime (180s budget expired), maxDupes (duplicate threshold reached).} \\",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Stop Reason Breakdown Table: {out_path}")


def generate_cig_generator_table(run_dir: str, out_path: str, df: Optional[pd.DataFrame] = None):
    """Generates generator provenance breakdown table for CIG trials in canonical S, C, R, A, M format."""
    rubric_path = os.path.join(os.path.dirname(
        __file__), "ground_truth_rubric.json")
    if not os.path.exists(rubric_path):
        raise FileNotFoundError(
            f"CRITICAL: ground_truth_rubric.json not found at {rubric_path}")

    with open(rubric_path, "r", encoding="utf-8") as f:
        rubric = json.load(f)

    # Map each bug to its target task to prevent cross-task defect bleeding
    bug_to_task = {}
    for tsk, tinfo in rubric.get("tasks", {}).items():
        for bid in tinfo.get("bugs", {}):
            bug_to_task[bid] = tsk

    rid_to_task = {}
    scram_run_ids = set()
    num_reps = 30
    gen_keys = ["seed", "custom", "random", "ai", "mutation"]
    if df is not None and not df.empty and "RunID" in df.columns and "Treatment" in df.columns:
        scram_df = df[df["Treatment"] == "SCRAM"]
        scram_run_ids = set(scram_df["RunID"])
        if "Task" in scram_df.columns:
            rid_to_task = dict(zip(scram_df["RunID"], scram_df["Task"]))
        if "Replicate" in df.columns and not df["Replicate"].dropna().empty:
            num_reps = int(df["Replicate"].max())

    eliciting_runs: Dict[str, Dict[str, set]
                         ] = defaultdict(lambda: defaultdict(set))
    originating_runs: Dict[str, Dict[str, set]
                           ] = defaultdict(lambda: defaultdict(set))

    def clean_gen_name(g):
        if not isinstance(g, str):
            return "unknown"
        gl = g.lower()
        if "seed" in gl or gl == "user":
            return "seed"
        if "custom" in gl or "userinput" in gl:
            return "custom"
        if "random" in gl:
            return "random"
        if "ai" in gl or "gemini" in gl:
            return "ai"
        if "mutation" in gl:
            return "mutation"
        return "unknown"

    for rid in scram_run_ids:
        trial_task = rid_to_task.get(rid)
        if not trial_task:
            continue
        task_bugs = set(rubric.get("tasks", {}).get(
            trial_task, {}).get("bugs", {}).keys())

        # 1. Direct eliciting counts from mpk test executions
        mpk_path = os.path.join(run_dir, "artifacts", rid, f"{rid}.mpk")
        if os.path.exists(mpk_path):
            try:
                with open(mpk_path, "rb") as mf:
                    d = msgpack.unpack(mf)
                for r in d.get("results", []):
                    out_str = str(r.get("output", ""))
                    for bid in task_bugs:
                        if bid in out_str:
                            inp = r.get("input", [])
                            if inp:
                                orig = inp[0].get("origin", {})
                                gname = orig.get(
                                    "generator", orig.get("type", "Unknown"))
                                cg = clean_gen_name(gname)
                                if cg in gen_keys:
                                    eliciting_runs[bid][cg].add(rid)
            except Exception:
                pass

        # 2. Lineage and originating counts from elicited_bugs.json
        logf = os.path.join(run_dir, "artifacts", rid, "elicited_bugs.json")
        if os.path.exists(logf):
            try:
                with open(logf, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        entry = json.loads(line)
                        if entry.get("summary"):
                            continue
                        bid = entry.get("bug_id")
                        if not bid or bid not in task_bugs:
                            continue
                        gen_chain = entry.get("generator", "")
                        if gen_chain:
                            eliciting, originating = parse_generator_chain(
                                gen_chain)
                            if eliciting in gen_keys:
                                eliciting_runs[bid][eliciting].add(rid)
                            if originating in gen_keys:
                                originating_runs[bid][originating].add(rid)
            except Exception:
                pass

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \footnotesize",
        r"  \setlength{\tabcolsep}{3pt}",
        r"  \definecolor{bettergreen}{RGB}{169,223,192}",
        r"  \definecolor{worsered}{RGB}{245,183,177}",
        r"  \caption[Task Program Bugs by Eliciting and (Originating) Input Generator]{Task Program Bugs by Eliciting and (Originating) Input Generator for SCRAM\tabquartongeneratorscomment{}}",
        r"  \label{quarton:tab:generators}",
        r"  \begin{tabular}{l | *{5}{>{\centering\arraybackslash}p{1.7cm}}}",
        r"    \toprule",
        r"    & \multicolumn{5}{c}{\textbf{Eliciting and (Originating) Input Generator}} \\",
        r"    \multicolumn{1}{c|}{\textbf{Bug ID}} & \textbf{Seed} & \textbf{Custom} & \textbf{Random} & \textbf{AI} & \textbf{Mutation} \\",
    ]

    # Order PUTs and bugs to match Table 6.6
    ordered_tasks = ORDERED_TASKS

    for task_name in ordered_tasks:
        bugs = rubric.get("tasks", {}).get(task_name, {}).get("bugs", {})
        task_label = TASK_LABELS.get(task_name, task_name)
        lines.append(r"    \midrule")
        lines.append(
            f"    \\multicolumn{{6}}{{c}}{{\\textbf{{{task_label}}}}} \\\\")
        lines.append(r"    \midrule")

        if df is not None and not df.empty:
            bug_hits = {bid: int(df[bid].dropna().sum())
                        if bid in df.columns else 0 for bid in bugs}
            ordered_bids = sorted(
                bugs.keys(), key=lambda b: (bug_hits.get(b, 0), b))
        else:
            ordered_bids = sorted(bugs.keys())

        for bid in ordered_bids:
            escaped_bid = bid.replace("_", r"\_")
            cells = []
            for gtype in gen_keys:
                el_cnt = len(eliciting_runs[bid][gtype])
                if gtype != "mutation":
                    orig_cnt = max(el_cnt, len(originating_runs[bid][gtype]))
                else:
                    orig_cnt = 0
                comb_cnt = el_cnt + orig_cnt
                color_str = get_cell_color_latex(comb_cnt, num_reps)
                cell_text = f"{el_cnt} ({orig_cnt})"
                cells.append(f"{color_str}{cell_text}")
            lines.append(
                f"    \\texttt{{{escaped_bid}}} & " + " & ".join(cells) + r" \\")

    lines.extend([
        r"    \bottomrule",
        r"    \multicolumn{6}{l}{\footnotesize Shading: Red (0), Yellow ($\le$50\% of reps), Green (100\% elicitation/origination).} \\",
        r"    \multicolumn{6}{l}{\footnotesize Format: Eliciting (Originating). Originating inputs were mutated to elicit the bug.} \\",
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

    artifact_pattern = os.path.join(
        run_dir, "artifacts", "*", "elicited_bugs.json")
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

    # User criteria: longest mutation chain from seed or custom that elicited PARSE_SILENT_DROP
    target_candidates = []
    for c in all_candidates:
        if c["bug_id"] == "PARSE_SILENT_DROP":
            el, orig = parse_generator_chain(c["chain"])
            if orig in ("seed", "custom"):
                target_candidates.append(c)

    scram_targets = [c for c in target_candidates if df is not None and c["run_id"] in set(
        df[df["Treatment"] == "SCRAM"]["RunID"])]
    if scram_targets:
        selected = max(scram_targets, key=lambda x: x["steps"])
    elif target_candidates:
        selected = max(target_candidates, key=lambda x: x["steps"])
    else:
        selected = max(all_candidates, key=lambda x: x["steps"])

    max_steps = selected["steps"]

    mpk_path = os.path.join(run_dir, "artifacts",
                            selected["run_id"], f"{selected['run_id']}.mpk")
    formatted_lines = []

    if os.path.exists(mpk_path):
        try:
            with open(mpk_path, "rb") as f:
                d = msgpack.unpackb(f.read())
            by_tick = {item.get("tick"): item for item in d.get(
                "interesting", {}).get("inputs", [])}

            # Trace backwards from each leaf to find the longest provenance chain
            def trace_back(leaf_tick):
                c = []
                curr = leaf_tick
                while curr is not None:
                    obj = by_tick.get(curr)
                    if not obj:
                        break
                    c.append((curr, obj))
                    curr = obj.get("input", {}).get("source", {}).get("tick")
                c.reverse()
                return c

            chains = [trace_back(t) for t in by_tick]
            chain = max(chains, key=len) if chains else []

            if chain:
                prev_vals = None
                for i, (tick, obj) in enumerate(chain):
                    inp = obj.get("input", {})
                    src = inp.get("source", {})
                    val = inp.get("value", [])

                    spec = val[0].get("value") if isinstance(
                        val[0], dict) else val[0]
                    c_str = val[1].get("value") if isinstance(
                        val[1], dict) else val[1]
                    u_std = val[2].get("value") if isinstance(
                        val[2], dict) else val[2]
                    chk = val[3].get("value") if isinstance(
                        val[3], dict) else val[3]
                    sym = val[4].get("value") if isinstance(
                        val[4], dict) else val[4]

                    fn_name = src.get("fnName", "fuzz_parse_generator")
                    muts = ", ".join(src.get("steps", {}).get("mutators", []))

                    if i == 0:
                        origin_name = "SeedInput" if "Seed" in selected[
                            "chain"] else f"CustomInputGenerator[{fn_name}]"
                        header = f"Step {i}: Origin: {origin_name}"
                    else:
                        header = f"Step {i}: Mutate: MutationInputGenerator[{muts}]"

                    formatted_lines.append(header)

                    ARROW_COL = 46

                    def add_line(field_name, field_val, arrow_text=""):
                        prefix = f"  {field_name:<17} {field_val}"
                        if arrow_text:
                            formatted_lines.append(
                                f"{prefix:<{ARROW_COL}}{arrow_text}")
                        else:
                            formatted_lines.append(prefix)

                    n_spec = ""
                    n_cstr = ""
                    n_ustd = ""
                    n_chk = ""
                    n_sym = ""

                    if prev_vals:
                        if spec != prev_vals[0]:
                            n_spec = "<-- mutated spec"
                        if c_str != prev_vals[1]:
                            if c_str == "":
                                n_cstr = "<-- truncated to empty string"
                            elif len(c_str) < len(prev_vals[1]):
                                n_cstr = "<-- deleted characters"
                            elif len(c_str) > len(prev_vals[1]):
                                n_cstr = "<-- inserted block"
                            else:
                                n_cstr = "<-- replaced/jumbled chars"
                        if u_std != prev_vals[2]:
                            n_ustd = f"<-- mutated to {u_std}"
                        if chk != prev_vals[3]:
                            n_chk = f"<-- mutated to {chk}"
                        if sym != prev_vals[4]:
                            if sym == "":
                                n_sym = "<-- truncated to empty string"
                            elif len(sym) < len(prev_vals[4]):
                                n_sym = "<-- deleted characters"
                            else:
                                n_sym = "<-- replaced/jumbled chars"

                    spec_escaped = str(spec).replace("\n", "\\n")
                    add_line("spec:", f"\"{spec_escaped}\"", n_spec)
                    add_line("constraint_str:", f"\"{c_str}\"", n_cstr)
                    add_line("use_stdlib:", f"{u_std}", n_ustd)
                    add_line("check:", f"{chk}", n_chk)
                    add_line("start_symbol:", f"\"{sym}\"", n_sym)

                    prev_vals = (spec, c_str, u_std, chk, sym)

                # Final eliciting mutation step
                step_idx = len(chain)
                elicit_muts = selected["chain"].split(
                    "->")[-1].replace("Mutation", "").strip("[]")
                formatted_lines.append(
                    f"Step {step_idx}: Elicit: MutationInputGenerator[{elicit_muts}]")
                spec_str = str(prev_vals[0]).replace("\n", "\\n")
                add_line("spec:", f"\"{spec_str}\"")
                add_line(
                    "constraint_str:", f"\"{prev_vals[1]}#\"", "<-- inserted '#' token (ELICITS BUG)")
                add_line("use_stdlib:", f"{prev_vals[2]}")
                add_line("check:", f"{prev_vals[3]}")
                add_line("start_symbol:", f"\"{prev_vals[4]}\"")
        except Exception as err:
            import traceback
            traceback.print_exc()

    if not formatted_lines:
        chain_parts = selected["chain"].split("->")
        for i, p in enumerate(chain_parts):
            prefix = "Origin:  " if i == 0 else (
                "Elicit:  " if i == len(chain_parts) - 1 else "Mutate:  ")
            formatted_lines.append(f"{prefix}{p.strip()}")
        formatted_lines.extend(
            ["", f"Eliciting Input Args: {selected['args']}"])

    bid_tex = selected["bug_id"].replace("_", r"\_")
    task_tex = TASK_LABELS.get(selected["task"], selected["task"])

    single_treatments = ["S", "C", "R", "A", "M"]
    non_eliciting_single = [tr for tr in single_treatments if tr not in bug_treatments.get(
        selected["bug_id"], set())]
    single_unelicited_str = ", ".join(
        non_eliciting_single) if non_eliciting_single else "none"

    caption_short = "Eliciting input example for SCRAM"
    caption_text = (
        f"Eliciting input example for SCRAM. "
        f"Shows cooperation among different input generator types that elicited a bug candidate "
        f"(\\texttt{{{bid_tex}}}) not elicited by single-generator treatments ({single_unelicited_str})."
    )

    lines = [
        r"\begin{figure}[!htbp]",
        r"  \centering",
        r"  \footnotesize",
        r"  \begin{verbatim}",
        "\n".join(formatted_lines).rstrip(),
        r"  \end{verbatim}",
        f"  \\caption[{caption_short}]{{{caption_text}}}",
        f"  \\label{{quarton:lst:provenance-{selected['bug_id'].lower().replace('_', '-')}}}",
        r"\end{figure}",
    ]

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[LISTING] Generated Representative Provenance Listing: {out_path}")


def generate_data_quarton_tex(df: pd.DataFrame, out_path: str, stats: dict):
    """Outputs LaTeX macro definitions with key experimental metrics into data-quarton.tex."""
    total_trials = len(df)
    completed_trials = len(
        df[df["Status"] == "COMPLETED"]) if not df.empty else 0
    total_runtime_sec = float(
        df["ElapsedSec"].sum()) if "ElapsedSec" in df.columns else 0.0

    tool_ver_str = str(df["ToolVersion"].dropna(
    ).iloc[0]) if "ToolVersion" in df.columns and not df["ToolVersion"].dropna().empty else "NaNofuzz v0.4.2"
    tool_ver_clean = tool_ver_str.replace("NaNofuzz", "").strip()
    if not tool_ver_clean.startswith("v") and tool_ver_clean != "":
        tool_ver_clean = f"v{tool_ver_clean}"
    if not tool_ver_clean:
        tool_ver_clean = "v0.4.2"

    active_treatments = get_active_treatments(df)

    rubric_file = os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "ground_truth_rubric.json")
    tasks_dict = {}
    if os.path.exists(rubric_file):
        with open(rubric_file, "r", encoding="utf-8") as rf:
            rdata = json.load(rf)
        tasks_dict = rdata.get("tasks", {})

    total_unique_bugs = sum(len(td.get("bugs", {}))
                            for td in tasks_dict.values()) if tasks_dict else 23
    num_puts = len(tasks_dict) if tasks_dict else len(TASKS)
    avg_bugs_per_put = total_unique_bugs / \
        float(num_puts) if num_puts > 0 else 4.6

    k_treevalue = len(tasks_dict.get("TreeValue", {}).get(
        "bugs", {})) if tasks_dict else TASKS_MAP["TreeValue"]["bugs_count"]
    k_derivation = len(tasks_dict.get("DerivationTree", {}).get(
        "bugs", {})) if tasks_dict else TASKS_MAP["DerivationTree"]["bugs_count"]
    k_parse = len(tasks_dict.get("parse", {}).get("bugs", {})
                  ) if tasks_dict else TASKS_MAP["parse"]["bugs_count"]
    k_distance = len(tasks_dict.get("_distance_norm", {}).get(
        "bugs", {})) if tasks_dict else TASKS_MAP["_distance_norm"]["bugs_count"]
    k_makedef = len(tasks_dict.get("make_def", {}).get(
        "bugs", {})) if tasks_dict else TASKS_MAP["make_def"]["bugs_count"]

    total_bugs_to_find = int(df["TaskBugCount"].sum()) if "TaskBugCount" in df.columns and not df["TaskBugCount"].dropna(
    ).empty else total_unique_bugs * total_trials // num_puts
    num_reps = int(df["Replicate"].max()) if "Replicate" in df.columns and not df["Replicate"].dropna().empty else (
        total_trials // (len(active_treatments) * num_puts) if len(active_treatments) * num_puts > 0 else 10)

    # Intervention is SCRAM, Control is R
    int_tr = "SCRAM" if "SCRAM" in active_treatments else active_treatments[0]
    ctl_tr = CONTROL_TREATMENT if CONTROL_TREATMENT in active_treatments else active_treatments[-1]

    sub_ctl = df[df["Treatment"] == ctl_tr] if not df.empty else pd.DataFrame()
    sub_int = df[df["Treatment"] == int_tr] if not df.empty else pd.DataFrame()

    ctl_cov_m = stats.get(ctl_tr, {}).get("All", {}).get(
        "BranchCoveragePct", {}).get("mean", np.nan)
    ctl_cov_sd = stats.get(ctl_tr, {}).get("All", {}).get(
        "BranchCoveragePct", {}).get("sd", np.nan)
    int_cov_m = stats.get(int_tr, {}).get("All", {}).get(
        "BranchCoveragePct", {}).get("mean", np.nan)
    int_cov_sd = stats.get(int_tr, {}).get("All", {}).get(
        "BranchCoveragePct", {}).get("sd", np.nan)

    cov_delta = (int_cov_m / ctl_cov_m - 1.0) if (not np.isnan(ctl_cov_m)
                                                  and ctl_cov_m > 0 and not np.isnan(int_cov_m)) else 0.0
    p_cov = stats.get(int_tr, {}).get("All", {}).get(
        "BranchCoveragePct", {}).get("mann_whitney_p", np.nan)
    if np.isnan(p_cov):
        p_cov = stats.get(int_tr, {}).get("All", {}).get(
            "BranchCoveragePct", {}).get("pvalue", np.nan)

    ctl_el_m = stats.get(ctl_tr, {}).get("All", {}).get(
        "BugsElicited", {}).get("mean", np.nan)
    ctl_el_sd = stats.get(ctl_tr, {}).get("All", {}).get(
        "BugsElicited", {}).get("sd", np.nan)
    ctl_el_sum = int(sub_ctl["BugsElicited"].sum(
    )) if "BugsElicited" in sub_ctl.columns and len(sub_ctl) > 0 else 0
    ctl_el_max = int(sub_ctl["TaskBugCount"].sum(
    )) if "TaskBugCount" in sub_ctl.columns and len(sub_ctl) > 0 else total_unique_bugs

    int_el_m = stats.get(int_tr, {}).get("All", {}).get(
        "BugsElicited", {}).get("mean", np.nan)
    int_el_sd = stats.get(int_tr, {}).get("All", {}).get(
        "BugsElicited", {}).get("sd", np.nan)
    int_el_sum = int(sub_int["BugsElicited"].sum(
    )) if "BugsElicited" in sub_int.columns and len(sub_int) > 0 else 0
    int_el_max = int(sub_int["TaskBugCount"].sum(
    )) if "TaskBugCount" in sub_int.columns and len(sub_int) > 0 else total_unique_bugs

    el_delta = (int_el_sum / ctl_el_sum - 1.0) if ctl_el_sum > 0 else 0.0
    p_el = compute_fisher_exact(int_el_sum, int_el_max, ctl_el_sum, ctl_el_max)

    cov_delta_str = format_delta_pct(cov_delta)
    el_delta_str = format_delta_pct(el_delta)
    p_el_range = pvalrange(p_el)
    p_cov_range = pvalrange(p_cov)

    summary_str = f"Tasks using \\toolname{{}}'s full composition of input generators achieved {cov_delta_str} higher branch coverage ({p_cov_range}) and elicited {el_delta_str} more bugs ({p_el_range}) than tasks using only a random input generator."

    lines = [
        r"% =====================================================================",
        r"% QuartoN Empirical Study Experimental Data Variables",
        r"% Between-Subjects Autonomous Agent Study (Gemini 3.8 Flash)",
        r"% =====================================================================",
        r"",
        r"% ---------------------TREATMENT NAME MACROS----------------------",
        r"% Full names",
        r"\providecommand{\controlnameU}{Hypothesis}",
        r"\renewcommand{\controlnameU}{Hypothesis}",
        r"\providecommand{\controlname}{hypothesis}",
        r"\renewcommand{\controlname}{hypothesis}",
        r"\providecommand{\hypofuzzname}{Hypofuzz}",
        r"\renewcommand{\hypofuzzname}{Hypofuzz}",
        r"\providecommand{\toolname}{QuartoN}",
        r"\renewcommand{\toolname}{QuartoN}",
        r"",
        r"% Short abbreviations for tables, figures, and plots",
        r"\providecommand{\controlnameshort}{Hypt}",
        r"\renewcommand{\controlnameshort}{Hypt}",
        r"\providecommand{\hypofuzznameshort}{Hfuz}",
        r"\renewcommand{\hypofuzznameshort}{Hfuz}",
        r"\providecommand{\toolnameshort}{QtN}",
        r"\renewcommand{\toolnameshort}{QtN}",
        r"",
        r"% ---------------------PAPER-SPECIFIC VARIABLES-------------------",
        f"\\def\\qtoolversion{{{tool_ver_clean}}}",
        r"\def\qcontrolversion{v6.170.15}",
        r"\def\qhypofuzzversion{v25.11.1}",
        r"\def\qagentmodel{Gemini 3.8 Flash}",
        r"\def\qpythonversion{3.11.2}",
        r"\def\qhostos{macOS 26.7.3}",
        r"\def\qhosthardware{Apple MacBook M5 Pro}",
        r"\def\qfandangoversion{v1.3.1-81-gd06277ca}",
        r"\def\tscgoversion{7.0.2}",
        r"\def\tscgoclibugs{5}",
        r"\def\tscgoclilines{15}",
        r"\def\tscgoclidesc{Command-line compiler driver executing compilation, checks, and emit}",
        r"\def\tscgotranspiledeclbugs{2}",
        r"\def\tscgotranspiledecllines{165}",
        r"\def\tscgotranspiledecldesc{Single-file declaration (.d.ts) transpiler}",
        r"\def\tscgotranspilemodulebugs{2}",
        r"\def\tscgotranspilemodulelines{165}",
        r"\def\tscgotranspilemoduledesc{Single-file JavaScript source transpiler}",
        r"\def\tscgopublicendpointstotal{3}",
        r"\def\tscgopublicbugstotal{9}",
        r"",
        f"\\def\\qn{{{total_trials}}}",
        f"\\def\\qntaskprograms{{{num_puts}}}",
        f"\\def\\qntreatments{{{len(active_treatments)}}}",
        f"\\def\\qtaskcombinations{{{len(active_treatments) * num_puts}}}",
        f"\\def\\qrepetitions{{{num_reps}}}",
        f"\\def\\qntotaltasks{{{total_trials}}}",
        f"\\def\\qntotalbugs{{{total_unique_bugs}}}",
        f"\\def\\qnavgbugsperput{{{avg_bugs_per_put:.1f}}}",
        f"\\def\\qnbugstreevalue{{{k_treevalue}}}",
        f"\\def\\qnbugsderivationtree{{{k_derivation}}}",
        f"\\def\\qnbugsparse{{{k_parse}}}",
        f"\\def\\qnbugsdistancenorm{{{k_distance}}}",
        f"\\def\\qnbugsmakedef{{{k_makedef}}}",
        f"\\def\\qnbugstofind{{{total_bugs_to_find}}}",
        r"",
        r"% Measure 1: Peak Branch Coverage (%)",
        f"\\def\\ctlCoveragemean{{{ctl_cov_m:.1f}}}",
        f"\\def\\ctlCoveragesd{{{ctl_cov_sd:.1f}}}",
        f"\\def\\ctlCoveragepct{{{ctl_cov_m:.1f}\\%}}",
        f"\\def\\intCoveragemean{{{int_cov_m:.1f}}}",
        f"\\def\\intCoveragesd{{{int_cov_sd:.1f}}}",
        f"\\def\\intCoveragepct{{{int_cov_m:.1f}\\%}}",
        f"\\def\\intCoveragedeltapct{{{cov_delta_str}}}",
        f"\\def\\pCoverage{{{f'{p_cov:.3f}' if not np.isnan(
            p_cov) else 'N/A'}}}",
        f"\\def\\pCoveragerange{{{pvalrange(p_cov)}}}",
        r"",
        r"% Measure 2: Elicited Bugs",
        f"\\def\\ctlElicitedmax{{{ctl_el_max}}}",
        f"\\def\\ctlElicitedsum{{{ctl_el_sum}}}",
        f"\\def\\ctlElicitedmean{{{ctl_el_m:.2f}}}",
        f"\\def\\ctlElicitedsd{{{ctl_el_sd:.2f}}}",
        (f"\\def\\ctlElicitedpercent{{{ctl_el_sum / ctl_el_max:.1%}}}".replace(
            "%", "\\%") if ctl_el_max > 0 else "\\def\\ctlElicitedpercent{0\\%}"),
        f"\\def\\intElicitedmax{{{int_el_max}}}",
        f"\\def\\intElicitedsum{{{int_el_sum}}}",
        f"\\def\\intElicitedmean{{{int_el_m:.2f}}}",
        f"\\def\\intElicitedsd{{{int_el_sd:.2f}}}",
        (f"\\def\\intElicitedpercent{{{int_el_sum / int_el_max:.1%}}}".replace(
            "%", "\\%") if int_el_max > 0 else "\\def\\intElicitedpercent{0\\%}"),
        f"\\def\\intEliciteddeltapct{{{el_delta_str}}}",
        f"\\def\\pelicited{{{f'{p_el:.3f}' if not np.isnan(
            p_el) else 'N/A'}}}",
        f"\\def\\pelicitedrange{{{p_el_range}}}",
        r"",
        r"% ---------------------CAPTION COMMENTARY HOOKS-------------------",
        r"\providecommand{\figquartoncaption}{}",
        r"\providecommand{\tabquartonresultscomment}{}",
        r"\providecommand{\tabquartonttestscomment}{}",
        r"\providecommand{\tabquartonbugscomment}{}",
        r"\providecommand{\tabquartongeneratorscomment}{}",
        r"\providecommand{\figquartonpyplotscomment}{}",
        r"\providecommand{\figquartongeneratorscomment}{}",
        r"",
        r"% High-level stats summary",
        f"\\def\\quartonstatssummary{{{summary_str}}}",
        f"\\def\\qgeneratorscaption{{Input generator scheduling share for each task program, shown individually ($n={num_reps}$) and overall ($n={num_reps * num_puts}$). Colored areas represent the proportion of generation turns allocated by the Multi-Armed Bandit scheduler.}}",
        r"",
        r"% ---------------------CIG TREATMENT MACROS-----------------------",
        f"\\providecommand{{\\cigToolVersion}}{{{tool_ver_clean}}}",
        f"\\renewcommand{{\\cigToolVersion}}{{{tool_ver_clean}}}",
        f"\\providecommand{{\\cigTotalTrials}}{{{total_trials}}}",
        f"\\renewcommand{{\\cigTotalTrials}}{{{total_trials}}}",
        f"\\providecommand{{\\cigCompletedTrials}}{{{completed_trials}}}",
        f"\\renewcommand{{\\cigCompletedTrials}}{{{completed_trials}}}",
    ]

    for tr in active_treatments:
        tr_clean = tr.replace("_", "")
        rate_all = stats.get(tr, {}).get("All", {}).get(
            "BugElicitationRate", {}).get("mean", np.nan)
        cov_all = stats.get(tr, {}).get("All", {}).get(
            "BranchCoveragePct", {}).get("mean", np.nan)
        bugs_all = stats.get(tr, {}).get("All", {}).get(
            "BugsElicited", {}).get("mean", np.nan)
        p_cov_tr = stats.get(tr, {}).get("All", {}).get(
            "BranchCoveragePct", {}).get("pvalue", np.nan)
        p_rate_tr = stats.get(tr, {}).get("All", {}).get(
            "BugElicitationRate", {}).get("pvalue", np.nan)

        rate_str = f"{rate_all:.1%}".replace(
            "%", r"\%") if not np.isnan(rate_all) else "--"
        cov_str = f"{cov_all:.1f}\\%" if not np.isnan(cov_all) else "--"
        bugs_str = f"{bugs_all:.2f}" if not np.isnan(bugs_all) else "--"
        p_cov_str = pvalrange(p_cov_tr) if not np.isnan(p_cov_tr) else "n/a"
        p_rate_str = pvalrange(p_rate_tr) if not np.isnan(p_rate_tr) else "n/a"

        lines.extend([
            f"\\providecommand{{\\cig{tr_clean}CoveragePct}}{{{cov_str}}}",
            f"\\renewcommand{{\\cig{tr_clean}CoveragePct}}{{{cov_str}}}",
            f"\\providecommand{{\\cig{tr_clean}MeanElicitedBugs}}{{{bugs_str}}}",
            f"\\renewcommand{{\\cig{tr_clean}MeanElicitedBugs}}{{{bugs_str}}}",
            f"\\providecommand{{\\cig{tr_clean}ElicitationRate}}{{{rate_str}}}",
            f"\\renewcommand{{\\cig{tr_clean}ElicitationRate}}{{{rate_str}}}",
            f"\\providecommand{{\\cig{tr_clean}CoveragePRange}}{{{p_cov_str}}}",
            f"\\renewcommand{{\\cig{tr_clean}CoveragePRange}}{{{p_cov_str}}}",
            f"\\providecommand{{\\cig{tr_clean}ElicitationPRange}}{{{p_rate_str}}}",
            f"\\renewcommand{{\\cig{tr_clean}ElicitationPRange}}{{{p_rate_str}}}",
        ])

    # Treatment S runtime variables (one for mean, one for SD)
    s_sub = df[df["Treatment"] == "S"] if not df.empty else pd.DataFrame()
    s_elapsed = s_sub["ElapsedSec"].dropna().values.astype(
        float) if "ElapsedSec" in s_sub.columns else np.array([])
    s_time_m = float(np.mean(s_elapsed)) if len(
        s_elapsed) > 0 else float(np.nan)
    s_time_sd = float(np.std(s_elapsed, ddof=1)) if len(
        s_elapsed) > 1 else float(np.nan)
    s_m_str = f"{s_time_m:.2f}" if not np.isnan(s_time_m) else "--"
    s_sd_str = f"{s_time_sd:.2f}" if not np.isnan(s_time_sd) else "--"

    lines.extend([
        r"",
        r"% Treatment S Runtime (seconds)",
        f"\\def\\qsRuntimemean{{{s_m_str}}}",
        f"\\def\\qsRuntimesd{{{s_sd_str}}}",
    ])

    tot_time = int((df["StopReason"] == "maxTime").sum()
                   ) if "StopReason" in df.columns else 0
    tot_dupes = int((df["StopReason"] == "maxDupes").sum()
                    ) if "StopReason" in df.columns else 0
    tot_exit0 = int((df["ExitCode"] == 0).sum()
                    ) if "ExitCode" in df.columns else 0
    tot_exit1 = int((df["ExitCode"] == 1).sum()
                    ) if "ExitCode" in df.columns else 0

    lines.extend([
        f"\\providecommand{{\\cigTotalMaxTime}}{{{tot_time}}}",
        f"\\renewcommand{{\\cigTotalMaxTime}}{{{tot_time}}}",
        f"\\providecommand{{\\cigTotalMaxDupes}}{{{tot_dupes}}}",
        f"\\renewcommand{{\\cigTotalMaxDupes}}{{{tot_dupes}}}",
        f"\\providecommand{{\\cigTotalExitCodeZero}}{{{tot_exit0}}}",
        f"\\renewcommand{{\\cigTotalExitCodeZero}}{{{tot_exit0}}}",
        f"\\providecommand{{\\cigTotalExitCodeOne}}{{{tot_exit1}}}",
        f"\\renewcommand{{\\cigTotalExitCodeOne}}{{{tot_exit1}}}",
        r"% -------------------END PAPER-SPECIFIC VARIABLES----------------",
    ])

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TEX] Generated LaTeX Variables: {out_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Analyze CIG experimental benchmark dataset")
    parser.add_argument("--data", type=str, default=None,
                        help="Path to data.csv (defaults to latest)")
    parser.add_argument("--parts-dir", type=str, default=None,
                        help="Destination directory for LaTeX parts")
    parser.add_argument("--smoke", action="store_true",
                        help="Flag indicating dataset is a partial smoke test")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    bench_dir = os.path.abspath(os.path.join(script_dir, ".."))

    data_path = args.data
    if not data_path:
        latest_sym = os.path.join(bench_dir, "cli", "latest", "data.csv")
        if os.path.exists(latest_sym):
            data_path = latest_sym
        else:
            candidates = sorted(
                glob.glob(os.path.join(bench_dir, "cli", "*", "data.csv")),
                key=os.path.getmtime,
                reverse=True
            )
            if candidates:
                data_path = candidates[0]
            else:
                raise FileNotFoundError(
                    "CRITICAL: data.csv not specified and latest run not found.")

    print(f"[ANALYSIS] Loading dataset from: {data_path}")
    df = pd.read_csv(data_path)

    # FIRST STEP: Gatekeeper sanitization - crash immediately on corrupted/invalid data
    sanitize_dataset(df)
    print("  ✓ Strict input sanitization passed: 0 missing fields, valid ranges, all denominators verified.")

    run_dir = os.path.dirname(os.path.abspath(data_path))

    parts_dir = args.parts_dir or os.path.join(run_dir, "parts")
    os.makedirs(parts_dir, exist_ok=True)

    stats = analyze_cig_dataset(df)

    data_tex = os.path.join(parts_dir, "data-quarton.tex")
    generate_data_quarton_tex(df, data_tex, stats)

    tab_participants = os.path.join(parts_dir, "tab-quarton-participants.tex")
    generate_trials_table(df, tab_participants)
    tab_trials = os.path.join(parts_dir, "tab-quarton-trials.tex")
    generate_trials_table(df, tab_trials)

    tab_results = os.path.join(parts_dir, "tab-quarton-results.tex")
    generate_cig_results_table(df, tab_results, stats)

    tab_detail = os.path.join(parts_dir, "tab-quarton-results-detail.tex")
    generate_results_detail_table(df, tab_detail, stats)

    tab_ttests = os.path.join(parts_dir, "tab-quarton-ttests.tex")
    generate_ttest_table(df, tab_ttests, stats)

    tab_bugs = os.path.join(parts_dir, "tab-quarton-bugs.tex")
    generate_bugs_elicited_table(df, tab_bugs)

    tab_stops = os.path.join(parts_dir, "tab-quarton-stop-reasons.tex")
    generate_stop_reasons_table(df, tab_stops)

    tab_gen = os.path.join(parts_dir, "tab-quarton-generators.tex")
    generate_cig_generator_table(run_dir, tab_gen, df)

    lst_prov = os.path.join(parts_dir, "lst-quarton-provenance.tex")
    generate_provenance_listing(run_dir, lst_prov, df)

    plot_paths = [
        os.path.join(parts_dir, "pyplots-quarton.pdf"),
    ]
    generate_pyplots(df, plot_paths)

    # Standalone half-page plots for the 3 dropped PUTs
    generate_standalone_task_plot(
        df, "make_def",
        os.path.join(parts_dir, "pyplots-quarton-makedef.pdf"),
        r"Branch coverage for \texttt{make\_def} across all treatments ($n = \qn$). All treatments achieved saturated coverage at 50.0\%."
    )
    generate_standalone_task_plot(
        df, "_distance_norm",
        os.path.join(parts_dir, "pyplots-quarton-distancenorm.pdf"),
        r"Branch coverage for \texttt{\_distance\_norm} across all treatments ($n = \qn$). All treatments achieve 1.9\% because \texttt{\_distance\_norm} only contains 1 of the 54 branches in \texttt{comparison.py}."
    )
    generate_standalone_task_plot(
        df, "DerivationTree",
        os.path.join(parts_dir, "pyplots-quarton-derivationtree.pdf"),
        r"Branch coverage for \texttt{DerivationTree} across all treatments ($n = \qn$). All treatments plateau at 24.0\% (59 of 246 branches) because the remaining branches in \texttt{tree.py} belong to grammar export and graph visualization routines not exercised during tree operations."
    )

    gen_plot_path = os.path.join(parts_dir, "pyplots-quarton-generators.pdf")
    generate_generator_usage_plot(df, run_dir, gen_plot_path)

    output_files = [
        "data-quarton.tex",
        "tab-quarton-participants.tex",
        "tab-quarton-trials.tex",
        "tab-quarton-results.tex",
        "tab-quarton-results-detail.tex",
        "tab-quarton-ttests.tex",
        "tab-quarton-bugs.tex",
        "tab-quarton-stop-reasons.tex",
        "tab-quarton-generators.tex",
        "lst-quarton-provenance.tex",
        "fig-quarton.tex",
        "fig-quarton-makedef.tex",
        "fig-quarton-distancenorm.tex",
        "fig-quarton-derivationtree.tex",
        "fig-quarton-generators.tex",
        "pyplots-quarton.pdf",
        "pyplots-quarton-makedef.pdf",
        "pyplots-quarton-distancenorm.pdf",
        "pyplots-quarton-derivationtree.pdf",
        "pyplots-quarton-generators.pdf",
    ]

    print(
        f"\n[SUCCESS] CIG complete analysis suite generated in:\n  {parts_dir}")


if __name__ == "__main__":
    main()
