#!/usr/bin/env python3
# type: ignore
"""
Shared statistical, formatting, and analysis utilities for empirical benchmarks.
Consumed by analyze_quarton.py and analyze_cig.py.
"""

import os
import sys
import glob

# Ensure target venv site-packages are in sys.path
_script_dir = os.path.dirname(os.path.abspath(__file__))
for _cand in [
    os.path.abspath(os.path.join(_script_dir, "..", "target", ".venv")),
    os.path.abspath(os.path.join(_script_dir, "..", "worktrees", "w1", ".venv")),
]:
    if os.path.exists(_cand):
        for _sp in glob.glob(os.path.join(_cand, "lib", "python*", "site-packages")):
            if _sp not in sys.path:
                sys.path.insert(0, _sp)

from typing import Tuple, List, Optional
import numpy as np
import scipy.stats as st


def pvalrange(p: float) -> str:
    """Formats a p-value into a LaTeX math string range."""
    if p is None or np.isnan(p):
        return r"$p\!>\!0.10$"
    if p < 0.001:
        return r"$p\!<\!0.001$"
    if p < 0.01:
        return r"$p\!<\!0.01$"
    if p < 0.05:
        return r"$p\!<\!0.05$"
    if p < 0.10:
        return r"$p\!<\!0.10$"
    return r"$p\!>\!0.10$"


def pvalstars(p: float) -> str:
    """Returns LaTeX significance stars for a p-value."""
    if p is None or np.isnan(p):
        return ""
    if p < 0.01:
        return r"$\ast\ast$"
    if p < 0.05:
        return r"$\ast$"
    return ""


def star_alignment(p: Optional[float]) -> str:
    """Returns phantom-spaced LaTeX significance stars for tabular alignment."""
    if p is not None and not np.isnan(p) and p < 0.01:
        return r"$^{\ast\ast}$"
    elif p is not None and not np.isnan(p) and p < 0.05:
        return r"$^{\ast}\phantom{^{\ast}}$"
    else:
        return r"\phantom{$^{\ast\ast}$}"


def format_delta_pct(val: float) -> str:
    """Formats a percentage delta with escaped LaTeX percent sign."""
    if val is None or np.isnan(val):
        return "0\\%"
    if abs(val) < 1e-6:
        val = 0.0
    return f"{val:.1%}".replace("%", "\\%")


def compute_ttest(sample_int, sample_ctl) -> float:
    """Computes Welch's t-test between two independent samples. Returns np.nan if uncomputable."""
    if len(sample_int) >= 2 and len(sample_ctl) >= 2:
        res = st.ttest_ind(sample_int, sample_ctl, equal_var=False)
        return float(res.pvalue)
    return float(np.nan)


def compute_fisher_exact(el1: int, tot1: int, el2: int, tot2: int) -> float:
    """Computes two-tailed Fisher's exact test on a 2x2 contingency table. Returns np.nan if uncomputable."""
    missed1 = int(tot1) - int(el1)
    missed2 = int(tot2) - int(el2)
    if missed1 < 0 or missed2 < 0 or int(tot1) <= 0 or int(tot2) <= 0:
        return float(np.nan)
    table = [[int(el1), missed1], [int(el2), missed2]]
    res = st.fisher_exact(table)
    return float(res.pvalue)


def compute_mann_whitney(sample_int, sample_ctl) -> Tuple[float, float]:
    """Computes two-sided Mann-Whitney U test between two samples. Returns (np.nan, np.nan) if uncomputable."""
    if len(sample_int) >= 2 and len(sample_ctl) >= 2:
        res = st.mannwhitneyu(sample_int, sample_ctl, alternative="two-sided")
        return float(res.pvalue), float(res.statistic)
    return float(np.nan), float(np.nan)


def format_sig_cell(tool: str, col: str, m_val: float, sd_val: float, ctl_m: float, p: Optional[float], dec: int, base_tool: str = "hypothesis") -> str:
    """Formats a LaTeX table cell with exact decimal alignment via dual makeboxes and conditional color highlighting."""
    if m_val is None or np.isnan(m_val):
        return r"\multicolumn{2}{c}{--}"

    higher_is_better = (col != "ElapsedSec")
    raw_m = f"{m_val:.{dec}f}" if dec > 0 else f"{m_val:.0f}"
    parts_m = raw_m.split(".") if "." in raw_m else (raw_m, "")
    int_m, dec_m = parts_m[0], parts_m[1]

    s = star_alignment(p if tool != base_tool else None)
    is_sig = not (tool == base_tool or p is None or np.isnan(p) or p >= 0.05 or np.isnan(ctl_m))
    is_better = (m_val > ctl_m) if higher_is_better else (m_val < ctl_m)

    if is_sig and is_better:
        int_m_str = f"\\textbf{{{int_m}}}"
        dec_m_str = f"\\textbf{{{dec_m}}}"
        color_m = r"\cellcolor{bettergreen}"
    elif is_sig and not is_better:
        int_m_str = int_m
        dec_m_str = dec_m
        color_m = r"\cellcolor{worsered}"
    else:
        int_m_str = int_m
        dec_m_str = dec_m
        color_m = ""

    # Box sizes: 1.8em fits up to 3 bold digits ('100'), 1.5em fits 1 digit + 2 stars ('0**')
    if dec > 0:
        cell_m = f"{color_m}\\makebox[1.8em][r]{{{int_m_str}}}.\\makebox[1.5em][l]{{{dec_m_str}{s}}}"
    else:
        cell_m = f"{color_m}\\makebox[1.8em][r]{{{int_m_str}}}\\makebox[1.5em][l]{{{s}}}"

    if sd_val is not None and not np.isnan(sd_val):
        raw_sd = f"{sd_val:.{dec}f}" if dec > 0 else f"{sd_val:.0f}"
        parts_sd = raw_sd.split(".") if "." in raw_sd else (raw_sd, "")
        int_sd, dec_sd = parts_sd[0], parts_sd[1]
        color_sd = color_m
        if dec > 0:
            cell_sd = f"{color_sd}\\makebox[1.4em][r]{{{int_sd}}}.\\makebox[0.9em][l]{{{dec_sd}}}"
        else:
            cell_sd = f"{color_sd}\\makebox[1.4em][r]{{{int_sd}}}"
    else:
        cell_sd = "--"

    return f"{cell_m} & {cell_sd}"


def parse_generator_chain(chain_str: str) -> Tuple[str, str]:
    """
    Parses a provenance chain (e.g. 'CustomGen[foo]->Mutation[bar]->Transformer[baz]').
    Returns (eliciting_generator, originating_generator).
    Transformer is treated as an intermediate filter/projection, not an input generator.
    """
    if not chain_str or chain_str == "None":
        return ("unknown", "unknown")

    steps = [s.strip() for s in chain_str.split("->")]
    non_trans = [s for s in steps if not s.startswith("Transformer")]
    if not non_trans:
        non_trans = steps

    def categorize_gen(s: str) -> str:
        if s.startswith("SeedInput") or "Seed" in s:
            return "seed"
        elif s.startswith("RandomInputGenerator") or "Random" in s:
            return "random"
        elif s.startswith("CustomGen") or s.startswith("UserInputGenerator") or "Custom" in s:
            return "custom"
        elif s.startswith("AI") or s.startswith("AiInputGenerator") or "Ai" in s:
            return "ai"
        elif s.startswith("Mutation") or "Mutat" in s:
            return "mutation"
        return "seed"

    originating = categorize_gen(non_trans[0])
    eliciting = categorize_gen(non_trans[-1])
    return (eliciting, originating)


def put_mathtt(task_name: str) -> str:
    """Escapes and formats a task/PUT name for LaTeX mathtt display."""
    safe_name = str(task_name).replace("_", r"\_")
    return f"$(\\mathbf{{\\mathtt{{{safe_name}}}}})$"
