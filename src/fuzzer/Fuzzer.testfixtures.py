from typing import Any, Literal, List, TypedDict


type a = str


class FuzzTestResult(TypedDict):
    input: List[any]  # function input
    output: any  # function output
    exception: bool  # true if an exception was thrown
    timeout: bool  # true if the fn call timed out


def greeting(name: a) -> a:
    return 'Hello ' + name


# def greetingValidator(r: FuzzTestResult) -> Literal["pass","fail","unknown"]:
#    return "pass" if str(r.output).endswith(r.input[0]) else "fail"


def timeouts(n: int) -> int:
    if (n % 2):
        while True:
            n = n
    return n


def throws(n: int) -> int:
    if (n % 2 == 0):
        raise Exception("some put exception")
    return n
