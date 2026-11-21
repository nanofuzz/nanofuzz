import string
import ast
import keyword
from typing import Literal
from nanofuzz_runtime import FuzzTestResult, UnsatisfiedAssumption, assume
from fandango.language.stdlib import make_def
from fandango.language.parse.parse import parse
from fandango.language.symbols import NonTerminal

def fuzz_make_def(symbol: str, chars: str, force_binary: bool) -> tuple[dict, list[str]]:
    bug_ids: list[str] = []
    put_input = {"symbol": symbol, "chars": chars, "force_binary": force_binary}

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
        grammar, _ = parse(result, use_stdlib=False, use_cache=False, start_symbol=f"<{symbol}>")
        if grammar is None or (NonTerminal(f"<{symbol}>") not in grammar.rules and f"<{symbol}>" not in grammar):
            if chars == "" or (chars == chr(0) and force_binary):
                bug_ids.append("DEF_EMPTY_RHS")
            elif any(ord(c) > 127 for c in str(symbol)):
                bug_ids.append("DEF_UNICODE_CORRUPT")
    except Exception:
        if chars == "" or (chars == chr(0) and force_binary):
            bug_ids.append("DEF_EMPTY_RHS")
        elif any(ord(c) > 127 for c in str(symbol)):
            bug_ids.append("DEF_UNICODE_CORRUPT")

    return (put_input, bug_ids)

def fuzz_make_def_transformer(symbol: str, chars: str, force_binary: bool) -> tuple[str, str, bool]:
    assume(isinstance(symbol, str) and len(symbol) > 0 and len(symbol) <= 100)
    assume(isinstance(chars, str) and len(chars) <= 100)
    assume(isinstance(force_binary, bool))
    return (symbol, chars, force_binary)

def fuzz_make_def_validator(r: FuzzTestResult) -> Literal["pass", "fail", "unknown"]:
    if r.get("exception"):
        return "fail"
    output = r.get("output")
    if output and len(output) > 0:
        val = output[0].get("value") if isinstance(output[0], dict) else output[0]
        if isinstance(val, (list, tuple)) and len(val) >= 2:
            bug_ids = val[1]
            if bug_ids:
                return "fail"
    return "pass"
