import json
import os
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BENCHMARK_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
WORKSPACE_ROOT = os.path.abspath(os.path.join(BENCHMARK_DIR, ".."))
HARNESSES_DIR = SCRIPT_DIR
TARGET_DIR = os.path.join(BENCHMARK_DIR, "target")
TARGET_SRC = os.path.join(TARGET_DIR, "src")
RUNTIME_SRC = os.path.join(WORKSPACE_ROOT, "packages", "runtime", "python", "src")
SCRIPTS_DIR = os.path.join(BENCHMARK_DIR, "scripts")

for p in (TARGET_SRC, HARNESSES_DIR, SCRIPTS_DIR, RUNTIME_SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

import bug_interceptor

bug_interceptor.install_interceptors()

rubric_path = os.path.join(SCRIPTS_DIR, "ground_truth_rubric.json")
with open(rubric_path, "r", encoding="utf-8") as rf:
    RUBRIC = json.load(rf)

from nanofuzz_harness_make_def import fuzz_make_def
from nanofuzz_harness__distance_norm import fuzz__distance_norm
from nanofuzz_harness_TreeValue import fuzz_TreeValue
from nanofuzz_harness_DerivationTree import fuzz_DerivationTree
from nanofuzz_harness_parse import fuzz_parse


def _run_probe(task_name: str, fn, *args):
    with tempfile.NamedTemporaryFile(mode="w+", delete=False, suffix=".json") as tf:
        log_path = tf.name

    old_log = os.environ.get("NANOFUZZ_ELICITATION_LOG")
    os.environ["NANOFUZZ_ELICITATION_LOG"] = log_path
    bug_interceptor._INTERCEPTOR_LOG = log_path
    bug_interceptor._recorded_events.clear()

    res = None
    exc = None
    try:
        res = fn(*args)
    except Exception as e:
        exc = e
    finally:
        if old_log:
            os.environ["NANOFUZZ_ELICITATION_LOG"] = old_log
            bug_interceptor._INTERCEPTOR_LOG = old_log
        else:
            os.environ.pop("NANOFUZZ_ELICITATION_LOG", None)
            bug_interceptor._INTERCEPTOR_LOG = None

    task_rubric_bugs = set(RUBRIC.get("tasks", {}).get(task_name, {}).get("bugs", {}).keys())

    interceptor_bugs = set()
    if os.path.exists(log_path):
        with open(log_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    try:
                        d = json.loads(line)
                        if d.get("elicited") == 1:
                            bid = d.get("bug_id")
                            if bid in task_rubric_bugs:
                                interceptor_bugs.add(bid)
                    except Exception:
                        pass
        try:
            os.unlink(log_path)
        except OSError:
            pass

    harness_bugs = []
    if res and isinstance(res, tuple) and len(res) == 2 and isinstance(res[1], list):
        harness_bugs = [b for b in res[1] if b in task_rubric_bugs]

    return harness_bugs, exc, interceptor_bugs, res


def diff_check_make_def(symbol: str, chars: str, force_binary: bool) -> bool:
    """Differential property: interceptor and harness/validator must agree 100% on make_def."""
    h_bugs, exc, i_bugs, res = _run_probe("make_def", fuzz_make_def, symbol, chars, force_binary)
    assert set(h_bugs) == set(i_bugs), f"make_def discrepancy: harness={h_bugs} != interceptor={i_bugs}"
    return True


def diff_check_distance_norm(left: float, right: float) -> bool:
    """Differential property: interceptor and harness/validator must agree 100% on _distance_norm."""
    h_bugs, exc, i_bugs, res = _run_probe("_distance_norm", fuzz__distance_norm, left, right)
    assert set(h_bugs) == set(i_bugs), f"_distance_norm discrepancy: harness={h_bugs} != interceptor={i_bugs}"
    return True


def diff_check_tree_value(content_bits: int, string_val: str, encoding: str, mode: str) -> bool:
    """Differential property: interceptor and harness/validator must agree 100% on TreeValue."""
    h_bugs, exc, i_bugs, res = _run_probe("TreeValue", fuzz_TreeValue, content_bits, string_val, encoding, mode)
    assert set(h_bugs) == set(i_bugs), f"TreeValue discrepancy: harness={h_bugs} != interceptor={i_bugs}"
    return True


def diff_check_derivation_tree(child_text: str, index: int, slice_end: int, action: str, fmt: str) -> bool:
    """Differential property: interceptor and harness/validator must agree 100% on DerivationTree."""
    h_bugs, exc, i_bugs, res = _run_probe("DerivationTree", fuzz_DerivationTree, child_text, index, slice_end, action, fmt)
    assert set(h_bugs) == set(i_bugs), f"DerivationTree discrepancy: harness={h_bugs} != interceptor={i_bugs}"
    return True


def diff_check_parse(spec: str, constraint_str: str, use_stdlib: bool, check: bool, start_symbol: str) -> bool:
    """Differential property: interceptor and harness/validator must agree 100% on parse."""
    h_bugs, exc, i_bugs, res = _run_probe("parse", fuzz_parse, spec, constraint_str, use_stdlib, check, start_symbol)
    assert set(h_bugs) == set(i_bugs), f"parse discrepancy: harness={h_bugs} != interceptor={i_bugs}"
    return True
