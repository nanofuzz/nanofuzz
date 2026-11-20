import math
from collections.abc import Callable
from typing import Any, Literal, Optional
from nanofuzz_runtime import FuzzTestResult, UnsatisfiedAssumption, assume
from fandango.constraints.comparison import _distance_norm as target_distance_norm, _sigmoid as target_sigmoid


def fuzz__distance_norm(left: Any, right: Any) -> Optional[float]:
    # Test sigmoid overflow on extreme negative floats if numeric
    if isinstance(left, (int, float)) and left <= -700.0:
        _ = target_sigmoid(left)

    return target_distance_norm(left, right)


def fuzz__distance_norm_transformer(left: Any, right: Any) -> tuple[Any, Any]:
    return (left, right)


def fuzz__distance_norm_generator(
    prng: Callable[[], float],
) -> tuple[Any, Any] | None:
    mode = int(prng() * 6)
    if mode == 0:
        # Equal inputs (ZeroDivisionError)
        v = prng() * 100.0
        return (v, v)
    elif mode == 1:
        # NaN propagation
        return (float("nan"), 10.0)
    elif mode == 2:
        # Sigmoid overflow
        return (-800.0, 10.0)
    elif mode == 3:
        v1 = prng() * 1000.0
        v2 = prng() * 500.0
        return (v1, v2)
    elif mode == 4:
        return (0.0, 0.0)
    else:
        v1 = int(prng() * 2000000)
        v2 = int(prng() * 1000000)
        return (v1, v2)


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
