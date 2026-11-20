from collections.abc import Callable
from typing import Any, Literal
import copy

from nanofuzz_runtime import FuzzTestResult, UnsatisfiedAssumption, assume
from fandango.language.symbols import NonTerminal, Terminal
from fandango.language.tree import DerivationTree


def fuzz_DerivationTree(child_text: str, op: int) -> str:
    """
    Harness testing DerivationTree invariants.
    """
    if not child_text:
        child_text = "test_val"

    c1 = DerivationTree(Terminal(child_text))
    c2 = DerivationTree(Terminal("leaf2"))
    sub_nt = DerivationTree(NonTerminal("<sub>"), [c1])
    tree = DerivationTree(NonTerminal("<start>"), [sub_nt, c2])

    if op == 0:
        # DT_SLICE_PARENT_HIJACK: Slicing must not corrupt parent pointers of original children
        orig_parent = c1.parent
        _sliced = sub_nt[0:1]
        assert c1.parent is orig_parent, f"Parent hijacked: expected {orig_parent}, got {c1.parent}"

    elif op == 1:
        # DT_PREFIX_SLICE: Calling prefix on root node where parent is None crashes
        try:
            _ = tree.prefix(copy_tree=True)
        except AssertionError as e:
            raise AssertionError(f"prefix() crashed on root: {e}") from e

    elif op == 2:
        # DT_CHILD_SLICE: IndexError on empty children
        empty_tree = DerivationTree(NonTerminal("<empty>"), [])
        try:
            _ = empty_tree[0]
        except IndexError as e:
            raise AssertionError(f"Indexing empty children raised IndexError: {e}") from e

    elif op == 3:
        # DT_TO_GRAMMAR_ASSERT: to_grammar on empty children
        empty_tree = DerivationTree(NonTerminal("<empty>"), [])
        try:
            _ = empty_tree.to_grammar()
        except AssertionError as e:
            raise AssertionError(f"to_grammar() crashed on empty tree: {e}") from e

    elif op == 4:
        # DT_REPR_CRASH: RecursionError on cyclic tree
        cyclic_root = DerivationTree(NonTerminal("<cycle>"))
        cyclic_child = DerivationTree(NonTerminal("<child>"), [cyclic_root])
        cyclic_root.set_children([cyclic_child])
        _ = repr(cyclic_root)

    return str(tree)


def fuzz_DerivationTree_generator(
    prng: Callable[[], float],
) -> tuple[str, int] | None:
    samples = ["hello", "world", "abc", "💃", "node", ""]
    op = int(prng() * 5)
    s = samples[int(prng() * len(samples))]
    return (s, op)


def fuzz_DerivationTree_validator(
    r: FuzzTestResult,
) -> Literal["pass", "fail", "unknown"]:
    if r.get("exception"):
        return "fail"
    return "pass"
