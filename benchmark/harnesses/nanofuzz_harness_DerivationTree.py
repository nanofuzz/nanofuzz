from collections.abc import Callable
from typing import Literal

from nanofuzz_runtime import FuzzTestResult
from fandango.language.symbols import NonTerminal, Terminal
from fandango.language.tree import DerivationTree


def fuzz_DerivationTree(
    child_text: str,
    index: int,
    slice_end: int,
    action: Literal["slice", "prefix", "index", "grammar", "roundtrip", "add_child",
                    "remove_child", "search_subtree", "get_root", "compare"] = "slice",
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
        DerivationTree(NonTerminal("<ident>"), [
                       DerivationTree(Terminal("x"))]),
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

    # DT_SLICE_PARENT_HIJACK: Slicing must not corrupt parent pointers of original children
    orig_parents = [c.parent for c in sub_children]
    _sliced = sub_nt[index:slice_end]
    if any(c.parent is not orig_parents[idx] for idx, c in enumerate(sub_children)):
        bug_ids.append("DT_SLICE_PARENT_HIJACK")

    # DT_PREFIX_SLICE: Calling prefix on root node where parent is None crashes
    try:
        _ = tree.prefix(copy_tree=True)
    except AssertionError:
        bug_ids.append("DT_PREFIX_SLICE")

    # DT_CHILD_SLICE: IndexError on indexing empty children
    empty_tree = DerivationTree(NonTerminal("<empty>"), [])
    try:
        _ = empty_tree[index]
    except IndexError:
        bug_ids.append("DT_CHILD_SLICE")
    except Exception:
        pass

    # DT_TO_GRAMMAR_ASSERT: to_grammar on degenerate terminal tree
    degenerate_tree = DerivationTree(Terminal(child_text))
    try:
        _ = degenerate_tree.to_grammar(include_position=(
            index % 2 == 0), include_value=(slice_end % 2 == 0))
    except AssertionError:
        bug_ids.append("DT_TO_GRAMMAR_ASSERT")
    except Exception:
        pass

    # DT_ROUNDTRIP: Structural and attribute loss during tree serialization roundtrip
    def to_str_tuple(node):
        sym = node.symbol.name() if hasattr(node.symbol, "name") else str(node.symbol)
        return (sym, [to_str_tuple(c) for c in node._children])
    tree_tuple = to_str_tuple(tree)
    reconstructed = DerivationTree.from_tree(tree_tuple)
    if len(reconstructed.sources) != len(tree.sources) or reconstructed.sender != tree.sender or reconstructed.recipient != tree.recipient:
        bug_ids.append("DT_ROUNDTRIP")

    # DT_REPR_CRASH: Cyclic tree recursion
    if fmt == "cyclic":
        cyclic_tree = DerivationTree(NonTerminal("<start>"), [])
        cyclic_tree._children = [cyclic_tree]
        try:
            _ = repr(cyclic_tree)
        except RecursionError:
            bug_ids.append("DT_REPR_CRASH")

    # Additional operations
    try:
        _ = str(tree)
        _ = repr(tree)
        _ = sub_nt.get_root(stop_at_argument_begin=True)
    except Exception:
        pass

    return (put_input, bug_ids)


def fuzz_DerivationTree_generator(
    prng: Callable[[], float],
) -> tuple[str, int, int, str, str] | None:
    samples = ["hello", "world", "abc", "💃", "node", "", "<start>", "leaf"]
    actions = [
        "slice", "prefix", "index", "grammar", "roundtrip",
        "add_child", "remove_child", "search_subtree", "get_root", "compare"
    ]

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
