#!/usr/bin/env python3
# type: ignore
"""
QuartoN Empirical Study Analysis Pipeline (Chapter 5)
Between-Subjects Autonomous Agent Study (Gemini 3.8 Flash)

Generates:
  1. parts/data-quarton.tex (LaTeX variables)
  2. parts/tab-quarton-participants.tex (Table 5.3)
  3. parts/tab-quarton-results.tex (Table 5.4)
  4. parts/tab-quarton-results-detail.tex (Table 5.5)
  5. figures/pyplots-quarton.pdf & parts/pyplots-quarton.pdf (Figure 5.4)
  6. figures/pyplots-quarton-coverage.pdf & parts/pyplots-quarton-coverage.pdf (Branch Coverage by PUT)
"""

import argparse
import glob
import json
import os
import re
import sys
import numpy as np
import pandas as pd
import scipy.stats as st

mpl = None
plt = None
fm = None
HAS_MATPLOTLIB = False

try:
    import matplotlib as mpl  # type: ignore
    import matplotlib.pyplot as plt  # type: ignore
    import matplotlib.font_manager as fm  # type: ignore
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

TREATMENTS = ["hypothesis", "hypofuzz", "nanofuzz"]
TREATMENT_MACROS = {
    "hypothesis": r"\controlnameU",
    "hypofuzz": r"\hypofuzzname",
    "nanofuzz": r"\toolname",
}
TREATMENT_SHORT_MACROS = {
    "hypothesis": r"\controlnameshort",
    "hypofuzz": r"\hypofuzznameshort",
    "nanofuzz": r"\toolnameshort",
}
TREATMENT_SHORT_TEXT = ["Hypt", "Hfuz", "QtN"]

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


def generate_pyplots(df: pd.DataFrame, pdf_paths: list[str]):
    if not HAS_MATPLOTLIB:
        print("[WARN] matplotlib not available, skipping plot generation.")
        return

    mpl.rcParams["font.family"] = "serif"
    mpl.rcParams["font.size"] = 7.5
    mpl.rcParams["axes.labelweight"] = "bold"

    fig = plt.figure(figsize=(7.5, 5.6))
    subfigs = fig.subfigures(2, 1, height_ratios=[1, 1])

    # Adjust margins to align outer left and right boundaries across rows and provide room for bottom labels
    subfigs[0].subplots_adjust(left=0.07, right=0.98, bottom=0.26, top=0.92, wspace=0.35)

    # Subfigure 0: Row 1 - Code Coverage (Measure 1) for first 4 PUTs (4 plots)
    axs_r1 = subfigs[0].subplots(1, 4)
    fig.canvas.draw()

    # Subfigure 1: Row 2 - 3 plots with exact same size as Row 1: left, middle, right
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
        ax.set_xticks([1, 2, 3])
        ax.set_xticklabels(group_labels)
        ax.spines[:].set_visible(False)
        ax.tick_params(axis="both", which="both", bottom=False, left=False)
        ax.set_xlabel(xlabel, fontsize=7.5, labelpad=4)
        ax.set_ylabel(ylabel, fontsize=7)
        if ylim:
            ax.set_ylim(ylim)

        # Violin plots
        try:
            violins = ax.violinplot(data, widths=0.7, showextrema=False)
            for pc in violins.get("bodies", []):
                pc.set_facecolor("none")
                pc.set_edgecolor("black")
                pc.set_alpha(1.0)
                pc.set_linewidth(1.0)
        except Exception:
            pass

        # Jitter points & mean black dot
        for i, vals in enumerate(data):
            x = i + 1
            if len(vals) > 0 and not (len(vals) == 1 and vals[0] == 0.0):
                jitter = x + np.random.normal(0, 0.04, len(vals))
                ax.scatter(jitter, vals, s=11, color="grey",
                           alpha=0.5, edgecolors="none")
                ax.scatter(x, np.mean(vals), s=32, color="black", zorder=3)
            else:
                ax.scatter(x, 0, s=32, color="black", zorder=3)

    def put_mathtt(task_name: str) -> str:
        safe_name = str(task_name).replace("_", r"\_")
        return f"$(\\mathbf{{\\mathtt{{{safe_name}}}}})$"

    # Row 1: Measure 1 - Branch Coverage (%) for first 4 PUTs (4 plots)
    for c_idx, task in enumerate(TASKS[:4]):
        ax = axs_r1[c_idx]
        data = []
        for t in ["hypothesis", "hypofuzz", "nanofuzz"]:
            sub = df[(df["Task"] == task) & (df["Tool"].str.lower() == t)] if not df.empty else pd.DataFrame()
            vals = sub["BranchCoveragePct"].dropna().values.astype(float) if "BranchCoveragePct" in sub.columns else []
            data.append(vals if len(vals) > 0 else np.array([0.0]))
        render_violin_cell(ax, data, TREATMENT_SHORT_TEXT, f"(1) Branch Coverage\n{put_mathtt(task)}", "Branch Cov. (%)", (0, 105))

    # Row 2: 5th PUT Coverage at col 0, Task Time at col 1, Bugs Elicited at col 2, col 3 hidden
    # Col 0: Measure 1 - make_def
    task_5 = TASKS[4]
    ax_5 = axs_r2[0]
    data_5 = []
    for t in ["hypothesis", "hypofuzz", "nanofuzz"]:
        sub = df[(df["Task"] == task_5) & (df["Tool"].str.lower() == t)] if not df.empty else pd.DataFrame()
        vals = sub["BranchCoveragePct"].dropna().values.astype(float) if "BranchCoveragePct" in sub.columns else []
        data_5.append(vals if len(vals) > 0 else np.array([0.0]))
    render_violin_cell(ax_5, data_5, TREATMENT_SHORT_TEXT, f"(1) Branch Coverage\n{put_mathtt(task_5)}", "Branch Cov. (%)", (0, 105))

    # Col 1: (2) Task Time by Treatment
    ax_time = axs_r2[1]
    data_time = []
    for k in ["hypothesis", "hypofuzz", "nanofuzz"]:
        sub = df[df["Tool"].str.lower() == k] if not df.empty else pd.DataFrame()
        vals = sub["ElapsedSec"].dropna().values.astype(float) if "ElapsedSec" in sub.columns else []
        data_time.append(vals if len(vals) > 0 else np.array([0.0]))
    render_violin_cell(ax_time, data_time, TREATMENT_SHORT_TEXT, "(2) Task Time", "Elapsed Time (s)", None)

    # Col 2: (3) Bugs Elicited by Treatment
    ax_bugs = axs_r2[2]
    data_bugs = []
    for k in ["hypothesis", "hypofuzz", "nanofuzz"]:
        sub = df[df["Tool"].str.lower() == k] if not df.empty else pd.DataFrame()
        vals = sub["BugsElicited"].dropna().values.astype(float) if "BugsElicited" in sub.columns else []
        data_bugs.append(vals if len(vals) > 0 else np.array([0.0]))
    render_violin_cell(ax_bugs, data_bugs, TREATMENT_SHORT_TEXT, "(3) Bugs Elicited", "Bugs Elicited (Count)", (0, 6.2))

    for p in pdf_paths:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        fig.savefig(p, format="pdf", dpi=300)
        print(f"[PLOT] Generated stacked violin distribution plot: {p}")
    plt.close(fig)


def generate_participants_table(df: pd.DataFrame, out_path: str):
    def clean_task_name(task: str) -> str:
        name = os.path.basename(str(task))
        if name.endswith(".py"):
            name = name[:-3]
        return name.replace("_", r"\_")

    def participant_num(p: str) -> int:
        m = re.search(r"\d+", str(p))
        return int(m.group()) if m else 0

    def seeded_shuffle(arr, seed_str="qwertonyuiop"):
        h = 0
        for ch in seed_str:
            h = (31 * h + ord(ch)) & 0xFFFFFFFF
            if h >= 0x80000000:
                h -= 0x100000000
        s = h & 0xFFFFFFFF

        def rnd():
            nonlocal s
            s = (1664525 * s + 1013904223) & 0xFFFFFFFF
            return s / 4294967296.0

        res = list(arr)
        for i in range(len(res) - 1, 0, -1):
            j = int(rnd() * (i + 1))
            res[i], res[j] = res[j], res[i]
        return res

    rubric_tasks = ["TreeValue", "DerivationTree", "parse", "_distance_norm", "make_def"]
    engines = ["hypothesis", "hypofuzz", "nanofuzz"]
    sources = ["docs", "tests", "all"]

    if df.empty:
        # Default 135-participant factorial design (3 replicates) in ascending order
        design_runs = []
        for rep in range(1, 4):
            for eng in ["nanofuzz", "hypothesis", "hypofuzz"]:
                for src in ["tests", "docs", "all"]:
                    for task in rubric_tasks:
                        design_runs.append({"Tool": eng, "InvariantSource": src, "Task": task, "Replicate": rep})
        shuffled = seeded_shuffle(design_runs, "qwertonyuiop")
        participants_data = []
        for idx, r in enumerate(shuffled):
            participants_data.append({
                "Participant": f"P{idx+1:02d}",
                "Tool": r["Tool"],
                "InvariantSource": r["InvariantSource"],
                "Task": r["Task"],
                "Replicate": r.get("Replicate", 1),
            })
        target_df = pd.DataFrame(participants_data)
    else:
        target_df = df.drop_duplicates(subset=["Participant"]).copy()

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \setlength{\tabcolsep}{3pt}",
        r"  \footnotesize",
        r"  \caption[AI Agents]{AI Agents ($n=\qn$, AI Agent: \qagentmodel)}",
        r"  \label{quarton:tab:participants}",
        r"  \begin{tabular}{@{} l | ccccc @{}}",
        r"    \toprule",
        r"    \multicolumn{1}{c|}{\textbf{Behavior}} & \multicolumn{5}{c}{\textbf{Task Program}} \\",
        r"    \multicolumn{1}{c|}{\textbf{Source}} & \texttt{TreeValue} & \texttt{Derivation} & \texttt{parse} & \texttt{\_distance} & \texttt{make\_def} \\",
        r"    \midrule",
    ]

    source_labels = [("docs", "Documentation"), ("tests", "Test Suite"), ("all", "Both")]
    tool_headers = [
        ("hypothesis", r"\controlnameU"),
        ("hypofuzz", r"\hypofuzzname"),
        ("nanofuzz", r"\toolname"),
    ]

    for t_idx, (tool, tool_name) in enumerate(tool_headers):
        lines.append(f"    & \\multicolumn{{5}}{{c}}{{\\textbf{{{tool_name}}}}} \\\\")
        lines.append(r"    \midrule")
        for s_idx, (src_key, src_label) in enumerate(source_labels):
            row_cells = [src_label]
            for task in rubric_tasks:
                sub = target_df[
                    (target_df["Task"] == task)
                    & (target_df["Tool"].str.lower() == tool)
                    & (target_df["InvariantSource"].str.lower() == src_key)
                ]
                sub = sub.sort_values(
                    by="Participant",
                    key=lambda col: col.map(participant_num)
                )
                pids = sub["Participant"].tolist()
                cell_text = ", ".join(pids) if pids else "--"
                row_cells.append(cell_text)
            lines.append("    " + " & ".join(row_cells) + r" \\")
            if s_idx < len(source_labels) - 1:
                lines.append(r"    \hline")
        if t_idx < len(tool_headers) - 1:
            lines.append(r"    \midrule")

    lines.extend([
        r"    \bottomrule",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Table 5.3: {out_path}")


def generate_results_table(df: pd.DataFrame, out_path: str, stats: dict):
    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \setlength{\tabcolsep}{2pt}",
        r"  \definecolor{bettergreen}{RGB}{169,223,192}",
        r"  \definecolor{worsered}{RGB}{245,183,177}",
        r"  \caption{Quantitative Task Results Summary for Measures 1--3 ($n=\qn$)}",
        r"  \label{quarton:tab:results}",
        r"  \footnotesize",
        r"  \begin{tabularx}{\textwidth}{l| *{4}{>{\raggedleft\arraybackslash}X >{\centering\arraybackslash}X |} >{\raggedleft\arraybackslash}X >{\centering\arraybackslash}X || >{\raggedleft\arraybackslash}X >{\centering\arraybackslash}X}",
        r"    \toprule",
        r"    & \multicolumn{10}{c||}{\textbf{Task Programs (see Table~\ref{quarton:tab:tasks})}} ",
        r"    & \multicolumn{2}{c}{\textbf{All Tasks}} \\",
        r"    ",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{TreeValue}}}",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{Derivation}}}",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{parse}}}",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{\_distance}}}",
        r"    & \multicolumn{2}{c||}{\textbf{\texttt{make\_def}}}",
        r"    & \multicolumn{2}{c}{\textbf{$\Sigma$}} \\",
        r"",
        r"    \midrule",
        r"",
        r"    \multicolumn{1}{c|}{\textbf{Treatment}} ",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD} ",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD} \\",
    ]

    measures = [
        ("BranchCoveragePct", r"Measure 1: Branch Coverage (\%); higher is better", 1),
        ("ElapsedSec", r"Measure 2: Task Time (in seconds); lower is better", 0),
        ("BugsElicited", r"Measure 3: Bugs Elicited; higher is better", 1),
    ]

    for col, title, dec in measures:
        lines.extend([
            r"    \midrule",
            f"    \\multicolumn{{13}}{{c}}{{\\textbf{{{title}}}}} \\\\",
            r"    \midrule",
        ])

        for tool in TREATMENTS:
            macro = TREATMENT_MACROS[tool]
            row_items = [f"    \\textbf{{{macro}}}"]
            for task in TASKS:
                m_val = stats[tool][task][col]["mean"]
                sd_val = stats[tool][task][col]["sd"]
                ctl_m = stats["hypothesis"][task][col]["mean"]
                p_val = stats[tool][task][col].get("pvalue", None)
                row_items.append(format_sig_cell(tool, col, m_val, sd_val, ctl_m, p_val, dec))

            # All Tasks overall
            all_m = stats[tool]["All"][col]["mean"]
            all_sd = stats[tool]["All"][col]["sd"]
            all_ctl_m = stats["hypothesis"]["All"][col]["mean"]
            all_p_val = stats[tool]["All"][col].get("pvalue", None)
            row_items.append(format_sig_cell(tool, col, all_m, all_sd, all_ctl_m, all_p_val, dec))

            line_str = " & ".join(row_items) + r" \\"
            lines.append(line_str)
            if tool != TREATMENTS[-1]:
                lines.append(r"    \hline")

    # Stack Source version under Treatment version (repeat row 3 for source in between)
    sources = ["docs", "tests", "all"]
    source_labels = {
        "docs": r"\textbf{Documentation}",
        "tests": r"\textbf{Unit tests}",
        "all": r"\textbf{Both sources}"
    }

    stats_source = {}
    for src in sources:
        stats_source[src] = {}
        for task in TASKS:
            stats_source[src][task] = {}
            sub = df[(df["InvariantSource"].str.lower() == src) & (df["Task"] == task)]
            for col, _, _ in measures:
                vals = sub[col].dropna().values.astype(float) if not sub.empty and col in sub.columns else []
                stats_source[src][task][col] = {
                    "mean": float(np.mean(vals)) if len(vals) > 0 else 0.0,
                    "sd": float(np.std(vals)) if len(vals) > 0 else 0.0,
                    "vals": vals
                }
        stats_source[src]["All"] = {}
        sub_all = df[df["InvariantSource"].str.lower() == src]
        for col, _, _ in measures:
            vals = sub_all[col].dropna().values.astype(float) if not sub_all.empty and col in sub_all.columns else []
            stats_source[src]["All"][col] = {
                "mean": float(np.mean(vals)) if len(vals) > 0 else 0.0,
                "sd": float(np.std(vals)) if len(vals) > 0 else 0.0,
                "vals": vals
            }

    # Significance tests for Both vs Docs and Tests vs Docs
    for task in TASKS + ["All"]:
        for col, _, _ in measures:
            s_docs = stats_source["docs"][task][col]["vals"]
            for src in ["tests", "all"]:
                s_src = stats_source[src][task][col]["vals"]
                p = compute_ttest(s_src, s_docs)
                stats_source[src][task][col]["pvalue"] = p
                stats_source[src][task][col]["star"] = pvalstars(p)

    source_lines = [
        r"    \midrule",
        r"    \midrule",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{TreeValue}}}",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{Derivation}}}",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{parse}}}",
        r"    & \multicolumn{2}{c|}{\textbf{\texttt{\_distance}}}",
        r"    & \multicolumn{2}{c||}{\textbf{\texttt{make\_def}}}",
        r"    & \multicolumn{2}{c}{\textbf{$\Sigma$}} \\",
        r"    \midrule",
        r"    \multicolumn{1}{c|}{\textbf{Behavior Source}} ",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD}",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD} ",
        r"    & \multicolumn{1}{c}{\textbf{Mean}} ",
        r"    & \textbf{SD} \\",
    ]

    for col, title, dec in measures:
        source_lines.extend([
            r"    \midrule",
            f"    \\multicolumn{{13}}{{c}}{{\\textbf{{{title}}}}} \\\\",
            r"    \midrule",
        ])

        for src in sources:
            label = source_labels[src]
            row_items = [f"    {label}"]
            for task in TASKS:
                m_val = stats_source[src][task][col]["mean"]
                sd_val = stats_source[src][task][col]["sd"]
                ctl_m = stats_source["docs"][task][col]["mean"]
                p_val = stats_source[src][task][col].get("pvalue", None) if src in ["tests", "all"] else None
                row_items.append(format_sig_cell(src, col, m_val, sd_val, ctl_m, p_val, dec, base_tool="docs"))

            # All Tasks overall for this source
            all_m = stats_source[src]["All"][col]["mean"]
            all_sd = stats_source[src]["All"][col]["sd"]
            all_ctl_m = stats_source["docs"]["All"][col]["mean"]
            all_p_val = stats_source[src]["All"][col].get("pvalue", None) if src in ["tests", "all"] else None
            row_items.append(format_sig_cell(src, col, all_m, all_sd, all_ctl_m, all_p_val, dec, base_tool="docs"))

            line_str = " & ".join(row_items) + r" \\"
            source_lines.append(line_str)
            if src != sources[-1]:
                source_lines.append(r"    \hline")

    # Comment out the Behavior Source section as requested
    lines.append(r"    % ==========================================================================")
    lines.append(r"    % Expected Behavior Source Section (Commented out to fit page budget)")
    lines.append(r"    % ==========================================================================")
    for s_line in source_lines:
        lines.append(f"%{s_line}")

    lines.extend([
        r"    \bottomrule",
        r"    \multicolumn{13}{c}{Statistically significant differences against \controlnameU\ marked as: $\ast$ ($p\!<\!0.05$), $\ast\ast$ ($p\!<\!0.01$).} \\",
        r"    \multicolumn{13}{c}{Light green=statistically significant improvement; light red=statistically significant worsening.} \\",
        r"    \multicolumn{13}{c}{Measure 1: Mann--Whitney $U$ test; Measure 2: two-tailed $t$-test; Measure 3: two-tailed Fisher's exact test.} \\",
        r"  \end{tabularx}",
        r"\end{table*}",
    ])

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Table 5.4: {out_path}")


def generate_results_detail_table(df: pd.DataFrame, out_path: str, stats: dict):
    tools = ["hypothesis", "hypofuzz", "nanofuzz"]
    sources = ["docs", "tests", "all"]

    # Measure 1: Branch Coverage
    def cov_stats(sub):
        vals = sub["BranchCoveragePct"].dropna().values.astype(float) if not sub.empty else []
        return {
            "max": f"{np.max(vals):.1f}\\%" if len(vals) > 0 else "0.0\\%",
            "mean": f"{np.mean(vals):.1f}\\%" if len(vals) > 0 else "0.0\\%",
            "min": f"{np.min(vals):.1f}\\%" if len(vals) > 0 else "0.0\\%",
            "n": len(vals)
        }

    m6_t = [cov_stats(df[df["Tool"].str.lower() == t]) for t in tools]
    m6_s = [cov_stats(df[df["InvariantSource"].str.lower() == s]) for s in sources]

    m6_max_cells = ["    Max Cov  "] + [x["max"] for x in m6_t] + [x["max"] for x in m6_s]
    m6_mean_cells = ["    Mean Cov "] + [x["mean"] for x in m6_t] + [x["mean"] for x in m6_s]
    m6_min_cells = ["    Min Cov  "] + [x["min"] for x in m6_t] + [x["min"] for x in m6_s]
    m6_tasks_cells = ["    Total Tasks"] + [str(x["n"]) for x in m6_t] + [str(x["n"]) for x in m6_s]

    # Measure 2: Task Time
    def format_min_sec(seconds: float | int) -> str:
        total_sec = int(round(seconds))
        m = total_sec // 60
        s = total_sec % 60
        return f"{m:02d}m {s:02d}s"

    def time_stats(sub):
        vals = sub["ElapsedSec"].dropna().values.astype(float) if not sub.empty else []
        return {
            "max": format_min_sec(np.max(vals)) if len(vals) > 0 else "00m 00s",
            "mean": format_min_sec(np.mean(vals)) if len(vals) > 0 else "00m 00s",
            "min": format_min_sec(np.min(vals)) if len(vals) > 0 else "00m 00s",
            "n": len(vals)
        }

    m3_t = [time_stats(df[df["Tool"].str.lower() == t]) for t in tools]
    m3_s = [time_stats(df[df["InvariantSource"].str.lower() == s]) for s in sources]

    m3_max_cells = ["    Max Time "] + [x["max"] for x in m3_t] + [x["max"] for x in m3_s]
    m3_mean_cells = ["    Mean Time"] + [x["mean"] for x in m3_t] + [x["mean"] for x in m3_s]
    m3_min_cells = ["    Min Time "] + [x["min"] for x in m3_t] + [x["min"] for x in m3_s]
    m3_tasks_cells = ["    Total Tasks"] + [str(x["n"]) for x in m3_t] + [str(x["n"]) for x in m3_s]

    # Measure 3: Bugs Elicited
    m1_el_t = [int(round(stats[t]["All"]["BugsElicited"]["sum"])) for t in tools]
    m1_tot_t = [int(round(stats[t]["All"]["TaskBugCount"]["sum"])) for t in tools]
    m1_not_t = [m1_tot_t[i] - m1_el_t[i] for i in range(len(tools))]

    m1_el_s = [int(df[df["InvariantSource"].str.lower() == s]["BugsElicited"].astype(int).sum()) for s in sources]
    m1_tot_s = [int(df[df["InvariantSource"].str.lower() == s]["TaskBugCount"].astype(int).sum()) for s in sources]
    m1_not_s = [m1_tot_s[i] - m1_el_s[i] for i in range(len(sources))]

    col_spec = "r | c | c | c || c | c | c"
    header_top = r"    & \multicolumn{3}{c||}{\textbf{Treatment}} & \multicolumn{3}{c}{\textbf{Expected Behavior Source}} \\"
    header_sub = r"    & \textbf{\controlnameshort} & \textbf{\hypofuzznameshort} & \textbf{\toolnameshort} & \textbf{Docs} & \textbf{Tests} & \textbf{Both} \\"

    m1_el_cells = ["    Bugs Elicited    "] + [str(x) for x in m1_el_t] + [str(x) for x in m1_el_s]
    m1_not_cells = ["    Bugs Not Elicited"] + [str(x) for x in m1_not_t] + [str(x) for x in m1_not_s]
    m1_tot_cells = ["    $\\Sigma$         "] + [str(x) for x in m1_tot_t] + [str(x) for x in m1_tot_s]

    lines = [
        r"\begin{table*}[t]",
        r"  \centering",
        r"  \small",
        r"  \providecommand{\controlnameshort}{Hypt}",
        r"  \renewcommand{\controlnameshort}{Hypt}",
        r"  \caption[Quantitative Task Results for Measures 1--3 by Treatment and Expected Behavior Source]{Quantitative Task Results for Measures 1--3 by Treatment and Expected Behavior Source. \controlnameshort=\controlnameU, \hypofuzznameshort=\hypofuzzname, \toolnameshort=\toolname.}",
        r"  \label{quarton:tab:results-detail}",
        r"  ",
        r"  \begin{tabular}[t]{" + col_spec + r"}",
        r"    \toprule",
        header_top,
        header_sub,
        r"    \midrule",
        r"    \multicolumn{7}{c}{\textbf{Measure 1: Branch Coverage}} \\",
        r"    \midrule",
        " & ".join(m6_max_cells) + r" \\",
        r"    \hline",
        " & ".join(m6_mean_cells) + r" \\",
        r"    \hline",
        " & ".join(m6_min_cells) + r" \\",
        r"    \hline",
        " & ".join(m6_tasks_cells) + r" \\",
        r"    \midrule",
        r"    \midrule",
        r"    \multicolumn{7}{c}{\textbf{Measure 2: Task Time}} \\",
        r"    \midrule",
        " & ".join(m3_max_cells) + r" \\",
        r"    \hline",
        " & ".join(m3_mean_cells) + r" \\",
        r"    \hline",
        " & ".join(m3_min_cells) + r" \\",
        r"    \hline",
        " & ".join(m3_tasks_cells) + r" \\",
        r"    \midrule",
        r"    \midrule",
        r"    \multicolumn{7}{c}{\textbf{Measure 3: Bugs Elicited}} \\",
        r"    \midrule",
        " & ".join(m1_el_cells) + r" \\",
        r"    \hline",
        " & ".join(m1_not_cells) + r" \\",
        r"    \hline",
        " & ".join(m1_tot_cells) + r" \\",
        r"    \bottomrule",
        r"  \end{tabular}",
        r"\end{table*}",
    ]

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Table 5.5: {out_path}")


def generate_ttest_table(df: pd.DataFrame, out_path: str, stats: dict):
    def t_stats(s1, s2):
        s1 = s1.dropna().values
        s2 = s2.dropna().values
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
        ("BranchCoveragePct", r"Measure 1: Branch Coverage", True),
        ("ElapsedSec", r"Measure 2: Task Time (s)", False),
        ("BugsElicited", r"Measure 3: Bugs Elicited", True),
    ]

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \small",
        r"  \definecolor{bettergreen}{RGB}{169,223,192}",
        r"  \definecolor{worsered}{RGB}{245,183,177}",
        r"  \caption{Statistical Significance of Treatment Effects for Measures 1--3 ($n=\qn$)}",
        r"  \label{quarton:tab:ttests}",
        r"  \begin{tabularx}{\textwidth}{>{\raggedright\arraybackslash}X | r l c r}",
        r"    \toprule",
        r"    \multicolumn{1}{c|}{\textbf{Measure}} & \multicolumn{1}{c}{\textbf{$\Delta$}} & \multicolumn{1}{c}{\textbf{Test}} & \multicolumn{1}{c}{\textbf{Statistic}} & \multicolumn{1}{c}{\textbf{$p$}} \\",
    ]

    tools_to_compare = [
        ("nanofuzz", r"\textbf{\toolname\ vs.\ \controlnameU}"),
        ("hypofuzz", r"\textbf{\hypofuzzname\ vs.\ \controlnameU}")
    ]

    for tool_key, header in tools_to_compare:
        lines.extend([
            r"    \midrule",
            f"    \\multicolumn{{5}}{{c}}{{{header}}} \\\\",
            r"    \midrule",
        ])

        for col, name, higher_is_better in measures:
            if col == "BranchCoveragePct":
                s_tool = df[df["Tool"].str.lower() == tool_key][col].dropna().values
                s_ctl = df[df["Tool"].str.lower() == "hypothesis"][col].dropna().values
                p_val, u_stat = compute_mann_whitney(s_tool, s_ctl)
                m1, m2 = float(np.mean(s_tool)), float(np.mean(s_ctl))
                delta_pct = (m1 / m2 - 1.0) * 100.0 if m2 != 0 else 0.0
                sign = "+" if delta_pct >= 0 else ""
                delta_str = f"{sign}{delta_pct:.1f}\\%"
                test_str = "Mann--Whitney $U$"
                stat_str = f"$U = {u_stat:.0f}$"
                p_str = f"{p_val:.4f}" if p_val >= 0.0001 else "$<$0.0001"
                star = star_alignment(p_val)
                is_sig = p_val < 0.05
                is_better = delta_pct > 0
                color = "bettergreen" if is_better else "worsered"
            elif col == "BugsElicited":
                el_tool = int(df[df["Tool"].str.lower() == tool_key]["BugsElicited"].sum())
                el_ctl = int(df[df["Tool"].str.lower() == "hypothesis"]["BugsElicited"].sum())
                tot_tool = int(df[df["Tool"].str.lower() == tool_key]["TaskBugCount"].sum())
                tot_ctl = int(df[df["Tool"].str.lower() == "hypothesis"]["TaskBugCount"].sum())
                p_val = compute_fisher_exact(el_tool, tot_tool, el_ctl, tot_ctl)
                delta_pct = (el_tool / el_ctl - 1.0) * 100.0 if el_ctl != 0 else 0.0
                sign = "+" if delta_pct >= 0 else ""
                delta_str = f"{sign}{delta_pct:.1f}\\%"
                test_str = "Fisher's exact"
                fish_table = [[el_tool, max(0, tot_tool - el_tool)], [el_ctl, max(0, tot_ctl - el_ctl)]]
                odds_ratio = float(st.fisher_exact(fish_table).statistic)
                stat_str = f"$\\text{{OR}} = {odds_ratio:.2f}$"
                p_str = f"{p_val:.4f}"
                star = star_alignment(p_val)
                is_sig = p_val < 0.05
                is_better = delta_pct > 0
                color = "bettergreen" if is_better else "worsered"
            else:
                s_tool = df[df["Tool"].str.lower() == tool_key][col]
                s_ctl = df[df["Tool"].str.lower() == "hypothesis"][col]
                r = t_stats(s_tool, s_ctl)

                is_sig = r["p"] < 0.05
                is_better = (r["m1"] > r["m2"]) if higher_is_better else (r["m1"] < r["m2"])
                color = "bettergreen" if is_better else "worsered"

                star = star_alignment(r["p"])
                sign = "+" if r["delta_pct"] >= 0 else ""
                delta_str = f"{sign}{r['delta_pct']:.1f}\\%"
                test_str = "Two-tailed $t$-test"
                stat_str = f"$t({r['df']:.1f}) = {r['t']:+.2f}$"
                p_str = f"{r['p']:.4f}" if r["p"] >= 0.0001 else "$<$0.0001"

            if is_sig:
                row = (
                    f"    {name} & "
                    f"\\cellcolor{{{color}}}{delta_str} & "
                    f"\\cellcolor{{{color}}}{test_str} & "
                    f"\\cellcolor{{{color}}}{stat_str} & "
                    f"\\cellcolor{{{color}}}{p_str}{star} \\\\"
                )
            else:
                row = (
                    f"    {name} & "
                    f"{delta_str} & "
                    f"{test_str} & "
                    f"{stat_str} & "
                    f"{p_str}{star} \\\\"
                )
            lines.append(row)

    lines.extend([
        r"    \bottomrule",
        r"    \multicolumn{5}{c}{Statistically significant differences are marked as: $\ast$ ($p\!<\!0.05$), $\ast\ast$ ($p\!<\!0.01$).} \\",
        r"  \end{tabularx}",
        r"\end{table*}",
    ])

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Table 5.6: {out_path}")


def generate_bugs_elicited_table(run_dir: str, out_path: str):
    rubric_path = os.path.join(os.path.dirname(__file__), "ground_truth_rubric.json")
    if not os.path.exists(rubric_path):
        return

    with open(rubric_path, "r", encoding="utf-8") as f:
        rubric = json.load(f)

    tasks_order = [
        ("TreeValue", r"\texttt{TreeValue}"),
        ("DerivationTree", r"\texttt{Derivation}"),
        ("parse", r"\texttt{parse}"),
        ("_distance_norm", r"\texttt{\_distance}"),
        ("make_def", r"\texttt{make\_def}"),
    ]

    telemetry_dir = os.path.join(run_dir, "telemetry")
    bug_hits = {}
    bug_detected = {}
    for task_key, _ in tasks_order:
        for bid in rubric["tasks"].get(task_key, {}).get("bugs", {}):
            bug_hits[bid] = {"hypothesis": 0, "hypofuzz": 0, "nanofuzz": 0}
            bug_detected[bid] = {"hypothesis": 0, "hypofuzz": 0, "nanofuzz": 0}

    import glob
    for fpath in glob.glob(os.path.join(telemetry_dir, "*.telemetry.json")):
        try:
            with open(fpath, "r", encoding="utf-8") as fp:
                tel = json.load(fp)
            tool = tel.get("engine", "").lower()
            for res in tel.get("evalResults", []):
                bid = res.get("bug", {}).get("id")
                if bid in bug_hits and tool in bug_hits[bid]:
                    bug_hits[bid][tool] += res.get("elicited", 0)
                    bug_detected[bid][tool] += res.get("detected", 0)
        except Exception:
            continue

    tools = [
        ("hypothesis", r"\textbf{\controlnameU}"),
        ("hypofuzz", r"\textbf{\hypofuzzname}"),
        ("nanofuzz", r"\textbf{\toolname}"),
    ]

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \small",
        r"  \definecolor{bettergreen}{RGB}{169,223,192}",
        r"  \definecolor{worsered}{RGB}{245,183,177}",
        r"  \caption{Bug Elicitations by Task Program and Treatment}",
        r"  \label{quarton:tab:bugs-elicited}",
        r"  \begin{tabular}{l l | c c c}",
        r"    \toprule",
        r"    \textbf{Task Program} & \multicolumn{1}{c|}{\textbf{Bug ID}} & \textbf{\controlnameU} & \textbf{\hypofuzzname} & \textbf{\toolname} \\",
    ]

    total_unique = {t[0]: 0 for t in tools}
    total_hits = {t[0]: 0 for t in tools}

    for task_key, task_label in tasks_order:
        task_bugs = rubric["tasks"].get(task_key, {}).get("bugs", {})
        lines.append(r"    \midrule")
        for b_idx, bid in enumerate(task_bugs.keys()):
            prog_cell = task_label if b_idx == 0 else ""
            bid_tex = f"\\texttt{{{bid.replace('_', r'\_')}}}"

            tool_cells = []
            for t_key, _ in tools:
                hits = bug_hits[bid][t_key]
                total_hits[t_key] += hits
                if hits > 0:
                    total_unique[t_key] += 1
                    color = "bettergreen"
                else:
                    color = "worsered"
                cell_text = str(hits)
                tool_cells.append(f"\\cellcolor{{{color}}}{cell_text}")

            row_str = f"    {prog_cell} & {bid_tex} & " + " & ".join(tool_cells) + r" \\"
            lines.append(row_str)

    # Total elicitation opportunities per treatment across 9 replicates:
    # (3 + 6 + 6 + 6 + 3) * 9 = 24 * 9 = 216
    total_opps = sum(len(rubric["tasks"][t_key]["bugs"]) * 9 for t_key, _ in tasks_order)

    lines.extend([
        r"    \midrule",
        f"    \\multicolumn{{2}}{{l|}}{{\\textbf{{Total Bug Elicitations (out of {total_opps})}}}} & \\textbf{{{total_hits['hypothesis']}}} & \\textbf{{{total_hits['hypofuzz']}}} & \\textbf{{{total_hits['nanofuzz']}}} \\\\",
        r"    \hline",
        f"    \\multicolumn{{2}}{{l|}}{{\\textbf{{Unique Bugs Elicited (out of 24)}}}} & \\textbf{{{total_unique['hypothesis']}}} & \\textbf{{{total_unique['hypofuzz']}}} & \\textbf{{{total_unique['nanofuzz']}}} \\\\",
        r"    \bottomrule",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Bugs Elicited Table: {out_path}")


def generate_generator_table(run_dir: str, out_path: str):
    rubric_path = os.path.join(os.path.dirname(__file__), "ground_truth_rubric.json")
    if not os.path.exists(rubric_path):
        return

    with open(rubric_path, "r", encoding="utf-8") as f:
        rubric = json.load(f)

    tasks_order = [
        ("TreeValue", r"\texttt{TreeValue}"),
        ("DerivationTree", r"\texttt{Derivation}"),
        ("parse", r"\texttt{parse}"),
        ("_distance_norm", r"\texttt{\_distance}"),
        ("make_def", r"\texttt{make\_def}"),
    ]

    telemetry_dir = os.path.join(run_dir, "telemetry")
    artifacts_dir = os.path.join(run_dir, "artifacts")
    from collections import defaultdict
    # Track per-bug hits: eliciting counts and originating counts per generator type:
    # generator types: seed, random, custom, mutation, ai
    gen_keys = ["seed", "random", "custom", "mutation", "ai"]
    eliciting_counts = defaultdict(lambda: defaultdict(int))
    originating_counts = defaultdict(lambda: defaultdict(int))

    import glob

    # First check detailed elicited_bugs.json files if available
    elicitation_files = glob.glob(os.path.join(artifacts_dir, "*", "elicited_bugs.json"))
    processed_participants = set()

    for epath in elicitation_files:
        pid = os.path.basename(os.path.dirname(epath))
        tel_path = os.path.join(telemetry_dir, f"{pid}.telemetry.json")
        if not os.path.exists(tel_path):
            continue
        try:
            with open(tel_path, "r", encoding="utf-8") as tf:
                tel = json.load(tf)
            if tel.get("engine", "").lower() != "nanofuzz":
                continue

            processed_participants.add(pid)
            part_seen_el = set()
            part_seen_orig = set()

            with open(epath, "r", encoding="utf-8") as ef:
                for line in ef:
                    if not line.strip():
                        continue
                    d = json.loads(line)
                    bid = d.get("bug_id")
                    chain = d.get("generator", "")
                    if bid:
                        el_gen, orig_gen = parse_generator_chain(chain)
                        if (bid, el_gen) not in part_seen_el:
                            part_seen_el.add((bid, el_gen))
                            eliciting_counts[bid][el_gen] += 1
                        if (bid, orig_gen) not in part_seen_orig:
                            part_seen_orig.add((bid, orig_gen))
                            originating_counts[bid][orig_gen] += 1

        except Exception:
            continue

    lines = [
        r"\begin{table*}[!htbp]",
        r"  \centering",
        r"  \small",
        r"  \definecolor{bettergreen}{RGB}{169,223,192}",
        r"  \definecolor{worsered}{RGB}{245,183,177}",
        r"  \caption{Task Program Bugs by Eliciting and Originating Input Generator for \toolname}",
        r"  \label{quarton:tab:generators}",
        r"  \begin{tabular}{l | c c c c c}",
        r"    \toprule",
        r"    & \multicolumn{5}{c}{\textbf{Eliciting and (Originating) Input Generator}} \\",
        r"    \multicolumn{1}{c|}{\textbf{Bug ID}} & \textbf{Seed} & \textbf{Random} & \textbf{Custom} & \textbf{Mutation} & \textbf{AI} \\",
    ]

    for task_key, task_label in tasks_order:
        task_bugs = rubric["tasks"].get(task_key, {}).get("bugs", {})
        lines.append(r"    \midrule")
        lines.append(f"    \\multicolumn{{6}}{{c}}{{\\textbf{{{task_label}}}}} \\\\")
        lines.append(r"    \midrule")
        for b_idx, bid in enumerate(task_bugs.keys()):
            bid_tex = f"\\texttt{{{bid.replace('_', r'\_')}}}"

            cells = []
            for gtype in gen_keys:
                el_cnt = eliciting_counts[bid][gtype]
                orig_cnt = originating_counts[bid][gtype]
                color = "bettergreen" if (el_cnt > 0 or orig_cnt > 0) else "worsered"
                cell_text = f"{el_cnt} ({orig_cnt})"
                cells.append(f"\\cellcolor{{{color}}}{cell_text}")

            row_str = f"    {bid_tex} & " + " & ".join(cells) + r" \\"
            lines.append(row_str)

    lines.extend([
        r"    \bottomrule",
        r"    \multicolumn{6}{c}{\footnotesize The originating generator first produced an input that was later mutated into an eliciting input.} \\",
        r"    \multicolumn{6}{c}{\footnotesize The eliciting input generator produced the final bug-eliciting input.} \\",
        r"  \end{tabular}",
        r"\end{table*}",
    ])

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[TABLE] Generated Generator Elicitation Table: {out_path}")


def generate_provenance_listing(run_dir: str, out_path: str):
    """
    Finds the longest multi-step provenance chain elicited by NaNofuzz for a defect
    unelicited by the control baseline (Hypothesis), prioritizing chains starting from a Custom Generator.
    Formats it as a standalone LaTeX figure.
    """
    telemetry_dir = os.path.join(run_dir, "telemetry")
    artifacts_dir = os.path.join(run_dir, "artifacts")

    ctl_bugs = set()
    nanofuzz_bugs = set()
    import glob
    for fpath in glob.glob(os.path.join(telemetry_dir, "*.telemetry.json")):
        try:
            with open(fpath, "r", encoding="utf-8") as fp:
                tel = json.load(fp)
            tool = tel.get("engine", "").lower()
            for res in tel.get("evalResults", []):
                if res.get("elicited") == 1:
                    bid = res.get("bug", {}).get("id")
                    if bid:
                        if tool == "hypothesis":
                            ctl_bugs.add(bid)
                        elif tool == "nanofuzz":
                            nanofuzz_bugs.add(bid)
        except Exception:
            continue

    # Prioritize defects elicited by NaNofuzz that were unelicited by Hypothesis control (e.g. TV_RADD_STR, SIGMOID_OVERFLOW)
    target_bugs = nanofuzz_bugs - ctl_bugs
    if not target_bugs:
        target_bugs = nanofuzz_bugs

    candidates = []
    for p in glob.glob(os.path.join(artifacts_dir, "*", "elicited_bugs.json")):
        pid = os.path.basename(os.path.dirname(p))
        tel_f = os.path.join(telemetry_dir, f"{pid}.telemetry.json")
        if not os.path.exists(tel_f):
            continue
        try:
            with open(tel_f, "r", encoding="utf-8") as fp:
                tel = json.load(fp)
            if tel.get("engine", "").lower() != "nanofuzz":
                continue
            task = tel.get("task", "")

            with open(p, "r", encoding="utf-8") as fp:
                for idx, line in enumerate(fp):
                    if not line.strip():
                        continue
                    d = json.loads(line)
                    bid = d.get("bug_id")
                    if bid in target_bugs:
                        chain = d.get("generator", "")
                        if "->" in chain:
                            steps = len(chain.split("->"))
                            starts_with_custom = 1 if "CustomGen" in chain else 0
                            candidates.append({
                                "steps": steps,
                                "starts_with_custom": starts_with_custom,
                                "task": task,
                                "bug_id": bid,
                                "chain": chain,
                                "args": d.get("args", []),
                                "participant": pid,
                                "event_idx": idx,
                            })
        except Exception:
            continue

    if not candidates:
        return

    # Prefer chains starting with custom generators, then sorted by step count descending
    candidates.sort(key=lambda c: (c["starts_with_custom"], c["steps"]), reverse=True)
    best = candidates[0]

    chain_steps = best["chain"].split("->")
    origin_name = chain_steps[0]

    # Search for the original root input args produced by the originating generator in this participant run
    orig_args = None
    best_pid_log = os.path.join(artifacts_dir, best["participant"], "elicited_bugs.json")
    if os.path.exists(best_pid_log):
        with open(best_pid_log, "r", encoding="utf-8") as f:
            for line in f:
                d = json.loads(line)
                if d.get("generator") == origin_name:
                    orig_args = d.get("args")
                    break

    formatted_chain_lines = []
    for i, step in enumerate(chain_steps):
        if i == 0:
            orig_suffix = f" (input: {orig_args})" if orig_args else ""
            prefix = f"[Origin] {step}{orig_suffix}"
            formatted_chain_lines.append(prefix)
            continue

        prefix = f"  \\--> Step {i} "
        # Wrap long lines so they do not spill off the page margin
        line = f"{prefix}{step}"
        if len(line) > 75:
            # Wrap at comma if inside brackets
            if "," in line:
                idx = line.rfind(",", 0, 75)
                if idx != -1:
                    line = line[:idx+1] + "\n            " + line[idx+1:].lstrip()
        formatted_chain_lines.append(line)

    caption_text = (
        f"Multi-step input mutation lineage for \\texttt{{{best['bug_id'].replace('_', r'\_')}}}. "
        f"Treatment: \\toolname. "
        f"Agent ID: \\texttt{{{best['participant']}}}. "
        f"Task program: \\texttt{{{best['task']}}}. "
        f"Bug ID: \\texttt{{{best['bug_id'].replace('_', r'\_')}}} "
        r"(unelicited by \controlnameU)."
    )

    caption_short = f"Input Mutation Lineage for \\texttt{{{best['bug_id'].replace('_', r'\_')}}}"
    label_name = f"quarton:lst:provenance-{best['bug_id'].lower().replace('_', '-')}"

    lines = [
        r"\begin{figure}[!htbp]",
        r"\centering",
        r"\small",
        r"\begin{verbatim}",
        "\n".join(formatted_chain_lines),
        "",
        f"Eliciting Input Args: {best['args']}",
        r"\end{verbatim}",
        f"\\caption[{caption_short}]{{{caption_text}}}",
        f"\\label{{{label_name}}}",
        r"\end{figure}",
    ]

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[LISTING] Generated Longest Provenance Listing: {out_path}")


def generate_data_quarton_tex(df: pd.DataFrame, out_path: str, stats: dict):
    m1_ctl_m = stats["hypothesis"]["All"]["BugsElicited"]["mean"]
    m1_ctl_sd = stats["hypothesis"]["All"]["BugsElicited"]["sd"]
    m1_ctl_sum = stats["hypothesis"]["All"]["BugsElicited"]["sum"]
    m1_ctl_max = stats["hypothesis"]["All"]["TaskBugCount"]["sum"]

    m1_hypo_m = stats["hypofuzz"]["All"]["BugsElicited"]["mean"]
    m1_hypo_sd = stats["hypofuzz"]["All"]["BugsElicited"]["sd"]
    m1_hypo_sum = stats["hypofuzz"]["All"]["BugsElicited"]["sum"]
    m1_hypo_max = stats["hypofuzz"]["All"]["TaskBugCount"]["sum"]

    m1_int_m = stats["nanofuzz"]["All"]["BugsElicited"]["mean"]
    m1_int_sd = stats["nanofuzz"]["All"]["BugsElicited"]["sd"]
    m1_int_sum = stats["nanofuzz"]["All"]["BugsElicited"]["sum"]
    m1_int_max = stats["nanofuzz"]["All"]["TaskBugCount"]["sum"]

    # Bugs Detected (Raw Counts)
    det_ctl_m = stats["hypothesis"]["All"]["BugsDetected"]["mean"]
    det_ctl_sd = stats["hypothesis"]["All"]["BugsDetected"]["sd"]
    det_ctl_sum = stats["hypothesis"]["All"]["BugsDetected"]["sum"]

    det_hypo_m = stats["hypofuzz"]["All"]["BugsDetected"]["mean"]
    det_hypo_sd = stats["hypofuzz"]["All"]["BugsDetected"]["sd"]
    det_hypo_sum = stats["hypofuzz"]["All"]["BugsDetected"]["sum"]

    det_int_m = stats["nanofuzz"]["All"]["BugsDetected"]["mean"]
    det_int_sd = stats["nanofuzz"]["All"]["BugsDetected"]["sd"]
    det_int_sum = stats["nanofuzz"]["All"]["BugsDetected"]["sum"]

    det_delta = (det_int_sum / det_ctl_sum - 1.0) if det_ctl_sum > 0 else 0.0

    p_det = compute_fisher_exact(int(det_int_sum), int(m1_int_max), int(det_ctl_sum), int(m1_ctl_max))
    p_hypo_det = compute_fisher_exact(int(det_hypo_sum), int(m1_hypo_max), int(det_ctl_sum), int(m1_ctl_max))

    num_invariants = len(df["InvariantSource"].dropna().str.lower().unique()) if not df.empty else 3
    num_treatments = len(df["Tool"].dropna().str.lower().unique()) if not df.empty else 3

    total_bugs_to_find = int(round(m1_ctl_max + m1_hypo_max + m1_int_max))

    rubric_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ground_truth_rubric.json")
    if not os.path.exists(rubric_file):
        raise FileNotFoundError(f"Missing required ground truth rubric file: {rubric_file}")

    import json
    with open(rubric_file, "r", encoding="utf-8") as rf:
        rdata = json.load(rf)
    tasks_dict = rdata.get("tasks", {})
    if not tasks_dict:
        raise ValueError(f"Rubric in {rubric_file} contains no tasks.")
    total_unique_bugs = sum(len(td.get("bugs", {})) for td in tasks_dict.values())
    num_puts = len(tasks_dict)
    avg_bugs_per_put = total_unique_bugs / float(num_puts)

    k_treevalue = len(tasks_dict["TreeValue"]["bugs"])
    k_derivation = len(tasks_dict["DerivationTree"]["bugs"])
    k_parse = len(tasks_dict["parse"]["bugs"])
    k_distance = len(tasks_dict["_distance_norm"]["bugs"])
    k_makedef = len(tasks_dict["make_def"]["bugs"])

    m1_delta = (m1_int_sum / m1_ctl_sum - 1.0) if m1_ctl_sum > 0 else 0.0

    # Measure 2 Accuracy
    m2_ctl_m = stats["hypothesis"]["All"]["Accuracy"]["mean"]
    m2_ctl_sd = stats["hypothesis"]["All"]["Accuracy"]["sd"]
    m2_ctl_sum = int(np.round(m2_ctl_m * m1_ctl_max)) if m1_ctl_max > 0 else 0

    m2_hypo_m = stats["hypofuzz"]["All"]["Accuracy"]["mean"]
    m2_hypo_sd = stats["hypofuzz"]["All"]["Accuracy"]["sd"]
    m2_hypo_sum = int(
        np.round(m2_hypo_m * stats["hypofuzz"]["All"]["TaskBugCount"]["sum"]))

    m2_int_m = stats["nanofuzz"]["All"]["Accuracy"]["mean"]
    m2_int_sd = stats["nanofuzz"]["All"]["Accuracy"]["sd"]
    m2_int_sum = int(np.round(m2_int_m * m1_int_max)) if m1_int_max > 0 else 0

    m2_delta = (m2_int_m / m2_ctl_m - 1.0) if m2_ctl_m > 0 else 0.0

    # Measure 3 Task Time
    m3_ctl_m = stats["hypothesis"]["All"]["ElapsedSec"]["mean"]
    m3_ctl_sd = stats["hypothesis"]["All"]["ElapsedSec"]["sd"]
    m3_ctl_sum = int(stats["hypothesis"]["All"]["ElapsedSec"]["sum"])

    m3_hypo_m = stats["hypofuzz"]["All"]["ElapsedSec"]["mean"]
    m3_hypo_sd = stats["hypofuzz"]["All"]["ElapsedSec"]["sd"]
    m3_hypo_sum = int(stats["hypofuzz"]["All"]["ElapsedSec"]["sum"])

    m3_int_m = stats["nanofuzz"]["All"]["ElapsedSec"]["mean"]
    m3_int_sd = stats["nanofuzz"]["All"]["ElapsedSec"]["sd"]
    m3_int_sum = int(stats["nanofuzz"]["All"]["ElapsedSec"]["sum"])

    m3_delta = (1.0 - m3_int_m / m3_ctl_m) if m3_ctl_m > 0 else 0.0

    # Measure 6 Peak Branch Coverage (%)
    m6_ctl_m = stats["hypothesis"]["All"]["BranchCoveragePct"]["mean"]
    m6_ctl_sd = stats["hypothesis"]["All"]["BranchCoveragePct"]["sd"]
    m6_hypo_m = stats["hypofuzz"]["All"]["BranchCoveragePct"]["mean"]
    m6_hypo_sd = stats["hypofuzz"]["All"]["BranchCoveragePct"]["sd"]
    m6_int_m = stats["nanofuzz"]["All"]["BranchCoveragePct"]["mean"]
    m6_int_sd = stats["nanofuzz"]["All"]["BranchCoveragePct"]["sd"]
    m6_delta = (m6_int_m / m6_ctl_m - 1.0) if m6_ctl_m > 0 else 0.0

    # Significance p-values (int vs ctl)
    p_m1 = compute_fisher_exact(int(m1_int_sum), int(m1_int_max), int(m1_ctl_sum), int(m1_ctl_max))

    vals_int_m2 = df[df["Tool"] == "nanofuzz"]["Accuracy"].dropna(
    ).values if not df.empty else []
    vals_ctl_m2 = df[df["Tool"] == "hypothesis"]["Accuracy"].dropna(
    ).values if not df.empty else []
    p_m2 = compute_ttest(vals_int_m2, vals_ctl_m2)

    vals_int_m3 = df[df["Tool"] == "nanofuzz"]["ElapsedSec"].dropna(
    ).values if not df.empty else []
    vals_ctl_m3 = df[df["Tool"] == "hypothesis"]["ElapsedSec"].dropna(
    ).values if not df.empty else []
    p_m3 = compute_ttest(vals_int_m3, vals_ctl_m3)

    vals_int_m6 = df[df["Tool"] == "nanofuzz"]["BranchCoveragePct"].dropna(
    ).values if not df.empty else []
    vals_ctl_m6 = df[df["Tool"] == "hypothesis"]["BranchCoveragePct"].dropna(
    ).values if not df.empty else []
    p_m6, _ = compute_mann_whitney(vals_int_m6, vals_ctl_m6)

    # Significance p-values (hypofuzz vs ctl)
    p_hypo_m1 = compute_fisher_exact(int(m1_hypo_sum), int(m1_hypo_max), int(m1_ctl_sum), int(m1_ctl_max))

    vals_hypo_m2 = df[df["Tool"] == "hypofuzz"]["Accuracy"].dropna(
    ).values if not df.empty else []
    p_hypo_m2 = compute_ttest(vals_hypo_m2, vals_ctl_m2)

    vals_hypo_m3 = df[df["Tool"] == "hypofuzz"]["ElapsedSec"].dropna(
    ).values if not df.empty else []
    p_hypo_m3 = compute_ttest(vals_hypo_m3, vals_ctl_m3)

    vals_hypo_m6 = df[df["Tool"] == "hypofuzz"]["BranchCoveragePct"].dropna(
    ).values if not df.empty else []
    p_hypo_m6, _ = compute_mann_whitney(vals_hypo_m6, vals_ctl_m6)

    # InvariantSource Comparison: "Both" (all) vs. "Docs" (across all tools)
    sub_both = df[df["InvariantSource"].str.lower() == "all"]
    sub_docs = df[df["InvariantSource"].str.lower() == "docs"]

    if not sub_both.empty and not sub_docs.empty:
        vals_both_m1 = sub_both["BugsElicited"].dropna().values
        vals_docs_m1 = sub_docs["BugsElicited"].dropna().values
        m1_both_sum = float(np.sum(vals_both_m1)) if len(vals_both_m1) > 0 else 0.0
        m1_docs_sum = float(np.sum(vals_docs_m1)) if len(vals_docs_m1) > 0 else 0.0
        m1_both_max = float(np.sum(sub_both["TaskBugCount"].dropna().values)) if len(sub_both) > 0 else 1.0
        m1_docs_max = float(np.sum(sub_docs["TaskBugCount"].dropna().values)) if len(sub_docs) > 0 else 1.0
        m1_both_m = float(np.mean(vals_both_m1)) if len(vals_both_m1) > 0 else 0.0
        m1_both_sd = float(np.std(vals_both_m1)) if len(vals_both_m1) > 0 else 0.0
        m1_docs_m = float(np.mean(vals_docs_m1)) if len(vals_docs_m1) > 0 else 0.0
        m1_docs_sd = float(np.std(vals_docs_m1)) if len(vals_docs_m1) > 0 else 0.0
        m1_both_delta = (m1_both_sum / m1_docs_sum - 1.0) if m1_docs_sum > 0 else 0.0
        p_both_m1 = compute_fisher_exact(int(m1_both_sum), int(m1_both_max), int(m1_docs_sum), int(m1_docs_max))

        vals_both_m2 = sub_both["Accuracy"].dropna().values if "Accuracy" in sub_both.columns else []
        vals_docs_m2 = sub_docs["Accuracy"].dropna().values if "Accuracy" in sub_docs.columns else []
        if len(vals_both_m2) > 0 and len(vals_docs_m2) > 0:
            m2_both_m = float(np.mean(vals_both_m2))
            m2_both_sd = float(np.std(vals_both_m2))
            m2_docs_m = float(np.mean(vals_docs_m2))
            m2_docs_sd = float(np.std(vals_docs_m2))
            m2_both_delta = (m2_both_m / m2_docs_m - 1.0) if m2_docs_m > 0 else 0.0
            p_both_m2 = compute_ttest(vals_both_m2, vals_docs_m2)
        else:
            m2_both_m = 0.0
            m2_both_sd = 0.0
            m2_docs_m = 0.0
            m2_docs_sd = 0.0
            m2_both_delta = 0.0
            p_both_m2 = np.nan

        vals_both_m3 = sub_both["ElapsedSec"].dropna().values
        vals_docs_m3 = sub_docs["ElapsedSec"].dropna().values
        m3_both_m = float(np.mean(vals_both_m3)) if len(vals_both_m3) > 0 else 0.0
        m3_both_sd = float(np.std(vals_both_m3)) if len(vals_both_m3) > 0 else 0.0
        m3_docs_m = float(np.mean(vals_docs_m3)) if len(vals_docs_m3) > 0 else 0.0
        m3_docs_sd = float(np.std(vals_docs_m3)) if len(vals_docs_m3) > 0 else 0.0
        m3_both_delta = (1.0 - m3_both_m / m3_docs_m) if m3_docs_m > 0 else 0.0
        p_both_m3 = compute_ttest(vals_both_m3, vals_docs_m3)

        vals_both_m6 = sub_both["BranchCoveragePct"].dropna().values
        vals_docs_m6 = sub_docs["BranchCoveragePct"].dropna().values
        m6_both_m = float(np.mean(vals_both_m6)) if len(vals_both_m6) > 0 else 0.0
        m6_both_sd = float(np.std(vals_both_m6)) if len(vals_both_m6) > 0 else 0.0
        m6_docs_m = float(np.mean(vals_docs_m6)) if len(vals_docs_m6) > 0 else 0.0
        m6_docs_sd = float(np.std(vals_docs_m6)) if len(vals_docs_m6) > 0 else 0.0
        m6_both_delta = (m6_both_m / m6_docs_m - 1.0) if m6_docs_m > 0 else 0.0
        p_both_m6, _ = compute_mann_whitney(vals_both_m6, vals_docs_m6)

        vals_both_det = sub_both["BugsDetected"].dropna().values
        vals_docs_det = sub_docs["BugsDetected"].dropna().values
        det_both_sum = float(np.sum(vals_both_det)) if len(vals_both_det) > 0 else 0.0
        det_docs_sum = float(np.sum(vals_docs_det)) if len(vals_docs_det) > 0 else 0.0
        det_both_m = float(np.mean(vals_both_det)) if len(vals_both_det) > 0 else 0.0
        det_both_sd = float(np.std(vals_both_det)) if len(vals_both_det) > 0 else 0.0
        det_docs_m = float(np.mean(vals_docs_det)) if len(vals_docs_det) > 0 else 0.0
        det_docs_sd = float(np.std(vals_docs_det)) if len(vals_docs_det) > 0 else 0.0
        det_both_delta = (det_both_sum / det_docs_sum - 1.0) if det_docs_sum > 0 else 0.0
        p_both_det = compute_fisher_exact(int(det_both_sum), int(m1_both_max), int(det_docs_sum), int(m1_docs_max))
    else:
        m1_both_sum = m1_docs_sum = m1_both_max = m1_docs_max = 0.0
        m1_both_m = m1_both_sd = m1_docs_m = m1_docs_sd = m1_both_delta = 0.0
        p_both_m1 = np.nan
        m2_both_m = m2_both_sd = m2_docs_m = m2_docs_sd = m2_both_delta = 0.0
        p_both_m2 = np.nan
        m3_both_m = m3_both_sd = m3_docs_m = m3_docs_sd = m3_both_delta = 0.0
        p_both_m3 = np.nan
        m6_both_m = m6_both_sd = m6_docs_m = m6_docs_sd = m6_both_delta = 0.0
        p_both_m6 = np.nan
        det_both_sum = det_docs_sum = 0.0
        det_both_m = det_both_sd = det_docs_m = det_docs_sd = det_both_delta = 0.0
        p_both_det = np.nan

    # SUS
    sub_ctl_sus = df[df["Tool"].str.lower() == "hypothesis"]["SUS_Score"].dropna().values
    sub_hypo_sus = df[df["Tool"].str.lower() == "hypofuzz"]["SUS_Score"].dropna().values
    sub_int_sus = df[df["Tool"].str.lower() == "nanofuzz"]["SUS_Score"].dropna().values

    if len(sub_ctl_sus) == 0:
        raise ValueError("Missing SUS_Score data for Hypothesis.")
    if len(sub_hypo_sus) == 0:
        raise ValueError("Missing SUS_Score data for Hypofuzz.")
    if len(sub_int_sus) == 0:
        raise ValueError("Missing SUS_Score data for QuartoN/nanofuzz.")

    ctl_sus_m = float(np.mean(sub_ctl_sus))
    ctl_sus_sd = float(np.std(sub_ctl_sus))

    hypo_sus_m = float(np.mean(sub_hypo_sus))
    hypo_sus_sd = float(np.std(sub_hypo_sus))

    int_sus_m = float(np.mean(sub_int_sus))
    int_sus_sd = float(np.std(sub_int_sus))

    p_sus_int = compute_ttest(sub_int_sus, sub_ctl_sus)
    p_sus_hypo = compute_ttest(sub_hypo_sus, sub_ctl_sus)

    # Calculate condition-matched SUS comparisons (N=15 matched task-source cells)
    sus_pivot = df.pivot_table(
        index=["Task", "InvariantSource"],
        columns="Tool",
        values="SUS_Score"
    )
    for t in ["nanofuzz", "hypothesis", "hypofuzz"]:
        if t not in sus_pivot.columns:
            raise ValueError(f"Pivot table missing tool '{t}' in SUS_Score analysis.")

    diff_int_ctl = sus_pivot["nanofuzz"] - sus_pivot["hypothesis"]
    n_sus_favor_int = int((diff_int_ctl > 0).sum())
    n_sus_favor_ctl = int((diff_int_ctl < 0).sum())
    n_sus_favor_none = int((diff_int_ctl == 0).sum())

    diff_hypo_ctl = sus_pivot["hypofuzz"] - sus_pivot["hypothesis"]
    n_sus_favor_hypofuzz = int((diff_hypo_ctl > 0).sum())

    # Realism
    real_vals = df["Realistic"].dropna().astype(int).values
    if len(real_vals) == 0:
        raise ValueError("Missing Realistic survey data in dataset.")
    real_tot = len(real_vals)
    real_agree = int((real_vals >= 4).sum())
    real_pct = real_agree / real_tot

    # Task Confidence (TerzoN Question 2 Alignment)
    has_conf = "TaskConfidence" in df.columns and len(df["TaskConfidence"].dropna()) > 0
    if has_conf:
        conf_vals = df["TaskConfidence"].dropna().astype(int).values
        conf_tot = len(conf_vals)
        conf_agree = int((conf_vals >= 4).sum())
        conf_pct = conf_agree / conf_tot
        conf_m = float(np.mean(conf_vals))
        conf_sd = float(np.std(conf_vals, ddof=1)) if conf_tot > 1 else 0.0

        int_conf = df[df["Tool"].str.lower() == "nanofuzz"]["TaskConfidence"].dropna().astype(int).values
        ctl_conf = df[df["Tool"].str.lower() == "hypothesis"]["TaskConfidence"].dropna().astype(int).values
        hypo_conf = df[df["Tool"].str.lower() == "hypofuzz"]["TaskConfidence"].dropna().astype(int).values

        int_conf_m = float(np.mean(int_conf)) if len(int_conf) > 0 else 0.0
        ctl_conf_m = float(np.mean(ctl_conf)) if len(ctl_conf) > 0 else 0.0
        hypo_conf_m = float(np.mean(hypo_conf)) if len(hypo_conf) > 0 else 0.0

        if len(int_conf) > 1 and len(ctl_conf) > 1:
            _, p_conf_int = st.ttest_ind(int_conf, ctl_conf, equal_var=False)
        else:
            p_conf_int = np.nan

    # Timeouts
    to_ctl = int((df[df["Tool"].str.lower() == "hypothesis"]["ElapsedSec"] >= 300).sum())
    to_hypo = int((df[df["Tool"].str.lower() == "hypofuzz"]["ElapsedSec"] >= 300).sum())
    to_int = int((df[df["Tool"].str.lower() == "nanofuzz"]["ElapsedSec"] >= 300).sum())
    to_tot = to_ctl + to_hypo + to_int

    # Total experiment runtime calculations across participants
    tot_runtime_sec = float(df["ElapsedSec"].sum()) if "ElapsedSec" in df.columns else 0.0
    tot_runtime_hours = tot_runtime_sec / 3600.0
    tot_active_sec = float(df["ActiveExecutionSec"].sum()) if "ActiveExecutionSec" in df.columns else tot_runtime_sec
    tot_active_hours = tot_active_sec / 3600.0

    n_tot = len(df)

    m1_pct_str = format_delta_pct(abs(m1_delta))
    m1_word = "more" if m1_delta >= 0 else "fewer"
    m2_pct_str = format_delta_pct(abs(m2_delta))
    m2_word = "higher" if m2_delta >= 0 else "lower"
    m3_pct_str = format_delta_pct(abs(m3_delta))
    m3_word = "faster" if m3_delta >= 0 else "slower"
    m6_pct_str = format_delta_pct(abs(m6_delta))
    m6_word = "higher" if m6_delta >= 0 else "lower"

    # Build dynamic statistical summary reporting statistically significant measures first
    sig_measures = []
    nonsig_measures = []

    # Branch Coverage
    if p_m6 is not None and not np.isnan(p_m6) and p_m6 < 0.05:
        sig_measures.append(f"achieved {m6_pct_str} {m6_word} branch coverage ({pvalrange(p_m6)})")
    else:
        p_str = f" ({pvalrange(p_m6)})" if (p_m6 is not None and not np.isnan(p_m6)) else ""
        nonsig_measures.append(f"achieved numerically {m6_pct_str} {m6_word} branch coverage{p_str}")

    # Task Time
    if p_m3 is not None and not np.isnan(p_m3) and p_m3 < 0.05:
        sig_measures.append(f"completed tasks {m3_pct_str} {m3_word} ({pvalrange(p_m3)})")
    else:
        p_str = f" ({pvalrange(p_m3)})" if (p_m3 is not None and not np.isnan(p_m3)) else ""
        nonsig_measures.append(f"completed tasks numerically {m3_pct_str} {m3_word}{p_str}")

    # Bugs Elicited
    if p_m1 is not None and not np.isnan(p_m1) and p_m1 < 0.05:
        sig_measures.append(f"elicited {m1_pct_str} {m1_word} bugs ({pvalrange(p_m1)})")
    else:
        p_str = f" ({pvalrange(p_m1)})" if (p_m1 is not None and not np.isnan(p_m1)) else ""
        nonsig_measures.append(f"elicited numerically {m1_pct_str} {m1_word} bugs{p_str}")

    summary_sentences = []

    if sig_measures:
        if len(sig_measures) == 1:
            sig_text = sig_measures[0]
        elif len(sig_measures) == 2:
            sig_text = f"{sig_measures[0]} and {sig_measures[1]}"
        else:
            sig_text = f"{sig_measures[0]}, {sig_measures[1]}, and {sig_measures[2]}"
        summary_sentences.append(f"AI agents using \\toolname\\ {sig_text} than those using \\controlnameU.")

    if nonsig_measures:
        plural_clause = "these measures were" if len(nonsig_measures) > 1 else "this measure was"
        if len(nonsig_measures) == 1:
            nonsig_text = nonsig_measures[0]
        elif len(nonsig_measures) == 2:
            nonsig_text = f"{nonsig_measures[0]} and {nonsig_measures[1]}"
        else:
            nonsig_text = f"{nonsig_measures[0]}, {nonsig_measures[1]}, and {nonsig_measures[2]}"

        if sig_measures:
            summary_sentences.append(f"\\toolname\\ participants {nonsig_text} than participants using \\controlnameU, but {plural_clause} not statistically significant at \\qn\\ AI agents.")
        else:
            summary_sentences.append(f"AI agents using \\toolname\\ {nonsig_text} compared to \\controlnameU, but {plural_clause} not statistically significant at \\qn\\ AI agents.")

    statssummary_str = f"\\def\\quartonstatssummary{{{' '.join(summary_sentences)}}}"

    both_el_pct = f"{m1_both_sum / m1_both_max:.0%}".replace("%", "\\%") if m1_both_max > 0 else "0\\%"
    docs_el_pct = f"{m1_docs_sum / m1_docs_max:.0%}".replace("%", "\\%") if m1_docs_max > 0 else "0\\%"
    both_det_pct = f"{det_both_sum / m1_both_max:.0%}".replace("%", "\\%") if m1_both_max > 0 else "0\\%"
    docs_det_pct = f"{det_docs_sum / m1_docs_max:.0%}".replace("%", "\\%") if m1_docs_max > 0 else "0\\%"

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
        r"\def\qtoolversion{v0.4.2}",
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
        f"\\def\\qn{{{n_tot}}}",
        f"\\def\\qntaskprograms{{{num_puts}}}",
        f"\\def\\qninvariants{{{num_invariants}}}",
        f"\\def\\qntreatments{{{num_treatments}}}",
        f"\\def\\qtaskcombinations{{{num_treatments * num_puts}}}",
        f"\\def\\qrepetitions{{{int(df['Replicate'].max()) if 'Replicate' in df.columns and not df['Replicate'].dropna().empty else 3}}}",
        f"\\def\\qntotaltasks{{{n_tot}}}",
        f"\\def\\qntotalbugs{{{total_unique_bugs}}}",
        f"\\def\\qnavgbugsperput{{{avg_bugs_per_put:.1f}}}",
        f"\\def\\qnbugstreevalue{{{k_treevalue}}}",
        f"\\def\\qnbugsderivationtree{{{k_derivation}}}",
        f"\\def\\qnbugsparse{{{k_parse}}}",
        f"\\def\\qnbugsdistancenorm{{{k_distance}}}",
        f"\\def\\qnbugsmakedef{{{k_makedef}}}",
        f"\\def\\qnbugstofind{{{total_bugs_to_find}}}",
        r"",
        r"% Measure 1: Bugs Elicited (Raw Counts)",
        f"\\def\\ctlElicitedmax{{{int(round(m1_ctl_max))}}}",
        f"\\def\\ctlElicitedsum{{{int(round(m1_ctl_sum))}}}",
        f"\\def\\ctlElicitedmean{{{m1_ctl_m:.2f}}}",
        f"\\def\\ctlElicitedsd{{{m1_ctl_sd:.2f}}}",
        f"\\def\\ctlElicitedpercent{{{m1_ctl_sum / m1_ctl_max:.0%}}}".replace("%", "\\%"),
        f"\\def\\intElicitedmax{{{int(round(m1_int_max))}}}",
        f"\\def\\intElicitedsum{{{int(round(m1_int_sum))}}}",
        f"\\def\\intElicitedmean{{{m1_int_m:.2f}}}",
        f"\\def\\intElicitedsd{{{m1_int_sd:.2f}}}",
        f"\\def\\intElicitedpercent{{{m1_int_sum / m1_int_max:.0%}}}".replace("%", "\\%"),
        f"\\def\\hypofuzzElicitedsum{{{int(round(m1_hypo_sum))}}}",
        f"\\def\\hypofuzzElicitedmean{{{m1_hypo_m:.2f}}}",
        f"\\def\\hypofuzzElicitedsd{{{m1_hypo_sd:.2f}}}",
        f"\\def\\hypofuzzElicitedpercent{{{m1_hypo_sum / m1_hypo_max:.0%}}}".replace(
            "%", "\\%"),
        f"\\def\\intEliciteddeltapct{{{format_delta_pct(m1_delta)}}}",
        r"",
        r"% Bugs Detected (Raw Counts)",
        f"\\def\\ctlDetectedmax{{{int(round(m1_ctl_max))}}}",
        f"\\def\\ctlDetectedsum{{{int(round(det_ctl_sum))}}}",
        f"\\def\\ctlDetectedmean{{{det_ctl_m:.2f}}}",
        f"\\def\\ctlDetectedsd{{{det_ctl_sd:.2f}}}",
        (f"\\def\\ctlDetectedpercent{{{det_ctl_sum / m1_ctl_max:.0%}}}".replace("%", "\\%") if m1_ctl_max > 0 else "\\def\\ctlDetectedpercent{0\\%}"),
        f"\\def\\intDetectedmax{{{int(round(m1_int_max))}}}",
        f"\\def\\intDetectedsum{{{int(round(det_int_sum))}}}",
        f"\\def\\intDetectedmean{{{det_int_m:.2f}}}",
        f"\\def\\intDetectedsd{{{det_int_sd:.2f}}}",
        (f"\\def\\intDetectedpercent{{{det_int_sum / m1_int_max:.0%}}}".replace("%", "\\%") if m1_int_max > 0 else "\\def\\intDetectedpercent{0\\%}"),
        f"\\def\\hypofuzzDetectedsum{{{int(round(det_hypo_sum))}}}",
        f"\\def\\hypofuzzDetectedmean{{{det_hypo_m:.2f}}}",
        f"\\def\\hypofuzzDetectedsd{{{det_hypo_sd:.2f}}}",
        (f"\\def\\hypofuzzDetectedpercent{{{det_hypo_sum / m1_hypo_max:.0%}}}".replace("%", "\\%") if m1_hypo_max > 0 else "\\def\\hypofuzzDetectedpercent{0\\%}"),
        f"\\def\\intDetecteddeltapct{{{format_delta_pct(det_delta)}}}",
        r"",
        r"% Measure 2: Bug Description Accuracy (Normalized -0.5--1)",
        f"\\def\\ctlAccuracymax{{{int(round(m1_ctl_max))}}}",
        f"\\def\\ctlAccuracysum{{{m2_ctl_sum}}}",
        f"\\def\\ctlAccuracymean{{{m2_ctl_m:.2f}}}",
        f"\\def\\ctlAccuracysd{{{m2_ctl_sd:.2f}}}",
        f"\\def\\ctlAccuracypercent{{{m2_ctl_m:.0%}}}".replace("%", "\\%"),
        f"\\def\\intAccuracymax{{{int(round(m1_int_max))}}}",
        f"\\def\\intAccuracysum{{{m2_int_sum}}}",
        f"\\def\\intAccuracymean{{{m2_int_m:.2f}}}",
        f"\\def\\intAccuracysd{{{m2_int_sd:.2f}}}",
        f"\\def\\intAccuracypercent{{{m2_int_m:.0%}}}".replace("%", "\\%"),
        f"\\def\\hypofuzzAccuracysum{{{m2_hypo_sum}}}",
        f"\\def\\hypofuzzAccuracymean{{{m2_hypo_m:.2f}}}",
        f"\\def\\hypofuzzAccuracysd{{{m2_hypo_sd:.2f}}}",
        f"\\def\\hypofuzzAccuracypercent{{{m2_hypo_m:.0%}}}".replace(
            "%", "\\%"),
        f"\\def\\intAccuracydeltapct{{{format_delta_pct(m2_delta)}}}",
        r"",
        r"% Measure 3: Task Time (Seconds)",
        f"\\def\\ctlElapsedSecsum{{{m3_ctl_sum}}}",
        f"\\def\\ctlElapsedSecmean{{{m3_ctl_m:.0f}}}",
        f"\\def\\ctlElapsedSecsd{{{m3_ctl_sd:.0f}}}",
        f"\\def\\intElapsedSecsum{{{m3_int_sum}}}",
        f"\\def\\intElapsedSecmean{{{m3_int_m:.0f}}}",
        f"\\def\\intElapsedSecsd{{{m3_int_sd:.0f}}}",
        f"\\def\\hypofuzzElapsedSecsum{{{m3_hypo_sum}}}",
        f"\\def\\hypofuzzElapsedSecmean{{{m3_hypo_m:.0f}}}",
        f"\\def\\hypofuzzElapsedSecsd{{{m3_hypo_sd:.0f}}}",
        f"\\def\\intElapsedSecdeltapct{{{format_delta_pct(m3_delta)}}}",
        r"",
        r"% Total Experiment Runtime Macros",
        f"\\def\\qntotalruntimehours{{{tot_runtime_hours:.1f}}}",
        f"\\def\\qntotalruntimesec{{{tot_runtime_sec:.0f}}}",
        f"\\def\\qntotalactivehours{{{tot_active_hours:.1f}}}",
        r"",
        r"% Measure 6: Peak Branch Coverage (%)",
        f"\\def\\ctlCoveragemean{{{m6_ctl_m:.1f}}}",
        f"\\def\\ctlCoveragesd{{{m6_ctl_sd:.1f}}}",
        f"\\def\\ctlCoveragepct{{{m6_ctl_m:.1f}\\%}}",
        f"\\def\\intCoveragemean{{{m6_int_m:.1f}}}",
        f"\\def\\intCoveragesd{{{m6_int_sd:.1f}}}",
        f"\\def\\intCoveragepct{{{m6_int_m:.1f}\\%}}",
        f"\\def\\hypofuzzCoveragemean{{{m6_hypo_m:.1f}}}",
        f"\\def\\hypofuzzCoveragesd{{{m6_hypo_sd:.1f}}}",
        f"\\def\\hypofuzzCoveragepct{{{m6_hypo_m:.1f}\\%}}",
        f"\\def\\intCoveragedeltapct{{{format_delta_pct(m6_delta)}}}",
        r"",
        r"% Statistical Significance Tests: QuartoN vs. Hypothesis (Welch's t-test)",
        f"\\def\\pelicited{{{p_m1:.3f}}}",
        f"\\def\\pelicitedrange{{{pvalrange(p_m1)}}}",
        f"\\def\\pdetected{{{f'{p_det:.3f}' if (p_det is not None and not np.isnan(p_det)) else 'N/A'}}}",
        f"\\def\\pdetectedrange{{{pvalrange(p_det) if (p_det is not None and not np.isnan(p_det)) else 'N/A'}}}",
        f"\\def\\paccuracy{{{f'{p_m2:.3f}' if (p_m2 is not None and not np.isnan(p_m2)) else 'N/A'}}}",
        f"\\def\\paccuracyrange{{{pvalrange(p_m2)}}}",
        f"\\def\\ptime{{{p_m3:.3f}}}",
        f"\\def\\ptimerange{{{pvalrange(p_m3)}}}",
        f"\\def\\pCoverage{{{p_m6:.3f}}}",
        f"\\def\\pCoveragerange{{{pvalrange(p_m6)}}}",
        r"",
        r"% Statistical Significance Tests: Hypofuzz vs. Hypothesis (Welch's t-test)",
        f"\\def\\phypoelicited{{{p_hypo_m1:.3f}}}",
        f"\\def\\phypoelicitedrange{{{pvalrange(p_hypo_m1)}}}",
        f"\\def\\phypodetected{{{f'{p_hypo_det:.3f}' if (p_hypo_det is not None and not np.isnan(p_hypo_det)) else 'N/A'}}}",
        f"\\def\\phypodetectedrange{{{pvalrange(p_hypo_det) if (p_hypo_det is not None and not np.isnan(p_hypo_det)) else 'N/A'}}}",
        f"\\def\\phypoaccuracy{{{f'{p_hypo_m2:.3f}' if (p_hypo_m2 is not None and not np.isnan(p_hypo_m2)) else 'N/A'}}}",
        f"\\def\\phypoaccuracyrange{{{pvalrange(p_hypo_m2)}}}",
        f"\\def\\phypotime{{{p_hypo_m3:.3f}}}",
        f"\\def\\phypotimerange{{{pvalrange(p_hypo_m3)}}}",
        f"\\def\\phypoCoverage{{{p_hypo_m6:.3f}}}",
        f"\\def\\phypoCoveragerange{{{pvalrange(p_hypo_m6)}}}",
        r"",
        r"% =====================================================================",
        r"% Invariant Source Comparisons: Both Sources (all) vs. Documentation (docs)",
        r"% Main effect across all participant runs (N=30 each)",
        r"% =====================================================================",
        r"% Measure 1: Bugs Elicited (Both vs. Docs)",
        f"\\def\\bothElicitedmean{{{m1_both_m:.2f}}}",
        f"\\def\\bothElicitedsd{{{m1_both_sd:.2f}}}",
        f"\\def\\bothElicitedpercent{{{both_el_pct}}}",
        f"\\def\\docsElicitedmean{{{m1_docs_m:.2f}}}",
        f"\\def\\docsElicitedsd{{{m1_docs_sd:.2f}}}",
        f"\\def\\docsElicitedpercent{{{docs_el_pct}}}",
        f"\\def\\bothEliciteddeltapct{{{format_delta_pct(m1_both_delta)}}}",
        f"\\def\\pbothelicited{{{p_both_m1:.3f}}}",
        f"\\def\\pbothelicitedrange{{{pvalrange(p_both_m1)}}}",
        r"",
        r"% Bugs Detected (Both vs. Docs)",
        f"\\def\\bothDetectedmean{{{det_both_m:.2f}}}",
        f"\\def\\bothDetectedsd{{{det_both_sd:.2f}}}",
        f"\\def\\bothDetectedpercent{{{both_det_pct}}}",
        f"\\def\\docsDetectedmean{{{det_docs_m:.2f}}}",
        f"\\def\\docsDetectedsd{{{det_docs_sd:.2f}}}",
        f"\\def\\docsDetectedpercent{{{docs_det_pct}}}",
        f"\\def\\bothDetecteddeltapct{{{format_delta_pct(det_both_delta)}}}",
        f"\\def\\pbothdetected{{{f'{p_both_det:.3f}' if (p_both_det is not None and not np.isnan(p_both_det)) else 'N/A'}}}",
        f"\\def\\pbothdetectedrange{{{pvalrange(p_both_det) if (p_both_det is not None and not np.isnan(p_both_det)) else 'N/A'}}}",
        r"",
        r"% Measure 2: Bug Description Accuracy (Both vs. Docs)",
        f"\\def\\bothAccuracymean{{{m2_both_m:.2f}}}",
        f"\\def\\bothAccuracysd{{{m2_both_sd:.2f}}}",
        f"\\def\\bothAccuracypercent{{{m2_both_m:.0%}}}".replace("%", "\\%"),
        f"\\def\\docsAccuracymean{{{m2_docs_m:.2f}}}",
        f"\\def\\docsAccuracysd{{{m2_docs_sd:.2f}}}",
        f"\\def\\docsAccuracypercent{{{m2_docs_m:.0%}}}".replace("%", "\\%"),
        f"\\def\\bothAccuracydeltapct{{{format_delta_pct(m2_both_delta)}}}",
        f"\\def\\pbothaccuracy{{{f'{p_both_m2:.3f}' if (p_both_m2 is not None and not np.isnan(p_both_m2)) else 'N/A'}}}",
        f"\\def\\pbothaccuracyrange{{{pvalrange(p_both_m2)}}}",
        r"",
        r"% Measure 3: Task Time (Both vs. Docs)",
        f"\\def\\bothElapsedSecmean{{{m3_both_m:.0f}}}",
        f"\\def\\bothElapsedSecsd{{{m3_both_sd:.0f}}}",
        f"\\def\\docsElapsedSecmean{{{m3_docs_m:.0f}}}",
        f"\\def\\docsElapsedSecsd{{{m3_docs_sd:.0f}}}",
        f"\\def\\bothElapsedSecdeltapct{{{format_delta_pct(m3_both_delta)}}}",
        f"\\def\\pbothtime{{{p_both_m3:.3f}}}",
        f"\\def\\pbothtimerange{{{pvalrange(p_both_m3)}}}",
        r"",
        r"% Measure 6: Peak Branch Coverage (Both vs. Docs)",
        f"\\def\\bothCoveragemean{{{m6_both_m:.1f}}}",
        f"\\def\\bothCoveragesd{{{m6_both_sd:.1f}}}",
        f"\\def\\bothCoveragepct{{{m6_both_m:.1f}\\%}}",
        f"\\def\\docsCoveragemean{{{m6_docs_m:.1f}}}",
        f"\\def\\docsCoveragesd{{{m6_docs_sd:.1f}}}",
        f"\\def\\docsCoveragepct{{{m6_docs_m:.1f}\\%}}",
        f"\\def\\bothCoveragedeltapct{{{format_delta_pct(m6_both_delta)}}}",
        f"\\def\\pbothcoverage{{{p_both_m6:.3f}}}",
        f"\\def\\pbothcoveragerange{{{pvalrange(p_both_m6)}}}",
        r"",
        r"% Measure 4: System Usability Scale (SUS)",
        f"\\def\\ctlsusmean{{{ctl_sus_m:.2f}}}",
        f"\\def\\ctlsusstd{{{ctl_sus_sd:.2f}}}",
        f"\\def\\intsusmean{{{int_sus_m:.2f}}}",
        f"\\def\\intsusstd{{{int_sus_sd:.2f}}}",
        f"\\def\\hypofuzzsusmean{{{hypo_sus_m:.2f}}}",
        f"\\def\\hypofuzzsusstd{{{hypo_sus_sd:.2f}}}",
        f"\\def\\psus{{{p_sus_int:.3f}}}",
        f"\\def\\psusrange{{{pvalrange(p_sus_int)}}}",
        f"\\def\\phyposus{{{p_sus_hypo:.3f}}}",
        f"\\def\\phyposusrange{{{pvalrange(p_sus_hypo)}}}",
        f"\\def\\nsusfavorint{{{n_sus_favor_int}}}",
        f"\\def\\nsusfavorctl{{{n_sus_favor_ctl}}}",
        f"\\def\\nsusfavorhypofuzz{{{n_sus_favor_hypofuzz}}}",
        f"\\def\\nsusfavornone{{{n_sus_favor_none}}}",
        r"",
        r"% Measure 5: Task Realism",
        f"\\def\\nRealisticmax{{{real_tot}}}",
        f"\\def\\nRealisticsum{{{real_agree}}}",
        f"\\def\\nRealisticpercent{{{real_pct:.0%}}}".replace("%", "\\%"),
        r"",
        r"% Measure 5b: Participant Task Confidence (TerzoN Study Alignment)",
        *(
            [
                f"\\def\\nTaskConfidencemax{{{conf_tot}}}",
                f"\\def\\nTaskConfidencesum{{{conf_agree}}}",
                f"\\def\\nTaskConfidencepercent{{{conf_pct:.0%}}}".replace("%", "\\%"),
                f"\\def\\nTaskConfidencemean{{{conf_m:.2f}}}",
                f"\\def\\nTaskConfidencestd{{{conf_sd:.2f}}}",
                f"\\def\\intTaskConfidencemean{{{int_conf_m:.2f}}}",
                f"\\def\\ctlTaskConfidencemean{{{ctl_conf_m:.2f}}}",
                f"\\def\\hypofuzzTaskConfidencemean{{{hypo_conf_m:.2f}}}",
                f"\\def\\pTaskConfidence{{{p_conf_int:.3f}}}" if not np.isnan(p_conf_int) else "\\def\\pTaskConfidence{N/A}",
                f"\\def\\pTaskConfidencerange{{{pvalrange(p_conf_int)}}}" if not np.isnan(p_conf_int) else "\\def\\pTaskConfidencerange{N/A}",
            ]
            if has_conf
            else []
        ),
        r"",
        r"% Timeouts",
        f"\\def\\ctlTimeoutCount{{{to_ctl}}}",
        f"\\def\\intTimeoutCount{{{to_int}}}",
        f"\\def\\hypofuzzTimeoutCount{{{to_hypo}}}",
        f"\\def\\nTimeouts{{{to_tot}}}",
        r"",
        r"% High-level stats summary",
        statssummary_str,
        r"% -------------------END PAPER-SPECIFIC VARIABLES----------------",
    ]

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"[DATA] Regenerated LaTeX variables: {out_path}")


def analyze_dataset(df: pd.DataFrame) -> dict:
    stats = {}
    metric_cols = ["NormalizedScore", "Accuracy",
                   "ElapsedSec", "BranchCoveragePct", "BugsElicited", "BugsDetected", "TaskBugCount"]

    for tool in TREATMENTS:
        stats[tool] = {}
        tool_sub = df[df["Tool"].str.lower(
        ) == tool] if not df.empty else pd.DataFrame()
        for task in TASKS + ["All"]:
            sub = tool_sub if task == "All" else (
                tool_sub[tool_sub["Task"] == task] if not tool_sub.empty else pd.DataFrame())
            stats[tool][task] = {}
            for col in metric_cols:
                if not sub.empty and col in sub.columns:
                    vals = sub[col].dropna().values.astype(float)
                    m = float(np.mean(vals)) if len(vals) > 0 else 0.0
                    sd = float(np.std(vals)) if len(vals) > 0 else 0.0
                    s = float(np.sum(vals)) if len(vals) > 0 else 0.0
                else:
                    m, sd, s = 0.0, 0.0, 0.0
                stats[tool][task][col] = {"mean": m, "sd": sd, "sum": s}

    # Significance markers between tool vs control (Hypothesis)
    if not df.empty:
        for tool in ["hypofuzz", "nanofuzz"]:
            for task in TASKS + ["All"]:
                for col in ["NormalizedScore", "Accuracy", "ElapsedSec"]:
                    s_int = df[(df["Tool"].str.lower() == tool) & (df["Task"] == task)][col].dropna(
                    ).values if task != "All" else df[df["Tool"].str.lower() == tool][col].dropna().values
                    s_ctl = df[(df["Tool"].str.lower() == "hypothesis") & (df["Task"] == task)][col].dropna(
                    ).values if task != "All" else df[df["Tool"].str.lower() == "hypothesis"][col].dropna().values
                    p = compute_ttest(s_int, s_ctl)
                    stats[tool][task][col]["pvalue"] = p
                    stats[tool][task][col]["star"] = pvalstars(p)

                # Measure 1: BranchCoveragePct uses two-tailed Mann-Whitney U test
                s_int_cov = df[(df["Tool"].str.lower() == tool) & (df["Task"] == task)]["BranchCoveragePct"].dropna(
                ).values if task != "All" else df[df["Tool"].str.lower() == tool]["BranchCoveragePct"].dropna().values
                s_ctl_cov = df[(df["Tool"].str.lower() == "hypothesis") & (df["Task"] == task)]["BranchCoveragePct"].dropna(
                ).values if task != "All" else df[df["Tool"].str.lower() == "hypothesis"]["BranchCoveragePct"].dropna().values
                p_mw, u_stat = compute_mann_whitney(s_int_cov, s_ctl_cov)
                stats[tool][task]["BranchCoveragePct"]["pvalue"] = p_mw
                stats[tool][task]["BranchCoveragePct"]["star"] = pvalstars(p_mw)
                stats[tool][task]["BranchCoveragePct"]["u_stat"] = u_stat

                # Measure 3: BugsElicited uses two-tailed Fisher's exact test on raw counts
                el_tool = int(df[(df["Tool"].str.lower() == tool) & (df["Task"] == task)]["BugsElicited"].sum()) if task != "All" else int(df[df["Tool"].str.lower() == tool]["BugsElicited"].sum())
                tot_tool = int(df[(df["Tool"].str.lower() == tool) & (df["Task"] == task)]["TaskBugCount"].sum()) if task != "All" else int(df[df["Tool"].str.lower() == tool]["TaskBugCount"].sum())
                el_ctl = int(df[(df["Tool"].str.lower() == "hypothesis") & (df["Task"] == task)]["BugsElicited"].sum()) if task != "All" else int(df[df["Tool"].str.lower() == "hypothesis"]["BugsElicited"].sum())
                tot_ctl = int(df[(df["Tool"].str.lower() == "hypothesis") & (df["Task"] == task)]["TaskBugCount"].sum()) if task != "All" else int(df[df["Tool"].str.lower() == "hypothesis"]["TaskBugCount"].sum())
                p_fish = compute_fisher_exact(el_tool, tot_tool, el_ctl, tot_ctl)
                stats[tool][task]["BugsElicited"]["pvalue"] = p_fish
                stats[tool][task]["BugsElicited"]["star"] = pvalstars(p_fish)

                # BugsDetected uses two-tailed Fisher's exact test on raw counts
                det_tool = int(df[(df["Tool"].str.lower() == tool) & (df["Task"] == task)]["BugsDetected"].sum()) if task != "All" else int(df[df["Tool"].str.lower() == tool]["BugsDetected"].sum())
                tot_tool = int(df[(df["Tool"].str.lower() == tool) & (df["Task"] == task)]["TaskBugCount"].sum()) if task != "All" else int(df[df["Tool"].str.lower() == tool]["TaskBugCount"].sum())
                det_ctl = int(df[(df["Tool"].str.lower() == "hypothesis") & (df["Task"] == task)]["BugsDetected"].sum()) if task != "All" else int(df[df["Tool"].str.lower() == "hypothesis"]["BugsDetected"].sum())
                tot_ctl = int(df[(df["Tool"].str.lower() == "hypothesis") & (df["Task"] == task)]["TaskBugCount"].sum()) if task != "All" else int(df[df["Tool"].str.lower() == "hypothesis"]["TaskBugCount"].sum())
                p_fish_det = compute_fisher_exact(det_tool, tot_tool, det_ctl, tot_ctl)
                stats[tool][task]["BugsDetected"]["pvalue"] = p_fish_det
                stats[tool][task]["BugsDetected"]["star"] = pvalstars(p_fish_det)

    return stats


def main():
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    results_base = os.path.join(repo_root, "results")
    default_data = os.path.join(results_base, "data.csv")
    if not os.path.exists(default_data):
        run_dirs = sorted([
            os.path.join(results_base, d) for d in os.listdir(results_base)
            if os.path.isdir(os.path.join(results_base, d)) and d[0].isdigit()
        ])
        if run_dirs:
            candidate = os.path.join(run_dirs[-1], "results", "data.csv")
            if os.path.exists(candidate):
                default_data = candidate
            else:
                candidate2 = os.path.join(run_dirs[-1], "data.csv")
                if os.path.exists(candidate2):
                    default_data = candidate2

    parser = argparse.ArgumentParser(
        description="Analyze QuartoN experimental benchmark dataset")
    parser.add_argument(
        "--data", default=default_data, help="Path to data.csv")
    parser.add_argument("--survey", default=None,
                        help="Path to survey_responses.csv")
    parser.add_argument("--parts-dir", default=None,
                        help="Destination directory for LaTeX parts (defaults to results/parts in the run folder)")
    parser.add_argument("--dissertation-parts-dir", default=None,
                        help="Optional mirror destination for dissertation LaTeX parts")
    args = parser.parse_args()

    if not os.path.exists(args.data) or os.path.getsize(args.data) == 0:
        raise FileNotFoundError(f"Required benchmark dataset missing or empty: {args.data}")

    # Determine run results folder directly from data.csv path
    data_path = os.path.abspath(args.data)
    data_dir = os.path.dirname(data_path)
    if os.path.basename(data_dir) == "results":
        results_dir = data_dir
    else:
        results_dir = os.path.join(data_dir, "results")

    parts_dir = args.parts_dir or os.path.join(results_dir, "parts")
    os.makedirs(parts_dir, exist_ok=True)

    df = pd.read_csv(args.data)
    if df.empty:
        raise ValueError(f"Dataset in {args.data} contains 0 records.")

    # Validate required columns exist - NO FALLBACKS, NO FABRICATION
    required_cols = [
        "Participant", "Task", "Tool", "InvariantSource", "Replicate", "Sequence",
        "ElapsedSec", "TaskBugCount", "BugsElicited", "BugsDetected", "NormalizedScore", "Accuracy",
        "Realistic", "SUS_Score", "BranchCoveragePct", "TotalTestsExecuted"
    ]
    missing_cols = [c for c in required_cols if c not in df.columns]
    if missing_cols:
        raise KeyError(f"Dataset in {args.data} is missing required column(s): {missing_cols}")

    canonical_denominators = {}
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    target_cov_file = os.path.join(scripts_dir, "target_coverage_files.json")
    target_dir = os.path.realpath(os.path.join(scripts_dir, "..", "target"))
    if os.path.exists(target_cov_file) and os.path.exists(target_dir):
        try:
            import coverage
            cov_checker = coverage.Coverage(branch=True, data_file=None)
            cov_checker.start()
            cov_checker.stop()
            with open(target_cov_file, "r", encoding="utf-8") as f_cov:
                target_map = json.load(f_cov)
            for t_name, rel_paths in target_map.items():
                t_total = 0
                for rel_p in rel_paths:
                    full_p = os.path.join(target_dir, rel_p)
                    if os.path.exists(full_p):
                        analysis = cov_checker._analyze(full_p)
                        t_total += sum(t for t, _ in analysis.branch_stats().values())
                if t_total > 0:
                    canonical_denominators[t_name] = t_total
        except Exception as e:
            print(f"[WARN] Dynamic denominator resolution from target_coverage_files.json encountered: {e}")

    # Validate that reported branch totals match target definitions and percentages agree with ratios
    if "BranchesTotal" in df.columns and "BranchesCovered" in df.columns and "BranchCoveragePct" in df.columns:
        print("[CHECK] Validating branch coverage calculations and denominator consistency...")
        cov_math_errors = []
        for idx, row in df.iterrows():
            p_id = row.get("Participant", f"Row {idx}")
            t_name = row.get("Task")
            b_tot = row.get("BranchesTotal")
            b_cov = row.get("BranchesCovered")
            b_pct = row.get("BranchCoveragePct")

            if pd.notna(b_tot) and canonical_denominators.get(t_name) is not None:
                expected_denom = canonical_denominators[t_name]
                if int(b_tot) != expected_denom:
                    cov_math_errors.append(
                        f"[{p_id}] Task '{t_name}' has BranchesTotal={b_tot}, but target files require {expected_denom}."
                    )

            if pd.notna(b_tot) and pd.notna(b_cov) and pd.notna(b_pct):
                tot_val = float(b_tot)
                cov_val = float(b_cov)
                pct_val = float(b_pct)
                if tot_val > 0:
                    calc_pct = round((cov_val / tot_val) * 100.0, 1)
                    if abs(pct_val - calc_pct) > 0.15:
                        cov_math_errors.append(
                            f"[{p_id}] Math discrepancy: BranchCoveragePct={pct_val}%, but {cov_val}/{tot_val} = {calc_pct}%."
                        )

        if cov_math_errors:
            formatted_errors = "\n".join(cov_math_errors)
            raise ValueError(f"Coverage validation failed:\n{formatted_errors}")
        print("  ✓ Verified all branch coverage percentages strictly agree with covered/total ratios")

    # Validate required treatments exist
    tools_present = set(df["Tool"].str.lower().unique())
    required_tools = {"nanofuzz", "hypothesis", "hypofuzz"}
    missing_tools = required_tools - tools_present
    if missing_tools:
        print(f"[WARN] Dataset in {args.data} contains subset of tools: {tools_present}. Skipping multi-treatment dissertation analysis (missing: {missing_tools}).")
        return

    print(f"[DATA] Loaded {len(df)} participant records from {args.data}")

    stats = analyze_dataset(df)

    # Regenerate parts/data-quarton.tex in run folder
    data_tex_path = os.path.join(parts_dir, "data-quarton.tex")
    generate_data_quarton_tex(df, data_tex_path, stats)

    # Table 5.3: quarton:tab:participants
    tab_part_path = os.path.join(parts_dir, "tab-quarton-participants.tex")
    generate_participants_table(df, tab_part_path)

    # Table 5.4: quarton:tab:results
    tab_res_path = os.path.join(parts_dir, "tab-quarton-results.tex")
    generate_results_table(df, tab_res_path, stats)

    # Table 5.5: quarton:tab:results-detail
    tab_detail_path = os.path.join(parts_dir, "tab-quarton-results-detail.tex")
    generate_results_detail_table(df, tab_detail_path, stats)

    # Table 5.6: quarton:tab:ttests
    tab_ttest_path = os.path.join(parts_dir, "tab-quarton-ttests.tex")
    generate_ttest_table(df, tab_ttest_path, stats)

    # Bugs Elicited Breakdown Table: quarton:tab:bugs-elicited
    run_dir = os.path.dirname(results_dir)
    tab_bugs_path = os.path.join(parts_dir, "tab-quarton-bugs.tex")
    generate_bugs_elicited_table(run_dir, tab_bugs_path)

    # QuartoN Input Generator Table: quarton:tab:generators
    tab_gen_path = os.path.join(parts_dir, "tab-quarton-generators.tex")
    generate_generator_table(run_dir, tab_gen_path)

    # Provenance Lineage Listing for Bug Unique to NaNofuzz: quarton:lst:provenance-*
    lst_prov_path = os.path.join(parts_dir, "lst-quarton-provenance.tex")
    generate_provenance_listing(run_dir, lst_prov_path)

    # Figure 5.4: pyplots-quarton.pdf (in parts/)
    pdf_paths = [
        os.path.join(parts_dir, "pyplots-quarton.pdf"),
    ]
    generate_pyplots(df, pdf_paths)

    # Optional mirror to dissertation folder only if explicitly requested
    if args.dissertation_parts_dir:
        os.makedirs(args.dissertation_parts_dir, exist_ok=True)
        import shutil
        for fname in [
            "data-quarton.tex",
            "tab-quarton-participants.tex",
            "tab-quarton-results.tex",
            "tab-quarton-results-detail.tex",
            "tab-quarton-ttests.tex",
            "tab-quarton-bugs.tex",
            "tab-quarton-generators.tex",
            "lst-quarton-provenance.tex",
            "pyplots-quarton.pdf",
        ]:
            src_f = os.path.join(parts_dir, fname)
            if os.path.exists(src_f):
                shutil.copy2(src_f, os.path.join(args.dissertation_parts_dir, fname))
        print(f"[MIRROR] Mirrored generated parts to dissertation folder: {args.dissertation_parts_dir}")

    print(f"\n[SUCCESS] QuartoN analysis complete. Results written directly to: {results_dir}")


if __name__ == "__main__":
    main()
