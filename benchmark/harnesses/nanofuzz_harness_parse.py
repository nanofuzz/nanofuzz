from collections.abc import Callable
from typing import Literal

from nanofuzz_runtime import FuzzTestResult
from fandango.language.parse.parse import parse_string


def fuzz_parse(
    spec: str,
    constraint_str: str,
    use_stdlib: bool,
    check: bool,
    start_symbol: str,
) -> tuple[dict, list[str]]:
    bug_ids: list[str] = []
    put_input = {
        "spec": spec,
        "constraint_str": constraint_str,
        "use_stdlib": use_stdlib,
        "check": check,
        "start_symbol": start_symbol,
    }

    if spec == "__EMPTY_LIST__":
        fan_files = []
    elif spec.startswith("__MULTI_SPEC__\n"):
        fan_files = [s for s in spec[len("__MULTI_SPEC__\n"):].split(
            "\n---\n") if s.strip()]
    else:
        fan_files = spec

    if constraint_str is not None:
        constraints = ["" if constraint_str ==
                       "__EMPTY_STR__" else constraint_str]
    else:
        constraints = None

    sym = start_symbol if start_symbol else None
    try:
        grammar, parsed_constraints = parse_string(
            spec=fan_files,
            constraints=constraints,
            use_stdlib=use_stdlib,
            check=check,
            start_symbol=sym,
        )
        if any(isinstance(c, str) and "#" in c for c in (constraints or [])):
            bug_ids.append("PARSE_SILENT_DROP")
    except IndexError:
        if len(fan_files or []) == 0 and not use_stdlib and bool(constraints):
            bug_ids.append("PARSE_EMPTY_FAN_FILES")
        else:
            bug_ids.append("PARSE_EMPTY_CONSTRAINT")
    except RecursionError:
        bug_ids.append("PARSE_DESC_RECUR")
    except Exception as e:
        exc_type = type(e).__name__
        if "NameError" in exc_type or "ValueError" in exc_type:
            bug_ids.append("PARSE_NAME_ERROR")

    return (put_input, bug_ids)


def fuzz_parse_generator(
    prng: Callable[[], float],
) -> tuple[str, str, bool, bool, str] | None:
    """
    Grammar-aware BNF production generator constructing arbitrary grammar specifications,
    character classes, regexes, boolean constraints, multi-spec files, and repetitions.
    """
    nonterminals = ["<start>", "<a>", "<b>",
                    "<c>", "<expr>", "<digit>", "<id>"]
    # Option A: Terminals including regexes and character classes
    terminals = ["'a'", "'b'", "'0'", "'1'", "'hello'", "' '",
                 "'\\n'", "r'[0-9]+'", "r'[a-z]+'", "[a-zA-Z]", "~['a']"]

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
                if prng() < 0.4:
                    elements.append(
                        nonterminals[int(prng() * len(nonterminals))])
                else:
                    t = terminals[int(prng() * len(terminals))]
                    r = prng()
                    if r < 0.15:
                        t = f"({t})+"
                    elif r < 0.30:
                        t = f"({t})*"
                    elif r < 0.40:
                        count = int(prng() * 3) + 1
                        t = f"{t}{{{count}}}"
                    elements.append(t)
            alts.append(" ".join(elements))
        rules.append(f"{lhs} ::= " + " | ".join(alts))

    fan_spec = "\n".join(rules) + "\n"

    # Option C: Multi-spec list generation
    p_edge = prng()
    if p_edge < 0.05:
        fan_spec = "__EMPTY_LIST__"
    elif p_edge < 0.10:
        fan_spec = ""
    elif p_edge < 0.20:
        # Multi-file grammar specification
        spec_2 = f"<aux> ::= 'token' | {nonterminals[int(prng() * len(nonterminals))]}\n"
        fan_spec = f"__MULTI_SPEC__\n{fan_spec}\n---\n{spec_2}"

    # Option B: Compound constraint expressions (boolean logic, arithmetic, maximizing)
    nt1 = nonterminals[int(prng() * len(nonterminals))]
    nt2 = nonterminals[int(prng() * len(nonterminals))]
    t1 = terminals[int(prng() * len(terminals))]
    constraint_patterns = [
        "",
        "   ",
        f"where {nt1} == {t1}",
        f"where len({nt1}) > {int(prng() * 5)}",
        f"where {nt1}..{nt2} == 1",
        f"where len({nt1}) > 0 and {nt1} != {t1}",
        f"where {nt1} == {t1} or {nt2} == '0'",
        f"where not (len({nt1}) == 0)",
        f"where 2 * len({nt1}) > 1",
        f"minimizing len({nt1})",
        f"maximizing len({nt1})",
        f"str({nt1}) != {t1}",
    ]
    constraint_str = constraint_patterns[int(
        prng() * len(constraint_patterns))]

    start_symbols = ["<start>", "", "start", "<undefined>"]
    start_symbol = start_symbols[int(prng() * len(start_symbols))]
    use_stdlib = prng() > 0.5
    check = prng() > 0.3

    return (fan_spec, constraint_str, use_stdlib, check, start_symbol)


def fuzz_parse_validator(r: FuzzTestResult) -> Literal["pass", "fail", "unknown"]:
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
