from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Literal

from nanofuzz_runtime import FuzzTestResult, UnsatisfiedAssumption, assume

from fandango.errors import FandangoConversionError
from fandango.language.tree_value import TreeValue, TreeValueType


def fuzz_TreeValue(kind: int, val: str, op: int, extra: str) -> bool:
    # 1. Construct TreeValue based on kind
    if kind == 0:
        tv = TreeValue(val)
    elif kind == 1:
        tv = TreeValue(val.encode("utf-8", errors="ignore"))
    elif kind == 2:
        tv = TreeValue(abs(hash(val)) % 2)
    elif kind == 3:
        tv = TreeValue.empty()
    elif kind == 4:
        bit = abs(hash(extra)) % 2
        tv = TreeValue(val, trailing_bits=[bit])
    else:
        tv = TreeValue(val)

    # 2. Test operation/contract based on op selector
    if op == 0:
        # Contract TV_EQ_NONE: Comparing TreeValue with None must return False and not raise TypeError
        is_eq = (tv == None)
        assert is_eq is False, f"tv == None must be False, got {is_eq}"
        is_ne = (tv != None)
        assert is_ne is True, f"tv != None must be True, got {is_ne}"
        is_eq_rev = (None == tv)
        assert is_eq_rev is False, f"None == tv must be False, got {is_eq_rev}"

    elif op == 1:
        # Contract TV_RADD_STR: Concatenation with string/bytes must succeed for compatible types
        if tv.is_type(TreeValueType.STRING):
            res_radd = "" + tv
            assert isinstance(res_radd, str)
            res_add = tv + ""
            assert isinstance(res_add, str)
        elif tv.is_type(TreeValueType.BYTES):
            res_radd_b = b"" + tv
            assert isinstance(res_radd_b, bytes)
            res_add_b = tv + b""
            assert isinstance(res_add_b, bytes)

    elif op == 2:
        # Contract TV_TO_INT_VAL: to_int() must raise FandangoConversionError on non-numeric data, not unhandled ValueError
        try:
            res_int = tv.to_int()
            assert isinstance(res_int, int)
        except FandangoConversionError:
            pass
        except ValueError as e:
            raise AssertionError(
                f"to_int() raised raw ValueError instead of FandangoConversionError: {e}"
            ) from e

    elif op == 3:
        # Contract TV_ENCODING: Invalid encoding must raise FandangoConversionError, not raw LookupError
        from fandango.language.tree_value import _str_to_bytes
        codec = extra if extra else "utf-8"
        try:
            _str_to_bytes(val if val else "hello", codec)
        except FandangoConversionError:
            pass
        except LookupError as e:
            raise AssertionError(
                f"_str_to_bytes raised raw LookupError instead of FandangoConversionError: {e}"
            ) from e

    elif op == 4:
        # Contract TV_DEEPCOPY_SHARED: Deepcopy must create independent mutable structures
        tv_copy = copy.deepcopy(tv)
        if hasattr(tv, "_trailing_bits") and hasattr(tv_copy, "_trailing_bits"):
            assert (
                tv_copy._trailing_bits is not tv._trailing_bits
            ), "deepcopy shared the _trailing_bits list reference between original and copy"

    elif op == 5:
        # Contract TV_HASH_CONTRACT: Hash contract consistency
        h = hash(tv)
        assert isinstance(h, int)
        # Equality reflexivity
        assert tv == copy.deepcopy(tv), "A TreeValue must equal its deepcopy"
        assert hash(tv) == hash(copy.deepcopy(tv)), "A TreeValue must have same hash as its deepcopy"
        # If tv == other, their hashes must match
        if tv == val:
            assert hash(tv) == hash(val), f"Hash contract violation: tv == val but hash(tv)={hash(tv)} != hash(val)={hash(val)}"

    elif op == 6:
        # Direct methods
        if tv.is_type(TreeValueType.STRING):
            assert tv.startswith("")
            assert tv.endswith("")
        elif tv.is_type(TreeValueType.BYTES):
            assert tv.startswith(b"")
            assert tv.endswith(b"")

    return True


def fuzz_TreeValue_generator(
    prng: Callable[[], float],
) -> tuple[int, str, int, str] | None:
    kinds = [0, 1, 2, 3, 4]
    ops = [0, 1, 2, 3, 4, 5, 6]
    samples = ["", "hello", "123", "abc", "💃", "foo", "bar"]
    kind = kinds[int(prng() * len(kinds))]
    op = ops[int(prng() * len(ops))]
    val = samples[int(prng() * len(samples))]
    extra = samples[int(prng() * len(samples))]
    return (kind, val, op, extra)


def fuzz_TreeValue_validator(
    r: FuzzTestResult,
) -> Literal["pass", "fail", "unknown"]:
    if r.get("exception"):
        return "fail"
    return "pass"
