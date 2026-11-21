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
    action: Literal["slice", "prefix", "index", "grammar", "roundtrip", "add_child", "remove_child", "search_subtree", "get_root", "compare"] = "slice",
    fmt: Literal["acyclic", "cyclic"] = "acyclic",
) -> tuple[dict, list[str]]:
    """
    Harness testing DerivationTree invariants across dynamic indices, slices, tree operations, and formats.
    Returns tuple of [put_input, bug_ids].
    """
    bug_ids: list[str] = []
    put_input = {
        "child_text": child_text,
        "index": index,
        "slice_end": slice_end,
        "action": action,
        "fmt": fmt,
    }

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
        try:
            _ = repr(tree)
        except RecursionError:
            bug_ids.append("DT_REPR_CRASH")
        return (put_input, bug_ids)

    # Otherwise (fmt == 'acyclic'), evaluate the selected action
    if action == "slice":
        # DT_SLICE_PARENT_HIJACK: Slicing must not corrupt parent pointers of original children
        orig_parents = [c.parent for c in sub_children]
        _sliced = sub_nt[index:slice_end]
        if any(c.parent is not orig_parents[idx] for idx, c in enumerate(sub_children)):
            bug_ids.append("DT_SLICE_PARENT_HIJACK")

    elif action == "prefix":
        # DT_PREFIX_SLICE: Calling prefix on root node where parent is None crashes
        try:
            _ = tree.prefix(copy_tree=True)
        except AssertionError:
            bug_ids.append("DT_PREFIX_SLICE")

    elif action == "index":
        empty_tree = DerivationTree(NonTerminal("<empty>"), [])
        try:
            _ = empty_tree[index]
        except IndexError:
            bug_ids.append("DT_CHILD_SLICE")
        except Exception:
            pass

    elif action == "grammar":
        empty_tree = DerivationTree(NonTerminal("<empty>"), [])
        try:
            _ = empty_tree.to_grammar(include_position=(index % 2 == 0), include_value=(slice_end % 2 == 0))
        except AssertionError:
            bug_ids.append("DT_TO_GRAMMAR_ASSERT")
        except Exception:
            pass

    elif action == "roundtrip":
        # DT_ROUNDTRIP: Structural and attribute loss during tree serialization roundtrip
        def to_str_tuple(node):
            sym = node.symbol.name() if hasattr(node.symbol, "name") else str(node.symbol)
            return (sym, [to_str_tuple(c) for c in node._children])
        tree_tuple = to_str_tuple(tree)
        reconstructed = DerivationTree.from_tree(tree_tuple)
        if len(reconstructed.sources) != len(tree.sources) or reconstructed.sender != tree.sender or reconstructed.recipient != tree.recipient:
            bug_ids.append("DT_ROUNDTRIP")

    # Option B: AST Mutation Actions
    elif action == "add_child":
        new_child = DerivationTree(Terminal(f"new_{child_text}"))
        tree.add_child(new_child)
        _ = str(tree)

    elif action == "remove_child":
        if len(sub_nt._children) > 0:
            removed = sub_nt.remove_child(index=index % len(sub_nt._children))

    elif action == "search_subtree":
        found = list(tree.find_subtrees("<sub>"))

    elif action == "get_root":
        root = sub_nt.get_root(stop_at_argument_begin=True)

    elif action == "compare":
        tree_copy = copy.deepcopy(tree)

    return (put_input, bug_ids)


def fuzz_DerivationTree_generator(
    prng: Callable[[], float],
) -> tuple[str, int, int, str, str] | None:
    samples = ["hello", "world", "abc", "💃", "node", "", "<start>", "leaf"]
    actions = [
        "slice", "prefix", "index", "grammar", "roundtrip",
        "add_child", "remove_child", "search_subtree", "get_root", "compare"
    ]
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
    output = r.get("output")
    if output and len(output) > 0:
        val = output[0].get("value") if isinstance(output[0], dict) else output[0]
        if isinstance(val, (list, tuple)) and len(val) >= 2:
            bug_ids = val[1]
            if bug_ids:
                return "fail"
    return "pass"
