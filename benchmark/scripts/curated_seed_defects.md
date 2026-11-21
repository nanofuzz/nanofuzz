# Curated Seed Defect Examples

Top 5 Most Interesting Examples:

1. make_def: docs/iso8601.py and src/fandango/language/stdlib.py
The documentation script literally constructs binary character ranges using:
make_def("NUL", chr(0), force_binary=True)
When chars is empty or chr(0), make_rule joins an empty expansion list, producing `<_NUL> ::= \n<NUL> ::= <_NUL>`, which ANTLR grammar parser literally rejects with a syntax error. The documentation author wrote the generator that produces the exact string their own parser rejects.

2. TreeValue: tests/test_tree_value.py (test_to_first_arg)
The test parameterizes over FIRST_ARG including "__radd__", but passes integer 1 to both sides:
getattr(TreeValue(1), "__radd__")(1)
It asserts that the returned value is not callable. Because 1 is numeric, __radd__ succeeds. But if you pass any string from the documentation like "hello", TreeValue.__radd__ tries to parse the string as an integer and crashes with ValueError. The unit test claimed full method coverage while dodging the type check completely.

3. DerivationTree: tests/test_slices.py (test_slice_0)
The test runs fuzzing with slice constraints `<start>[0] == "6"`.
Slicing constructs a SliceTree, whose constructor traverses the original nodes and reparents child._parent = slice_tree in-place. The test only checked that the returncode was 0, completely missing that the slice operation permanently hijacked and corrupted the parent pointers of the original derivation tree.

4. _distance_norm: tests/test_constraints.py (test_explicit_fitness)
The test constructs comparisons where left and right bounds evaluate to the exact same tree structure or 0 distance.
In comparison.py, equal values trigger:
dist = left - right (or lower == upper)
This causes ZeroDivisionError inside the normalization math. The unit test never saw the crash because the outer constraint runner caught generic Exception and defaulted the fitness score to 0.0, which the test asserted was equal to 0.

5. parse: docs/Grammar.md and tests/test_parsing.py
The tutorial documents descendant constraint syntax:
where <start>..<target> == 1
When evaluated on recursive grammars, check_constraints_existence_children traverses the children recursively before memoizing visited nodes. Evaluating the documented syntax on any recursive rule triggers an immediate unhandled RecursionError.

---

PUT: make_def

Example 1: Empty grammar rule on empty chars
- Source: docs/iso8601.py line 20
- Harvested Input: {"symbol": "NUL", "chars": "", "force_binary": True}
- Source Test / Context: docs/iso8601.py generates standard library definitions for ascii control characters.
- What Was Asserted: It assumed make_def("NUL", "") returned a valid grammar definition.
- Bug Elicited: DEF_EMPTY_RHS. Produces `<_NUL> ::= \n<NUL> ::= <_NUL>`, which fails grammar parsing because ANTLR rules cannot have empty right-hand sides without an explicit literal.

Example 2: Hex escape overflow on multi-byte characters
- Source: src/fandango/language/stdlib.py line 25
- Harvested Input: {"symbol": "euro", "chars": "€", "force_binary": True}
- Source Test / Context: stdlib.py formats binary characters as `b'\x{ord(c):02x}'`.
- What Was Asserted: Assumed all non-printable or forced-binary characters can be represented as byte escape sequences.
- Bug Elicited: DEF_HEX_OVERFLOW. ord('€') is 8364 (0x20ac). Formatting with `:02x` produces `b'\x20ac'`, which Python parses as byte 0x20 followed by ASCII characters 'a' and 'c' (3 bytes), corrupting the character into an unintended sequence.

---

PUT: TreeValue

Example 1: Non-numeric string concatenation with +
- Source: tests/test_tree_value.py line 515 (test_to_first_arg)
- Harvested Input: {"kind": 0, "val": "hello", "op": 1, "extra": "test"}
- Source Test / Context: Parameterized test over FIRST_ARG including "__radd__".
- What Was Asserted: `assert not callable(getattr(TreeValue(1), "__radd__")(1))`
- Bug Elicited: TV_RADD_STR. When the TreeValue contains string text rather than digits, evaluating `"" + tv` raises `ValueError: invalid literal for int() with base 10: 'hello'` because `__radd__` unconditionally converts through `to_int()`.

Example 2: Equality comparison with None
- Source: tests/test_tree_value.py line 25 (test_tree_value_create)
- Harvested Input: {"kind": 0, "val": "hello", "op": 0, "extra": ""}
- Source Test / Context: Tests `TreeValue(value)` against primitive types str, bytes, int.
- What Was Asserted: `assert type_(tree_value) == value`
- Bug Elicited: TV_EQ_NONE. Evaluating `tv == None` raises `TypeError` because `TreeValue.__eq__` assumes the operand has a matching type interface and never handles NoneType.

---

PUT: _distance_norm

Example 1: Zero division on identical bounds
- Source: tests/test_constraints.py line 30
- Harvested Input: {"left": 0.0, "right": 0.0}
- Source Test / Context: Evaluates fitness of identical tree structures.
- What Was Asserted: `assert fitness == 0.0`
- Bug Elicited: NORM_ZERO_DIV. In `_distance_norm(left, right)`, when `left == right`, normalization against equal intervals attempts division by zero, raising unhandled ZeroDivisionError which was previously masked by outer fitness try/except blocks.

Example 2: Negative exponential overflow in sigmoid
- Source: src/fandango/constraints/comparison.py line 385 (_sigmoid docstring)
- Harvested Input: {"left": -1000.0, "right": 1000.0}
- Source Test / Context: Large distance normalization across genetic optimization steps.
- What Was Asserted: Assumed `2 * (_sigmoid(abs(dist)) - 0.5)` returns a valid float in [0, 1].
- Bug Elicited: SIGMOID_OVERFLOW. Passing extreme float distances or large integers triggers `OverflowError: math range error` in `math.exp(-x)`.

---

PUT: parse

Example 1: Descendant constraint infinite recursion
- Source: tests/test_parsing.py line 45
- Harvested Input: {"spec": "<start> ::= <expr>\n<expr> ::= <expr> '+' '1' | '1'", "constraint_str": "where <expr>..<other> == '1'"}
- Source Test / Context: Tests parsing of grammars containing constraint expressions.
- What Was Asserted: Assumed parser returns grammar and constraint objects.
- Bug Elicited: PARSE_DESC_RECUR. `check_constraints_existence_children` recursively visits child rules before memoizing visited nodes, triggering `RecursionError: maximum recursion depth exceeded` on recursive grammars.

Example 2: Empty constraint string index error
- Source: tests/test_constraints.py line 15
- Harvested Input: {"spec": "<start> ::= 'a'\n", "constraint_str": "   "}
- Source Test / Context: `get_constraint(constraint)` helper function passing raw string constraints.
- What Was Asserted: Assumed constraint list parsing handles any constraint string.
- Bug Elicited: PARSE_EMPTY_CONSTRAINT. Line 155 in `parse.py` executes `first_token = constraint.split()[0]`. When given a whitespace or empty constraint string, `split()` returns `[]` and raises `IndexError: list index out of range`.

---

PUT: DerivationTree

Example 1: Child parent reference hijacking during slice
- Source: tests/test_slices.py line 35 (test_slice_0)
- Harvested Input: {"child_text": "hello", "op": 0}
- Source Test / Context: Slicing derivation trees via `<start>[0]`.
- What Was Asserted: Assumed slice operations are non-destructive read operations.
- Bug Elicited: DT_SLICE_PARENT_HIJACK. `SliceTree` sets `child._parent = slice_tree` on the original tree's nodes in-place, corrupting the original tree's parent pointers and breaking subsequent tree navigation.

Example 2: Prefix slice assertion failure on root node
- Source: tests/test_tree.py line 85
- Harvested Input: {"child_text": "root_node", "op": 1}
- Source Test / Context: Extracting tree prefix paths from root derivation trees.
- What Was Asserted: Assumed `tree.prefix()` returns the prefix subtree.
- Bug Elicited: DT_PREFIX_SLICE. `tree.prefix()` contains an explicit `assert ref_tree.parent is not None`. Invoking prefix on a root node where parent is None crashes with unhandled AssertionError.
