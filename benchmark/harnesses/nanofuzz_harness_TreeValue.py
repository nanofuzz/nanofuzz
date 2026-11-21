from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Literal

from nanofuzz_runtime import FuzzTestResult, UnsatisfiedAssumption, assume

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
    if kind == 0:
        tv = TreeValue(val)
    elif kind == 1:
        tv = TreeValue(val.encode("utf-8", errors="ignore"))
    elif kind == 2:
        tv = TreeValue(abs(hash(val)) % 2)
    elif kind == 3:
        tv = TreeValue.empty()
    elif kind == 4:
        # Sample variable-length bit streams (0 to 16 bits)
        bit_count = abs(hash(extra)) % 17
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

    # Option A: Composite/Nested tree values
    if left_val or right_val:
        left_child = TreeValue(left_val) if left_val else TreeValue.empty()
        right_child = TreeValue(right_val) if right_val else TreeValue.empty()
        # Exercise compound equality and representations
        _ = (tv == left_child)
        _ = (tv == right_child)
        _ = hash(left_child)
        _ = hash(right_child)

    # State-machine / Action dispatcher
    action_key = (action or "").lower().strip()

    if action_key in ("eq_none", "compare_none", "0"):
        # Contract TV_EQ_NONE: Comparing TreeValue with None must return False and not raise TypeError
        try:
            is_eq = (tv == None)
            is_ne = (tv != None)
            is_eq_rev = (None == tv)
            if is_eq is not False or is_ne is not True or is_eq_rev is not False:
                bug_ids.append("TV_EQ_NONE")
        except TypeError:
            bug_ids.append("TV_EQ_NONE")

    elif action_key in ("radd", "concat", "1"):
        # Contract TV_RADD_STR: Concatenation with string/bytes must succeed for compatible types
        try:
            if tv.is_type(TreeValueType.STRING):
                prefix_str = extra if extra else ""
                res_radd = prefix_str + tv
                res_add = tv + prefix_str
                if not isinstance(res_radd, str) or not isinstance(res_add, str):
                    bug_ids.append("TV_RADD_STR")
            elif tv.is_type(TreeValueType.BYTES):
                prefix_bytes = extra.encode("latin-1", errors="ignore")
                res_radd_b = prefix_bytes + tv
                res_add_b = tv + prefix_bytes
                if not isinstance(res_radd_b, bytes) or not isinstance(res_add_b, bytes):
                    bug_ids.append("TV_RADD_STR")
        except (ValueError, TypeError):
            bug_ids.append("TV_RADD_STR")

    elif action_key in ("to_int", "int", "2"):
        # Contract TV_TO_INT_VAL: to_int() must raise FandangoConversionError on non-numeric data, not unhandled ValueError
        try:
            res_int = tv.to_int()
        except FandangoConversionError:
            pass
        except ValueError:
            bug_ids.append("TV_TO_INT_VAL")

    elif action_key in ("encoding", "codec", "3"):
        # Contract TV_ENCODING: Invalid encoding must raise FandangoConversionError, not raw LookupError
        from fandango.language.tree_value import _str_to_bytes
        codec = extra if extra else "utf-8"
        try:
            _str_to_bytes(val if val else "hello", codec)
        except FandangoConversionError:
            pass
        except LookupError:
            bug_ids.append("TV_ENCODING")

    elif action_key in ("deepcopy", "copy", "4"):
        # Contract TV_DEEPCOPY_SHARED: Deepcopy must create independent mutable structures
        tv_copy = copy.deepcopy(tv)
        if hasattr(tv, "_trailing_bits") and hasattr(tv_copy, "_trailing_bits"):
            if tv_copy._trailing_bits is tv._trailing_bits:
                bug_ids.append("TV_DEEPCOPY_SHARED")

    elif action_key in ("hash", "5"):
        # Contract TV_HASH_CONTRACT: Hash contract consistency
        try:
            h = hash(tv)
            if tv == copy.deepcopy(tv) and h != hash(copy.deepcopy(tv)):
                bug_ids.append("TV_HASH_CONTRACT")
            if tv == val and h != hash(val):
                bug_ids.append("TV_HASH_CONTRACT")
        except FandangoConversionError:
            pass

    elif action_key in ("methods", "string_methods", "6"):
        # Direct string methods
        try:
            if tv.is_type(TreeValueType.STRING):
                sep = extra[:2] if extra else " "
                _ = tv.split(sep)
                _ = tv.partition(sep)
                _ = tv.lower()
                _ = tv.upper()
                _ = tv.title()
                _ = tv.startswith(extra[:5])
                _ = tv.endswith(extra[:5])
                _ = tv.find(extra[:3])
                _ = tv.count(extra[:1])
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

    elif action_key in ("arithmetic", "math", "7"):
        # Arithmetic operator methods and bitwise masks with offsets
        if tv.is_type(TreeValueType.TRAILING_BITS_ONLY) or (isinstance(val, str) and val.lstrip("-").isdigit()):
            num = int(val) if isinstance(
                val, str) and val.lstrip("-").isdigit() else 1
            _ = tv + num
            _ = tv - num
            _ = tv * num
            if num != 0:
                _ = tv // num
                _ = tv % num
            mask = abs(hash(extra)) & 0xFF
            _ = tv & mask
            _ = tv | mask
            _ = tv ^ mask

    elif action_key in ("conversions", "8"):
        # String, bytes, bits conversions and metadata
        try:
            _ = tv.to_string()
            _ = tv.to_bytes()
            _ = tv.to_bits()
            _ = tv.count_bytes()
        except FandangoConversionError:
            pass

    # In-place augmented operators
    elif action_key in ("inplace", "augmented"):
        if tv.is_type(TreeValueType.TRAILING_BITS_ONLY) or (isinstance(val, str) and val.lstrip("-").isdigit()):
            num = int(val) if isinstance(
                val, str) and val.lstrip("-").isdigit() else 1
            tv_mut = copy.deepcopy(tv)
            tv_mut += num
            tv_mut *= num

    # Option B: Expanded actions (bool, cmp_primitive, shift, format)
    elif action_key in ("bool", "boolean"):
        _ = bool(tv)

    elif action_key in ("cmp_primitive", "compare_primitive"):
        _ = (tv == val)
        _ = (tv == 42)
        _ = (tv == "foo")
        _ = (tv != 100)

    elif action_key in ("shift", "bit_shift"):
        try:
            _ = tv >> 1
            _ = tv << 1
        except Exception:
            pass

    elif action_key in ("format", "formatting"):
        _ = f"{tv}"
        _ = format(tv, "")

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
    output = r.get("output")
    if output and len(output) > 0:
        val = output[0].get("value") if isinstance(output[0], dict) else output[0]
        if isinstance(val, (list, tuple)) and len(val) >= 2:
            bug_ids = val[1]
            if bug_ids:
                return "fail"
    return "pass"
