#!/usr/bin/env pytest
"""
Unit test verifying proper defect attribution through both the Bug Interceptor
and the Harness/Validator cross-check sensor using the [put_input, bug_ids[]] pattern.
"""
import json
import os
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BENCHMARK_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
WORKSPACE_ROOT = os.path.abspath(os.path.join(BENCHMARK_DIR, ".."))
HARNESSES_DIR = os.path.join(BENCHMARK_DIR, "harnesses")
TARGET_DIR = os.path.join(BENCHMARK_DIR, "target")
TARGET_SRC = os.path.join(TARGET_DIR, "src")
RUNTIME_SRC = os.path.join(WORKSPACE_ROOT, "packages", "runtime", "python", "src")
SCRIPTS_DIR = os.path.join(BENCHMARK_DIR, "scripts")

for p in (TARGET_SRC, HARNESSES_DIR, SCRIPTS_DIR, RUNTIME_SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

import bug_interceptor  # noqa: E402

bug_interceptor.install_interceptors()

from nanofuzz_harness__distance_norm import (  # noqa: E402
    fuzz__distance_norm,
    fuzz__distance_norm_validator,
)
from nanofuzz_harness_DerivationTree import (  # noqa: E402
    fuzz_DerivationTree,
    fuzz_DerivationTree_validator,
)
from nanofuzz_harness_make_def import (  # noqa: E402
    fuzz_make_def,
    fuzz_make_def_validator,
)
from nanofuzz_harness_parse import fuzz_parse, fuzz_parse_validator  # noqa: E402
from nanofuzz_harness_TreeValue import (  # noqa: E402
    fuzz_TreeValue,
    fuzz_TreeValue_validator,
)


def run_with_interceptor_capture(task_name: str, fn, *args, **kwargs):
    """
    Executes a harness function while capturing interceptor events to a temp log file.
    Returns (put_input, harness_bug_ids, exception_raised, interceptor_bug_ids, full_result).
    """
    with tempfile.NamedTemporaryFile(mode="w+", delete=False, suffix=".json") as tf:
        log_path = tf.name

    old_log = os.environ.get("NANOFUZZ_ELICITATION_LOG")
    os.environ["NANOFUZZ_ELICITATION_LOG"] = log_path
    bug_interceptor._INTERCEPTOR_LOG = log_path
    bug_interceptor._recorded_events.clear()

    res = None
    exc = None
    try:
        res = fn(*args, **kwargs)
    except Exception as e:
        exc = e
    finally:
        if old_log:
            os.environ["NANOFUZZ_ELICITATION_LOG"] = old_log
            bug_interceptor._INTERCEPTOR_LOG = old_log
        else:
            os.environ.pop("NANOFUZZ_ELICITATION_LOG", None)
            bug_interceptor._INTERCEPTOR_LOG = None

    raw_events = []
    if os.path.exists(log_path):
        with open(log_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    raw_events.append(json.loads(line))
        os.unlink(log_path)

    # Filter events to those belonging to this task's rubric
    with open(os.path.join(SCRIPTS_DIR, "ground_truth_rubric.json")) as rf:
        rubric = json.load(rf)
    task_rubric_bugs = set(rubric.get("tasks", {}).get(task_name, {}).get("bugs", {}).keys())

    interceptor_bug_ids = [
        e["bug_id"] for e in raw_events
        if e.get("elicited") == 1 and e.get("bug_id") in task_rubric_bugs
    ]

    put_input = res[0] if (isinstance(res, (tuple, list)) and len(res) >= 1) else None
    harness_bug_ids = res[1] if (isinstance(res, (tuple, list)) and len(res) >= 2) else []

    return put_input, harness_bug_ids, exc, interceptor_bug_ids, res


class TestMakeDefAttribution:
    TASK = "make_def"

    def test_def_empty_rhs_attribution(self):
        # Empty string chars triggers DEF_EMPTY_RHS
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_make_def, "digit", "", False
        )
        assert put_inp == {"symbol": "digit", "chars": "", "force_binary": False}
        assert "DEF_EMPTY_RHS" in i_bugs, f"Interceptor missed DEF_EMPTY_RHS: {i_bugs}"
        assert "DEF_EMPTY_RHS" in h_bugs, f"Harness missed DEF_EMPTY_RHS: {h_bugs}"
        mock_result = {"output": [{"value": res}], "exception": exc is not None}
        assert fuzz_make_def_validator(mock_result) == "fail"

    def test_def_hex_overflow_attribution(self):
        # Euro sign '€' ord > 255 with force_binary triggers DEF_HEX_OVERFLOW
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_make_def, "euro", "€", True
        )
        assert "DEF_HEX_OVERFLOW" in i_bugs
        assert "DEF_HEX_OVERFLOW" in h_bugs
        mock_result = {"output": [{"value": res}], "exception": exc is not None}
        assert fuzz_make_def_validator(mock_result) == "fail"

    def test_make_def_safe_input(self):
        # Standard printable characters: 0 bugs elicited
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_make_def, "digit", "0123456789", False
        )
        assert exc is None
        assert len(i_bugs) == 0, f"Interceptor falsely triggered: {i_bugs}"
        assert len(h_bugs) == 0, f"Harness falsely triggered: {h_bugs}"
        mock_result = {"output": [{"value": res}], "exception": False}
        assert fuzz_make_def_validator(mock_result) == "pass"


class TestTreeValueAttribution:
    TASK = "TreeValue"

    def test_tv_eq_none_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_TreeValue, 0, "hello", "", "eq_none"
        )
        assert "TV_EQ_NONE" in i_bugs
        assert "TV_EQ_NONE" in h_bugs
        mock_result = {"output": [{"value": res}], "exception": exc is not None}
        assert fuzz_TreeValue_validator(mock_result) == "fail"

    def test_tv_radd_str_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_TreeValue, 0, "hello", "prefix", "radd"
        )
        assert "TV_RADD_STR" in i_bugs
        assert "TV_RADD_STR" in h_bugs
        mock_result = {"output": [{"value": res}], "exception": exc is not None}
        assert fuzz_TreeValue_validator(mock_result) == "fail"

    def test_tv_to_int_val_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_TreeValue, 0, "hello", "", "to_int"
        )
        assert "TV_TO_INT_VAL" in i_bugs
        assert "TV_TO_INT_VAL" in h_bugs

    def test_tv_encoding_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_TreeValue, 0, "hello", "invalid_codec_xyz", "encoding"
        )
        assert "TV_ENCODING" in i_bugs
        assert "TV_ENCODING" in h_bugs

    def test_tv_deepcopy_shared_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_TreeValue, 4, "0", "bits", "deepcopy"
        )
        assert "TV_DEEPCOPY_SHARED" in i_bugs
        assert "TV_DEEPCOPY_SHARED" in h_bugs

    def test_tv_hash_contract_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_TreeValue, 0, "1", "", "hash"
        )
        assert "TV_HASH_CONTRACT" in i_bugs
        assert "TV_HASH_CONTRACT" in h_bugs
        mock_result = {"output": [{"value": res}], "exception": exc is not None}
        assert fuzz_TreeValue_validator(mock_result) == "fail"

    def test_tv_safe_input(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_TreeValue, 0, "hello", " ", "methods"
        )
        assert exc is None
        assert len(i_bugs) == 0
        assert len(h_bugs) == 0
        mock_result = {"output": [{"value": res}], "exception": False}
        assert fuzz_TreeValue_validator(mock_result) == "pass"


class TestDerivationTreeAttribution:
    TASK = "DerivationTree"

    def test_dt_slice_parent_mut_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_DerivationTree, "leaf", 0, 1, "slice", "acyclic"
        )
        assert "DT_SLICE_PARENT_MUT" in i_bugs
        assert "DT_SLICE_PARENT_MUT" in h_bugs
        mock_result = {"output": [{"value": res}], "exception": exc is not None}
        assert fuzz_DerivationTree_validator(mock_result) == "fail"

    def test_dt_prefix_slice_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_DerivationTree, "leaf", 0, 1, "prefix", "acyclic"
        )
        assert "DT_PREFIX_SLICE" in i_bugs
        assert "DT_PREFIX_SLICE" in h_bugs

    def test_dt_repr_crash_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_DerivationTree, "leaf", 0, 1, "slice", "cyclic"
        )
        assert "DT_REPR_CRASH" in i_bugs
        assert "DT_REPR_CRASH" in h_bugs


class TestParseAttribution:
    TASK = "parse"

    def test_parse_empty_constraint_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_parse, "<start> ::= 'a'\n", "   ", False, False, "<start>"
        )
        assert "PARSE_EMPTY_CONSTRAINT" in i_bugs
        assert "PARSE_EMPTY_CONSTRAINT" in h_bugs
        mock_result = {"output": [{"value": res}], "exception": exc is not None}
        assert fuzz_parse_validator(mock_result) == "fail"

    def test_parse_empty_fan_files_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_parse, "__EMPTY_LIST__", "where <start> == 1", False, False, "<start>"
        )
        assert "PARSE_EMPTY_FAN_FILES" in i_bugs
        assert "PARSE_EMPTY_FAN_FILES" in h_bugs

    def test_parse_name_error_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_parse, "<start> ::= 'a'\n<undefined> ::= 'b'\n", "where <missing> == 1", False, True, "<start>"
        )
        assert "PARSE_NAME_ERROR" in i_bugs
        assert "PARSE_NAME_ERROR" in h_bugs

    def test_parse_safe_input(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz_parse, "<start> ::= 'a' | 'b'\n", "where len(<start>) > 0", False, False, "<start>"
        )
        assert exc is None
        assert len(i_bugs) == 0
        assert len(h_bugs) == 0
        mock_result = {"output": [{"value": res}], "exception": False}
        assert fuzz_parse_validator(mock_result) == "pass"


class TestDistanceNormAttribution:
    TASK = "_distance_norm"

    def test_sigmoid_overflow_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz__distance_norm, -1000.0, 1000.0
        )
        assert "SIGMOID_OVERFLOW" in i_bugs
        assert "SIGMOID_OVERFLOW" in h_bugs
        mock_result = {"output": [{"value": res}], "exception": exc is not None}
        assert fuzz__distance_norm_validator(mock_result) == "fail"

    def test_nan_propagate_attribution(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz__distance_norm, float("nan"), 0.0
        )
        assert "NORM_NAN_PROPAGATE" in i_bugs
        assert "NORM_NAN_PROPAGATE" in h_bugs
        mock_result = {"output": [{"value": res}], "exception": exc is not None}
        assert fuzz__distance_norm_validator(mock_result) == "fail"

    def test_distance_norm_safe_input(self):
        put_inp, h_bugs, exc, i_bugs, res = run_with_interceptor_capture(
            self.TASK, fuzz__distance_norm, 10.0, 20.0
        )
        assert exc is None
        assert len(i_bugs) == 0
        assert len(h_bugs) == 0
        mock_result = {"output": [{"value": res}], "exception": False}
        assert fuzz__distance_norm_validator(mock_result) == "pass"
