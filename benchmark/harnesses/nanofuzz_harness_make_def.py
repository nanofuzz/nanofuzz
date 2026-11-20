import string
import ast
import keyword
from typing import Literal
from nanofuzz_runtime import FuzzTestResult, UnsatisfiedAssumption, assume
from fandango.language.stdlib import make_def
from fandango.language.parse.parse import parse
from fandango.language.symbols import NonTerminal

def fuzz_make_def(symbol: str, chars: str, force_binary: bool) -> str:
    # Target execution
    result = make_def(symbol, chars, force_binary=force_binary)
    assert isinstance(result, str), f"make_def must return a string, got {type(result)}"

    # Invariant 1: Structural format
    assert f"<_{symbol}> ::=" in result, f"Expected <_{symbol}> ::= in result"
    assert f"<{symbol}> ::= <_{symbol}>\n\n" in result, f"Expected alias rule <{symbol}> ::= <_{symbol}> in result"

    # Invariant 2: Hex escape overflow / multi-byte corruption on characters with ord(c) > 255
    # When ord(c) > 255, f"b'\\x{ord(c):02x}'" produces 3+ hex digits (e.g. b'\x20ac')
    # which Python and Fandango evaluate as byte 0x20 followed by ASCII characters 'a' and 'c'
    # corrupting the character into an unintended multi-byte literal.
    for c in chars:
        if (c not in string.printable) or force_binary:
            if ord(c) > 255:
                bad_escape = f"b'\\x{ord(c):02x}'"
                if bad_escape in result:
                    val = ast.literal_eval(bad_escape)
                    assert len(val) == 1, (
                        f"Hex escape overflow: character {repr(c)} (ord={ord(c)}) formatted as {bad_escape} "
                        f"which evaluates to {len(val)} bytes instead of 1 byte"
                    )

    # Invariant 3: The generated grammar definition must parse successfully as a valid Fandango grammar
    # Calling make_def with chars='' produces '<_lhs> ::= \n<lhs> ::= <_lhs>' which fails parsing.
    # Passing non-ASCII Unicode identifiers (e.g. Cyrillic) in symbol causes parse() to fail with FandangoSyntaxError.
    grammar, _ = parse(result, use_stdlib=False, use_cache=False, start_symbol=f"<{symbol}>")
    assert grammar is not None, "Failed to parse generated grammar definition"
    assert NonTerminal(f"<{symbol}>") in grammar.rules or f"<{symbol}>" in grammar, (
        f"Symbol <{symbol}> not found in parsed grammar"
    )

    return result

def fuzz_make_def_transformer(symbol: str, chars: str, force_binary: bool) -> tuple[str, str, bool]:
    if not isinstance(symbol, str) or not symbol:
        symbol = "sym"
    # Ensure valid ASCII identifier avoiding keywords and special tokens
    clean_sym = "".join(c for c in symbol if c.isascii() and (c.isalnum() or c == "_"))
    if not clean_sym or clean_sym[0].isdigit():
        clean_sym = "rule_" + clean_sym
    if keyword.iskeyword(clean_sym) or clean_sym in ("py", "start"):
        clean_sym = clean_sym + "_sym"
    symbol = clean_sym[:20]

    if not isinstance(chars, str) or not chars:
        chars = "a"
    # Filter known Bug 3 (ord > 255) by mapping to Latin-1 range
    chars = "".join(c if ord(c) <= 255 else chr(ord(c) % 256) for c in chars[:20])
    if not chars:
        chars = "a"

    force_binary = bool(force_binary)
    return (symbol, chars, force_binary)

def fuzz_make_def_validator(r: FuzzTestResult) -> Literal["pass", "fail", "unknown"]:
    if r.get("exception"):
        return "fail"
    return "pass"
