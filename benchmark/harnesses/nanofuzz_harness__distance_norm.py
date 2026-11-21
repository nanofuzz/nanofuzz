import math
from collections.abc import Callable
from typing import Any, Literal
from nanofuzz_runtime import FuzzTestResult
from fandango.constraints.comparison import _distance_norm as target_distance_norm
from fandango.constraints.comparison import _sigmoid as target_sigmoid


def fuzz__distance_norm(left: Any, right: Any) -> tuple[dict, list[str]]:
    bug_ids: list[str] = []
    put_input = {"left": left, "right": right}

    try:
        res = target_distance_norm(left, right)
        if res is not None:
            if math.isnan(res) or res < 0.0 or res > 1.0:
                bug_ids.append("NORM_NAN_PROPAGATE")
    except OverflowError:
        bug_ids.append("SIGMOID_OVERFLOW")
    except Exception:
        pass

    if isinstance(left, (int, float)) and left <= -709.782712893384:
        try:
            _ = target_sigmoid(left)
        except OverflowError:
            bug_ids.append("SIGMOID_OVERFLOW")

    return (put_input, bug_ids)


def fuzz__distance_norm_generator(
    prng: Callable[[], float],
) -> tuple[Any, Any] | None:
    # Samples across continuous float distributions, IEEE 754 boundaries, and types
    special_floats = [0.0, -0.0, 1.0, -1.0,
                      float("nan"), float("inf"), float("-inf"), 1e308, -1e308]

    def sample_single() -> Any:
        p = prng()
        if p < 0.25:
            return special_floats[int(prng() * len(special_floats))]
        elif p < 0.65:
            return (prng() - 0.5) * 2000.0
        elif p < 0.85:
            return int((prng() - 0.5) * 2000000)
        else:
            return str(int(prng() * 100))

    return (sample_single(), sample_single())


def fuzz__distance_norm_validator(
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
