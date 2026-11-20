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

    if constraint_str == "__EMPTY_STR__" or constraint_str == "":
        constraints = [""]
    elif constraint_str and constraint_str.strip():
        constraints = [constraint_str]
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
    """
    Grammar-aware BNF production generator that constructs arbitrary grammar specifications,
    rules, alternatives, repetitions, and constraints from syntax primitives.
    """
    nonterminals = ["<start>", "<a>", "<b>", "<c>", "<expr>", "<digit>", "<id>"]
    terminals = ["'a'", "'b'", "'0'", "'1'", "'hello'", "' '", "'\\n'"]

    # Generate 1 to 3 production rules
    num_rules = int(prng() * 3) + 1
    rules = []
    for i in range(num_rules):
        lhs = nonterminals[i % len(nonterminals)]
        num_alts = int(prng() * 3) + 1
        alts = []
        for _ in range(num_alts):
            seq_len = int(prng() * 2) + 1
            elements = []
            for _ in range(seq_len):
                if prng() < 0.5:
                    elements.append(nonterminals[int(prng() * len(nonterminals))])
                else:
                    t = terminals[int(prng() * len(terminals))]
                    r = prng()
                    if r < 0.2:
                        t = f"({t})+"
                    elif r < 0.4:
                        t = f"({t})*"
                    elements.append(t)
            alts.append(" ".join(elements))
        rules.append(f"{lhs} ::= " + " | ".join(alts))

    fan_spec = "\n".join(rules) + "\n"

    # Edge cases: occasionally sample empty list or comment
    p_edge = prng()
    if p_edge < 0.05:
        fan_spec = "__EMPTY_LIST__"
    elif p_edge < 0.10:
        fan_spec = ""

    # Generate arbitrary constraint expressions
    constraint_patterns = [
        "",
        "   ",
        f"where {nonterminals[int(prng() * len(nonterminals))]} == {terminals[int(prng() * len(terminals))]}",
        f"where len({nonterminals[int(prng() * len(nonterminals))]}) > {int(prng() * 5)}",
        f"where {nonterminals[int(prng() * len(nonterminals))]}..{nonterminals[int(prng() * len(nonterminals))]} == 1",
        f"minimizing len({nonterminals[int(prng() * len(nonterminals))]})",
        f"str({nonterminals[int(prng() * len(nonterminals))]}) != {terminals[int(prng() * len(terminals))]}",
    ]
    constraint_str = constraint_patterns[int(prng() * len(constraint_patterns))]

    start_symbols = ["<start>", "", "start", "<undefined>"]
    start_symbol = start_symbols[int(prng() * len(start_symbols))]
    use_stdlib = prng() > 0.5
    check = prng() > 0.3

    return (fan_spec, constraint_str, use_stdlib, check, start_symbol)


def fuzz_parse_validator(r: FuzzTestResult) -> Literal["pass", "fail", "unknown"]:
    if r.get("exception"):
        return "fail"
    return "pass"
