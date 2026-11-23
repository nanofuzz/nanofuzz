from collections.abc import Callable
import ast
import string
from typing import Literal

from nanofuzz_runtime import FuzzTestResult, assume, put
from fandango.language.parse.parse import parse
from fandango.language.stdlib import make_def
from fandango.language.symbols import NonTerminal


@put(make_def)
def fuzz_make_def(symbol: str, chars: str, force_binary: bool) -> tuple[dict, list[str]]:
    assume(isinstance(symbol, str) and len(symbol) > 0 and len(symbol) <= 100)
    assume(isinstance(chars, str) and len(chars) <= 100)
    assume(isinstance(force_binary, bool))

    bug_ids: list[str] = []
    put_input = {"symbol": symbol, "chars": chars,
                 "force_binary": force_binary}

    try:
        result = make_def(symbol, chars, force_binary=force_binary)
    except Exception:
        if chars == "" or (chars == chr(0) and force_binary):
            bug_ids.append("DEF_EMPTY_RHS")
        elif any(ord(c) > 127 and c.isalpha() for c in str(symbol)):
            bug_ids.append("DEF_UNICODE_CORRUPT")
        elif any(ord(c) > 255 for c in str(chars)):
            bug_ids.append("DEF_HEX_OVERFLOW")
        return (put_input, bug_ids)

    # Invariant 2: Hex escape overflow / multi-byte corruption on characters with ord(c) > 255
    for c in chars:
        if (c not in string.printable) or force_binary:
            if ord(c) > 255:
                bad_escape = f"b'\\x{ord(c):02x}'"
                if bad_escape in result:
                    try:
                        val = ast.literal_eval(bad_escape)
                        if len(val) != 1:
                            bug_ids.append("DEF_HEX_OVERFLOW")
                    except Exception:
                        bug_ids.append("DEF_HEX_OVERFLOW")

    # Invariant 3: The generated grammar definition must parse successfully as a valid Fandango grammar
    try:
        grammar, _ = parse(result, use_stdlib=False,
                           use_cache=False, start_symbol=f"<{symbol}>")
        if grammar is None or (NonTerminal(f"<{symbol}>") not in grammar.rules and f"<{symbol}>" not in grammar):
            if chars == "" or (chars == chr(0) and force_binary):
                bug_ids.append("DEF_EMPTY_RHS")
            if any(ord(c) > 127 for c in str(symbol)):
                bug_ids.append("DEF_UNICODE_CORRUPT")
    except Exception:
        if chars == "" or (chars == chr(0) and force_binary):
            bug_ids.append("DEF_EMPTY_RHS")
        if any(ord(c) > 127 for c in str(symbol)):
            bug_ids.append("DEF_UNICODE_CORRUPT")

    return (put_input, bug_ids)


def fuzz_make_def_validator(r: FuzzTestResult) -> Literal["pass", "fail", "unknown"]:
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


def fuzz_make_def_generator(
    prng: Callable[[], float],
) -> tuple[str, str, bool] | None:
    p = prng()
    if p < 0.35:
        symbols = ["digit", "alpha", "sym", "тест", "NUL", "euro", "hex", "rule_1", "start"]
        sym = symbols[int(prng() * len(symbols))]
    elif p < 0.70:
        length = int(prng() * 8) + 1
        sym = "".join(chr(int(prng() * 26) + 97) for _ in range(length))
    else:
        sym = chr(int(prng() * 200) + 100)

    pc = prng()
    if pc < 0.35:
        chars_samples = ["0123456789", "abcdef", "", chr(0), "€", "abc\x00def", "xyz", " \t\n"]
        c = chars_samples[int(prng() * len(chars_samples))]
    elif pc < 0.70:
        c_len = int(prng() * 12)
        c = "".join(chr(int(prng() * 128)) for _ in range(c_len))
    else:
        c_len = int(prng() * 6) + 1
        c = "".join(chr(int(prng() * 500) + 1) for _ in range(c_len))

    force_binary = prng() > 0.5
    return (sym, c, force_binary)

