import os
import sys
from collections.abc import Callable
from typing import Any, Literal

from nanofuzz_runtime import FuzzTestResult, UnsatisfiedAssumption, assume
from fandango.errors import FandangoError
from fandango.language.grammar.grammar import Grammar
from fandango.language.parse.parse import parse


def fuzz_parse(
    spec: str,
    constraint_str: str,
    use_stdlib: bool,
    check: bool,
    start_symbol: str,
) -> bool:
    if spec == "__EMPTY_LIST__":
        fan_files = []
    else:
        fan_files = spec

    if constraint_str and constraint_str.strip():
        constraints = [constraint_str]
    elif constraint_str == "__EMPTY_STR__":
        constraints = [""]
    else:
        constraints = None

    sym = start_symbol if start_symbol else None
    grammar, parsed_constraints = parse(
        fan_files=fan_files,
        constraints=constraints,
        use_cache=False,
        use_stdlib=use_stdlib,
        check=check,
        start_symbol=sym,
    )

    if grammar is not None:
        assert isinstance(grammar, Grammar)
    assert isinstance(parsed_constraints, list)
    return True


def fuzz_parse_generator(
    prng: Callable[[], float],
) -> tuple[str, str, bool, bool, str] | None:
    specs = [
        "<start> ::= 'a' | 'b'\n",
        "<start> ::= 'a' <b>\n<b> ::= 'b'\n",
        "<start> ::= ('a' | 'b')+\n",
        "<start> ::= '220 ' <rest> '\\r\\n'\n<rest> ::= r'.*'\n",
        "<start> ::= <b> | <a>\n<b> ::= '0'\n<a> ::= '0'\n",
        "<start> ::= <undefined>\n",
        "<start> ::= 'a' \\| 'b'\n",
        "# comment only\n",
        "",
        "__EMPTY_LIST__",
        "<start> ::= 'b'\n",
    ]
    constraints = [
        "",
        "   ",
        "__EMPTY_STR__",
        "where len(<start>) > 0",
        "str(<start>) != 'd'",
        "where str(<start>) != 'd' # trailing comment",
        "minimizing len(<start>)",
        "<start> == 'a'",
        "where <unknown> == 1",
        "where <start>..<target> == 1",
    ]
    start_symbols = ["<start>", "", "<undefined>", "start"]

    spec_idx = int(prng() * len(specs)) % len(specs)
    c_idx = int(prng() * len(constraints)) % len(constraints)
    sym_idx = int(prng() * len(start_symbols)) % len(start_symbols)

    fan_spec = specs[spec_idx]
    constraint_str = constraints[c_idx]
    use_stdlib = prng() > 0.5
    check = prng() > 0.3
    start_symbol = start_symbols[sym_idx]

    return (fan_spec, constraint_str, use_stdlib, check, start_symbol)


def fuzz_parse_validator(r: FuzzTestResult) -> Literal["pass", "fail", "unknown"]:
    if r.get("exception"):
        return "fail"
    return "pass"
