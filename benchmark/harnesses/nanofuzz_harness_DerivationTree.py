from collections.abc import Callable
from typing import Any, Literal
import copy

from nanofuzz_runtime import FuzzTestResult, UnsatisfiedAssumption, assume
from fandango.language.symbols import NonTerminal, Terminal
from fandango.language.tree import DerivationTree


def fuzz_DerivationTree(child_text: str, op: int, index: int, slice_end: int) -> str:
    """
    Harness testing DerivationTree invariants across dynamic indices, slices, and tree operations.
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

    if op == 0:
        # DT_SLICE_PARENT_HIJACK: Slicing must not corrupt parent pointers of original children
        orig_parents = [c.parent for c in sub_children]
        _sliced = sub_nt[index:slice_end]
        for idx, c in enumerate(sub_children):
            assert c.parent is orig_parents[idx], f"Child {idx} parent hijacked: expected {orig_parents[idx]}, got {c.parent}"

    elif op == 1:
        # DT_PREFIX_SLICE: Calling prefix on root node where parent is None crashes
        # Exercise prefix on intermediate node with parent (should succeed)
        try:
            _ = sub_nt.prefix(copy_tree=True)
        except Exception:
            pass
        # Exercise prefix on root node where parent is None (raises AssertionError)
        try:
            _ = tree.prefix(copy_tree=True)
        except AssertionError as e:
            raise AssertionError(f"prefix() crashed on root: {e}") from e

    elif op == 2:
        # DT_CHILD_SLICE: IndexError on empty children or out-of-bounds indexing
        empty_tree = DerivationTree(NonTerminal("<empty>"), [])
        try:
            _ = empty_tree[index]
        except IndexError as e:
            raise AssertionError(f"Indexing empty children raised IndexError: {e}") from e

    elif op == 3:
        # DT_TO_GRAMMAR_ASSERT: to_grammar on empty children with dynamic position/value flags
        empty_tree = DerivationTree(NonTerminal("<empty>"), [])
        try:
            _ = empty_tree.to_grammar(include_position=(index % 2 == 0), include_value=(slice_end % 2 == 0))
        except AssertionError as e:
            raise AssertionError(f"to_grammar() crashed on empty tree: {e}") from e

    elif op == 4:
        # DT_REPR_CRASH: RecursionError on cyclic tree
        cyclic_root = DerivationTree(NonTerminal("<cycle>"))
        cyclic_child = DerivationTree(NonTerminal("<child>"), [cyclic_root])
        cyclic_root._children = [cyclic_child]
        _ = repr(cyclic_root)

    elif op == 5:
        # DT_ROUNDTRIP: Structural and attribute loss during tree serialization roundtrip
        tree.sources = [DerivationTree(Terminal("src_leaf"))]
        tree.sender = "sender_client"
        tree.recipient = "recipient_server"
        def to_str_tuple(node):
            sym = node.symbol.name() if hasattr(node.symbol, "name") else str(node.symbol)
            return (sym, [to_str_tuple(c) for c in node._children])
        tree_tuple = to_str_tuple(tree)
        reconstructed = DerivationTree.from_tree(tree_tuple)
        assert len(reconstructed.sources) == len(tree.sources), "Sources lost during from_tree roundtrip"
        assert reconstructed.sender == tree.sender, "Sender lost during from_tree roundtrip"
        assert reconstructed.recipient == tree.recipient, "Recipient lost during from_tree roundtrip"

    return str(tree)


def fuzz_DerivationTree_validator(
    r: FuzzTestResult,
) -> Literal["pass", "fail", "unknown"]:
    if r.get("exception"):
        return "fail"
    return "pass"
