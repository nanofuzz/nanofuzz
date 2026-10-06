from typing import Any, Callable, Literal, List, TypedDict, Union, Tuple


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


Issue301Out = TypedDict('Issue301Out', {'a': Union[int, None]})


def issue301(r: int) -> Issue301Out:
    if r == 6:
        return {'a': None}
    return {'a': r}


class UnsatisfiedAssumption(Exception):
    pass


def with_assume(n: int) -> int:
    if n == 5:
        raise UnsatisfiedAssumption("n cannot be 5")
    return n


def py_transformed(n: int) -> int:
    return n + 1


def py_transformedTransformer(n: int) -> Union[List[int], None]:
    if n == 5:
        raise UnsatisfiedAssumption("Transformer skipped n=5")
    if n < 0:
        return None
    return [n * 10]


def py_transformed_exception(n: int) -> int:
    return n


def py_transformed_exceptionTransformer(n: int) -> Union[List[int], None]:
    raise Exception("Python transformer error")


async def async_greeting(name: str) -> str:
    import asyncio
    await asyncio.sleep(0.005)
    if name == "boom":
        raise ValueError("async boom")
    return "Hello " + name


def async_greetingValidator(r: FuzzTestResult) -> Literal["pass", "fail", "unknown"]:
    if r['exception']:
        return "pass"
    return "pass" if str(r['out']).startswith("Hello ") else "fail"


def py_transformed_timeout(n: int) -> int:
    return n


def py_transformed_timeoutTransformer(n: int) -> Union[List[int], None]:
    while True:
        pass


def py_user_gen(n: int, s: str) -> str:
    return f"{s}:{n}"


def py_user_genGenerator(prng: Callable[[], float]) -> Union[Tuple[int, str], None]:
    n = int(prng() * 100) if callable(prng) else 42
    return (n, "custom")


py_user_gen_finite_count = 0


def py_user_gen_finite(n: int) -> int:
    return n * 2


def py_user_gen_finiteGenerator(prng: Callable[[], float]) -> Union[Tuple[int], None]:
    global py_user_gen_finite_count
    py_user_gen_finite_count += 1
    if py_user_gen_finite_count > 3:
        return None
    return (py_user_gen_finite_count * 10,)


def py_user_gen_exception(n: int) -> int:
    return n


def py_user_gen_exceptionGenerator(prng: Callable[[], float]) -> Union[Tuple[int], None]:
    raise Exception("Python user generator error")


def py_user_gen_assumption(n: int) -> int:
    return n


def py_user_gen_assumptionGenerator(prng: Callable[[], float]) -> Union[Tuple[int], None]:
    raise UnsatisfiedAssumption("Illegal assumption in generator")
