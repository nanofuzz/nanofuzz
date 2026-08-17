from typing import Any, Literal, List, TypedDict


FuzzTestResult = TypedDict('FuzzTestResult', {
                           'in': List[Any], 'out': Any, 'exception': bool, 'timeout': bool})
