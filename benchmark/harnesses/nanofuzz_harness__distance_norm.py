import math
from collections.abc import Callable
from typing import Any, Literal, Optional
from nanofuzz_runtime import FuzzTestResult, UnsatisfiedAssumption, assume
from fandango.constraints.comparison import _distance_norm as target_distance_norm, _sigmoid as target_sigmoid


def fuzz__distance_norm(left: Any, right: Any) -> Optional[float]:
    return target_distance_norm(left, right)


def fuzz__distance_norm_generator(
    prng: Callable[[], float],
) -> tuple[Any, Any] | None:
    # Samples across continuous float distributions, IEEE 754 boundaries, and types
    special_floats = [0.0, -0.0, 1.0, -1.0, float("nan"), float("inf"), float("-inf"), 1e308, -1e308]

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
    if out is None:
        return "pass"

    if not isinstance(out, (float, int)):
        return "fail"

    if math.isnan(out):
        return "fail"

    if out < 0.0 or out > 1.0:
        return "fail"

    return "pass"
