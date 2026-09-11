from typing import Any, Literal, List, Optional, TypedDict


FuzzTestResult = TypedDict('FuzzTestResult', {
                           'in': List[Any], 'out': Any, 'exception': bool, 'timeout': bool})


class UnsatisfiedAssumption(Exception):
    """Exception raised when a test input assumption is not satisfied."""
    pass


def assume(condition: Any, message: Optional[str] = None) -> Literal[True]:
    """
    Evaluates condition for truthiness. If condition is truthy, returns True.
    If condition is falsy, raises UnsatisfiedAssumption to skip the test input.

    Optional message parameter provides an explanation for why the condition failed.
    """
    if not condition:
        raise UnsatisfiedAssumption(message or "Unsatisfied assumption")
    return True


__all__ = ["FuzzTestResult", "UnsatisfiedAssumption", "assume"]
