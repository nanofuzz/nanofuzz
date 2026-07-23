from typing import Any, Literal, List, TypedDict


type a = str


FuzzTestResult = TypedDict('FuzzTestResult', {
                           'in': List[Any], 'out': Any, 'exception': bool, 'timeout': bool})


def greeting(name: a) -> a:
    return 'Hello ' + name


def greetingValidator(r: FuzzTestResult) -> Literal["pass", "fail", "unknown"]:
    return "pass" if str(r['out']).endswith(r['in'][0]) else "fail"


def timeouts(n: int) -> int:
    if (n % 2):
        while True:
            n = n
    return n


def throws(n: int) -> int:
    if (n % 2 == 0):
        raise Exception("some put exception")
    return n
