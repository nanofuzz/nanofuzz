from collections.abc import Callable
from typing import Any, Literal
import copy

from nanofuzz_runtime import FuzzTestResult, UnsatisfiedAssumption, assume
from fandango.language.symbols import NonTerminal, Terminal
from fandango.language.tree import DerivationTree


def fuzz_DerivationTree(
    child_text: str,
    index: int,
    slice_end: int,
    action: Literal["slice", "prefix", "index", "grammar", "roundtrip"] = "slice",
    fmt: Literal["acyclic", "cyclic"] = "acyclic",
) -> str:
    """
    Harness testing DerivationTree invariants across dynamic indices, slices, tree operations, and formats.
    """
    if not child_text:
        child_text = "test_val"

    sub_children = [
        DerivationTree(Terminal(f"{child_text}_{i}")) for i in range(5)
    ]
    sub_nt = DerivationTree(NonTerminal("<sub>"), sub_children)
    alt_nt = DerivationTree(NonTerminal("<expr>"), [
        DerivationTree(Terminal("prefix")),
        DerivationTree(NonTerminal("<ident>"), [DerivationTree(Terminal("x"))]),
        DerivationTree(Terminal("suffix")),
    ])
    tree = DerivationTree(NonTerminal("<start>"), [
        DerivationTree(Terminal("header")),
        sub_nt,
        alt_nt,
        DerivationTree(Terminal("trailer")),
    ])
    tree.sources = [DerivationTree(Terminal("src_leaf"))]
    tree.sender = "sender_client"
    tree.recipient = "recipient_server"

    # If cyclic, mutate the tree structure to be cyclic then evaluate representation
    if fmt == "cyclic":
        tree._children = [tree]
        _ = repr(tree)
        return str(tree)

    # Otherwise (fmt == 'acyclic'), evaluate the selected action
    if action == "slice":
        # DT_SLICE_PARENT_HIJACK: Slicing must not corrupt parent pointers of original children
        orig_parents = [c.parent for c in sub_children]
        _sliced = sub_nt[index:slice_end]
        for idx, c in enumerate(sub_children):
            assert c.parent is orig_parents[idx], f"Child {idx} parent hijacked: expected {orig_parents[idx]}, got {c.parent}"

    elif action == "prefix":
        # DT_PREFIX_SLICE: Calling prefix on root node where parent is None crashes
        _ = tree.prefix(copy_tree=True)

    elif action == "index":
        if len(sub_children) > 0:
            _ = sub_nt[index % len(sub_children)]

    elif action == "grammar":
        _ = tree.to_grammar(include_position=(index % 2 == 0), include_value=(slice_end % 2 == 0))

    elif action == "roundtrip":
        # DT_ROUNDTRIP: Structural and attribute loss during tree serialization roundtrip
        def to_str_tuple(node):
            sym = node.symbol.name() if hasattr(node.symbol, "name") else str(node.symbol)
            return (sym, [to_str_tuple(c) for c in node._children])
        tree_tuple = to_str_tuple(tree)
        reconstructed = DerivationTree.from_tree(tree_tuple)
        assert len(reconstructed._children) == len(tree._children), "Children count mismatch after roundtrip"

    return str(tree)


def fuzz_DerivationTree_generator(
    prng: Callable[[], float],
) -> tuple[str, int, int, str, str] | None:
    samples = ["hello", "world", "abc", "💃", "node", "", "<start>", "leaf"]
    actions = ["slice", "prefix", "index", "grammar", "roundtrip"]
    fmts = ["acyclic", "cyclic"]

    s = samples[int(prng() * len(samples))]
    index = int(prng() * 10) - 5
    slice_end = int(prng() * 10) - 2
    action = actions[int(prng() * len(actions))]
    fmt = "cyclic" if prng() < 0.15 else "acyclic"
    return (s, index, slice_end, action, fmt)


def fuzz_DerivationTree_validator(
    r: FuzzTestResult,
) -> Literal["pass", "fail", "unknown"]:
    if r.get("exception"):
        return "fail"
    return "pass"
