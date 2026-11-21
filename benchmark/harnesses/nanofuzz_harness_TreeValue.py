from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Literal
from nanofuzz_runtime import FuzzTestResult
from fandango.errors import FandangoConversionError
from fandango.language.tree_value import TreeValue, TreeValueType


def fuzz_TreeValue(
    kind: int,
    val: str,
    extra: str,
    action: str,
    left_val: str = "",
    right_val: str = "",
) -> tuple[dict, list[str]]:
    bug_ids: list[str] = []
    put_input = {
        "kind": kind,
        "val": val,
        "extra": extra,
        "action": action,
        "left_val": left_val,
        "right_val": right_val,
    }

    # Construct TreeValue based on kind (heterogeneous types: str, bytes, int, empty, bits, float, bool, None)
    try:
        if kind == 0:
            tv = TreeValue(val)
        elif kind == 1:
            tv = TreeValue(val.encode("utf-8", errors="ignore"))
        elif kind == 2:
            tv = TreeValue(abs(hash(val)) % 2)
        elif kind == 3:
            tv = TreeValue.empty()
        elif kind == 4:
            # Sample variable-length bit streams (ensure >= 8 bits so trailing bits exist)
            bit_count = ((abs(hash(extra)) % 3) + 1) * 8
            bits = [(hash(extra) >> i) & 1 for i in range(bit_count)]
            tv = TreeValue(val, trailing_bits=bits)
        elif kind == 5:
            # Float value
            try:
                tv = TreeValue(float(val) if val and val.replace(
                    ".", "", 1).lstrip("-").isdigit() else 3.14)
            except Exception:
                tv = TreeValue(val)
        elif kind == 6:
            # Boolean value
            tv = TreeValue(val.lower() in ("true", "1", "yes"))
        elif kind == 7:
            # None value / null representation
            tv = TreeValue(None) if hasattr(
                TreeValue, "_allow_none") else TreeValue("")
        else:
            tv = TreeValue(val)
    except Exception:
        return (put_input, bug_ids)

    # Option A: Composite/Nested tree values
    if left_val or right_val:
        left_child = TreeValue(left_val) if left_val else TreeValue.empty()
        right_child = TreeValue(right_val) if right_val else TreeValue.empty()
        # Exercise compound equality and representations
        _ = (tv == left_child)
        _ = (tv == right_child)
        if left_val:
            try:
                if left_child == left_val and hash(left_child) != hash(left_val):
                    bug_ids.append("TV_HASH_CONTRACT")
            except Exception:
                pass
        if right_val:
            try:
                if right_child == right_val and hash(right_child) != hash(right_val):
                    bug_ids.append("TV_HASH_CONTRACT")
            except Exception:
                pass

    action_key = (action or "").lower().strip()

    if action_key in ("eq_none", "compare_none", "0"):
        # Contract TV_EQ_NONE: Comparing TreeValue with None must return False and not raise TypeError
        try:
            is_eq = tv == None  # noqa: E711
            is_ne = tv != None  # noqa: E711
            is_eq_rev = None == tv  # noqa: E711
            if is_eq is not False or is_ne is not True or is_eq_rev is not False:
                bug_ids.append("TV_EQ_NONE")
        except TypeError:
            bug_ids.append("TV_EQ_NONE")

    elif action_key in ("radd", "concat", "1"):
        # Contract TV_RADD_STR: Concatenation with string/bytes must succeed for compatible types
        val_obj = getattr(tv, "_value", None)
        if isinstance(val_obj, str):
            prefix_str = extra if extra else ""
            try:
                _ = prefix_str + tv
            except (ValueError, TypeError):
                bug_ids.append("TV_RADD_STR")
        elif isinstance(val_obj, bytes):
            prefix_bytes = extra.encode("latin-1", errors="ignore")
            try:
                _ = prefix_bytes + tv
            except (ValueError, TypeError):
                bug_ids.append("TV_RADD_STR")

    elif action_key in ("to_int", "int", "2"):
        # Contract TV_TO_INT_VAL: to_int() crashes on non-numeric data
        try:
            _ = tv.to_int()
        except (FandangoConversionError, ValueError):
            bug_ids.append("TV_TO_INT_VAL")

    elif action_key in ("encoding", "codec", "3"):
        # Contract TV_ENCODING: Invalid encoding must raise FandangoConversionError, not raw LookupError
        from fandango.language.tree_value import _str_to_bytes
        codec = extra if extra else "utf-8"
        try:
            _str_to_bytes(val if val else "hello", codec)
        except LookupError:
            bug_ids.append("TV_ENCODING")
        except FandangoConversionError:
            pass

    elif action_key in ("deepcopy", "copy", "4"):
        # Contract TV_DEEPCOPY_SHARED: Deepcopy must create independent mutable structures
        tv_copy = copy.deepcopy(tv)
        if hasattr(tv, "_trailing_bits") and hasattr(tv_copy, "_trailing_bits"):
            if tv._trailing_bits and len(tv._trailing_bits) > 0 and (tv_copy._trailing_bits is tv._trailing_bits):
                bug_ids.append("TV_DEEPCOPY_SHARED")

    elif action_key in ("hash", "5"):
        # Contract TV_HASH_CONTRACT: Hash contract consistency
        try:
            tb = getattr(tv, "_trailing_bits", None)
            if not tb:
                h = hash(tv)
                check_val = tv._value if getattr(tv, "_value", None) is not None else ""
                if isinstance(check_val, (int, str, bytes)) and tv == check_val and h != hash(check_val):
                    bug_ids.append("TV_HASH_CONTRACT")
        except FandangoConversionError:
            pass

    elif action_key in ("methods", "string_methods", "6"):
        try:
            if tv.is_type(TreeValueType.STRING):
                sep = extra[:2] if extra else " "
                _ = tv.split(sep)
                _ = tv.partition(sep)
                _ = tv.lower()
                _ = tv.upper()
                _ = tv.strip()
            elif tv.is_type(TreeValueType.BYTES):
                b_sep = extra.encode("latin-1", errors="ignore")[:2] or b" "
                _ = tv.split(b_sep)
                _ = tv.partition(b_sep)
                _ = tv.lower()
                _ = tv.upper()
                _ = tv.strip()
        except FandangoConversionError:
            pass

    return (put_input, bug_ids)


def fuzz_TreeValue_generator(
    prng: Callable[[], float],
) -> tuple[int, str, str, str, str, str] | None:
    kinds = [0, 1, 2, 3, 4, 5, 6, 7]
    actions = [
        "eq_none", "radd", "to_int", "encoding", "deepcopy", "hash",
        "methods", "arithmetic", "conversions", "bool", "cmp_primitive", "shift", "format", "inplace"
    ]
    samples = ["", "hello", "123", "abc", "💃", "foo",
               "bar", "prefix_", " \t\n", "xyz-123", "0.5", "True"]
    kind = kinds[int(prng() * len(kinds))]
    action = actions[int(prng() * len(actions))]
    val = samples[int(prng() * len(samples))]
    extra = samples[int(prng() * len(samples))]
    left_val = samples[int(prng() * len(samples))] if prng() < 0.3 else ""
    right_val = samples[int(prng() * len(samples))] if prng() < 0.3 else ""
    return (kind, val, extra, action, left_val, right_val)


def fuzz_TreeValue_validator(
    r: FuzzTestResult,
) -> Literal["pass", "fail", "unknown"]:
    if r.get("exception"):
        return "fail"
    out = r.get("out")
    if out is None and r.get("output"):
        out_list = r.get("output")
        if isinstance(out_list, list) and len(out_list) > 0:
            out = out_list[0].get("value") if isinstance(
                out_list[0], dict) else out_list[0]
    if out and isinstance(out, (list, tuple)) and len(out) >= 2:
        bug_ids = out[1]
        if bug_ids:
            return "fail"
    return "pass"
