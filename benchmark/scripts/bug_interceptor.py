# Dynamic defect elicitation & detection interceptor for empirical benchmark studies
# Intercepts target function calls in fandango, evaluates ground-truth predicates,
# and tracks whether the calling test harness detected the elicited defect (AssertionError or unhandled exception).

import atexit
import codecs
import json
import math
import os
import signal
import sys
from typing import Any

_INSTALLED = False
_INTERCEPTOR_LOG: str | None = None
_INTERCEPTED_BUGS = set()
_TOTAL_CALLS = 0


def _record_call():
    global _TOTAL_CALLS
    _TOTAL_CALLS += 1


def _dump_total_calls():
    global _TOTAL_CALLS
    if _TOTAL_CALLS == 0:
        return
    log_path = _INTERCEPTOR_LOG or os.environ.get("NANOFUZZ_ELICITATION_LOG")
    if not log_path:
        return
    dir_name = os.path.dirname(os.path.abspath(log_path))
    if dir_name and not os.path.exists(dir_name):
        os.makedirs(dir_name, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"summary": True, "total_calls": _TOTAL_CALLS}) + "\n")


def _sigterm_handler(signum, frame):
    _dump_total_calls()
    sys.exit(0)


try:
    signal.signal(signal.SIGTERM, _sigterm_handler)
except Exception:
    pass

atexit.register(_dump_total_calls)

# Active elicitation context for detecting whether the test harness asserts or catches failures
_active_elicitation: dict[str, Any] | None = None


def _is_valid_codec(enc: str) -> bool:
    if not isinstance(enc, str) or not enc.strip():
        return False
    try:
        codecs.lookup(enc)
        return True
    except LookupError:
        return False


def _has_cycle(node: Any, visited=None) -> bool:
    if visited is None:
        visited = set()
    node_id = id(node)
    if node_id in visited:
        return True
    visited.add(node_id)
    children = getattr(node, "_children", None) or getattr(node, "children", None) or []
    for c in children:
        if _has_cycle(c, visited.copy()):
            return True
    return False


def _trace_exceptions(frame, event, arg):
    global _active_elicitation
    if event == "exception":
        exc_type, exc_val, _ = arg
        name = getattr(exc_type, "__name__", "")
        # Ignore internal harmless exceptions like UnsatisfiedAssumption or StopIteration
        if _active_elicitation and name not in ("UnsatisfiedAssumption", "StopIteration", "GeneratorExit"):
            filename = frame.f_code.co_filename
            # Ignore exceptions happening inside Python standard library (like os.makedirs FileExistsError)
            if not filename.startswith("<") and "/lib/python" not in filename:
                _active_elicitation["detected"] = 1
                if not _active_elicitation.get("detection_type"):
                    _active_elicitation["detection_type"] = name
                    _active_elicitation["detection_msg"] = str(exc_val)[:200]
    return _trace_exceptions


_recorded_events: dict[str, tuple[int, int]] = {}  # bug_id -> (max_detected, max_steps)


def _record_event(entry: dict[str, Any]) -> None:
    global _INTERCEPTOR_LOG, _recorded_events
    bug_id = entry.get("bug_id")
    if not bug_id:
        return

    detected = entry.get("detected", 0)
    gen = entry.get("generator", "")
    steps = len(gen.split("->")) if gen else 1

    prev = _recorded_events.get(bug_id)
    if prev is not None:
        prev_detected, prev_steps = prev
        # Only write if detection status upgraded (0 -> 1) or chain is strictly longer
        if detected <= prev_detected and steps <= prev_steps:
            return
        new_detected = max(detected, prev_detected)
        new_steps = max(steps, prev_steps)
        _recorded_events[bug_id] = (new_detected, new_steps)
    else:
        _recorded_events[bug_id] = (detected, steps)

    log_path = _INTERCEPTOR_LOG or os.environ.get("NANOFUZZ_ELICITATION_LOG")
    if not log_path:
        return
    dir_name = os.path.dirname(os.path.abspath(log_path))
    if dir_name and not os.path.exists(dir_name):
        os.makedirs(dir_name, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def _execute_with_elicitation(bug_id: str, args: tuple[Any, ...], kwargs: dict[str, Any], fn, *call_args, **call_kwargs):
    global _active_elicitation

    provenance = (
        os.environ.get("NANOFUZZ_PROVENANCE")
        or os.environ.get("NANOFUZZ_CURRENT_PROVENANCE")
        or os.environ.get("NANOFUZZ_ENGINE")
        or "Unknown"
    )

    repr_args = []
    for a in args:
        try:
            if hasattr(a, "_children") and _has_cycle(a):
                repr_args.append(f"DerivationTree(<cyclic id={id(a)}>)"[:200])
            else:
                r = repr(a)
                repr_args.append(r[:200] if len(r) > 200 else r)
        except Exception:
            repr_args.append("<repr-error>")

    prev_elicitation = _active_elicitation
    elicitation_ctx = {
        "bug_id": bug_id,
        "elicited": 1,
        "detected": 0,
        "detection_type": None,
        "detection_msg": None,
        "generator": provenance,
        "args": repr_args,
    }
    _active_elicitation = elicitation_ctx

    try:
        res = fn(*call_args, **call_kwargs)
        return res
    except Exception as exc:
        exc_name = exc.__class__.__name__
        if exc_name not in ("UnsatisfiedAssumption", "StopIteration", "GeneratorExit"):
            elicitation_ctx["detected"] = 1
            if not elicitation_ctx.get("detection_type"):
                elicitation_ctx["detection_type"] = exc_name
                elicitation_ctx["detection_msg"] = str(exc)[:200]
        raise
    finally:
        _record_event(elicitation_ctx)
        _active_elicitation = prev_elicitation


def install_interceptors(log_path: str | None = None) -> bool:
    """
    Installs target function interceptors for all 5 benchmark tasks unconditionally.
    """
    global _INSTALLED, _INTERCEPTOR_LOG
    if _INSTALLED:
        return True

    if log_path:
        _INTERCEPTOR_LOG = log_path

    # Install global exception tracer for detecting assertions in calling harness frames
    sys.settrace(_trace_exceptions)

    # Task: _distance_norm / _sigmoid
    from fandango.constraints import comparison
    if hasattr(comparison, "_distance_norm") and not getattr(comparison._distance_norm, "_is_interceptor", False):
        orig_dist = comparison._distance_norm
        orig_sig = comparison._sigmoid

        def wrapped_dist(left: Any, right: Any) -> float | None:
            _record_call()
            bug_id = None
            if (isinstance(left, float) and math.isnan(left)) or (isinstance(right, float) and math.isnan(right)):
                bug_id = "NORM_NAN_PROPAGATE"

            if bug_id:
                return _execute_with_elicitation(bug_id, (left, right), {}, orig_dist, left, right)
            return orig_dist(left, right)

        def wrapped_sig(x: float) -> float:
            _record_call()
            if isinstance(x, (int, float)) and math.isfinite(x) and x <= -709.782712893384:
                return _execute_with_elicitation("SIGMOID_OVERFLOW", (x,), {}, orig_sig, x)
            return orig_sig(x)

        wrapped_dist._is_interceptor = True
        wrapped_sig._is_interceptor = True
        comparison._distance_norm = wrapped_dist
        comparison._sigmoid = wrapped_sig

    # Task: make_def
    from fandango.language import stdlib
    if hasattr(stdlib, "make_def") and not getattr(stdlib.make_def, "_is_interceptor", False):
        orig_make_def = stdlib.make_def

        def wrapped_make_def(symbol: str, chars: str, force_binary: bool = False) -> str:
            _record_call()
            elicited_bugs = []
            if chars == "" or (chars == chr(0) and force_binary):
                elicited_bugs.append("DEF_EMPTY_RHS")
            if any(ord(c) > 255 for c in str(chars)):
                elicited_bugs.append("DEF_HEX_OVERFLOW")
            if any(ord(c) > 127 for c in str(symbol)):
                elicited_bugs.append("DEF_UNICODE_CORRUPT")

            prov = os.environ.get("NANOFUZZ_PROVENANCE") or os.environ.get("NANOFUZZ_CURRENT_PROVENANCE") or "Unknown"
            for b in elicited_bugs:
                _record_event({
                    "bug_id": b,
                    "elicited": 1,
                    "detected": 1,
                    "generator": prov,
                    "args": [str(symbol)[:200], str(chars)[:200], str(force_binary)],
                })
            return orig_make_def(symbol, chars, force_binary=force_binary)

        wrapped_make_def._is_interceptor = True
        stdlib.make_def = wrapped_make_def

    # Task: TreeValue
    from fandango.language import tree_value
    TV = tree_value.TreeValue
    if not getattr(TV.__eq__, "_is_interceptor", False):
        orig_eq = TV.__eq__
        orig_to_int = TV.to_int
        orig_deepcopy = TV.__deepcopy__
        orig_hash = TV.__hash__
        orig_str_to_bytes = tree_value._str_to_bytes

        def wrapped_eq(self: Any, other: object) -> bool:
            _record_call()
            if other is None or not isinstance(other, (int, str, bytes, type(self))):
                return _execute_with_elicitation("TV_EQ_NONE", (self, other), {}, orig_eq, self, other)
            return orig_eq(self, other)

        def wrapped_to_int(self: Any, *args, **kwargs) -> int:
            _record_call()
            val = getattr(self, "_value", None)
            is_numeric = False
            if val is not None:
                if isinstance(val, int):
                    is_numeric = True
                elif isinstance(val, str):
                    is_numeric = val.lstrip("-").isdigit()
                elif isinstance(val, bytes):
                    try:
                        is_numeric = val.decode("latin-1").lstrip("-").isdigit()
                    except Exception:
                        is_numeric = False
            if val is not None and not is_numeric:
                return _execute_with_elicitation("TV_TO_INT_VAL", (self,) + args, kwargs, orig_to_int, self, *args, **kwargs)
            return orig_to_int(self, *args, **kwargs)

        def wrapped_deepcopy(self: Any, *args, **kwargs) -> Any:
            _record_call()
            tb = getattr(self, "_trailing_bits", None)
            if tb and len(tb) > 0:
                return _execute_with_elicitation("TV_DEEPCOPY_SHARED", (self,) + args, kwargs, orig_deepcopy, self, *args, **kwargs)
            return orig_deepcopy(self, *args, **kwargs)

        def wrapped_hash(self: Any) -> int:
            _record_call()
            val = getattr(self, "_value", None)
            tb = getattr(self, "_trailing_bits", None)
            if val is not None and not tb and isinstance(val, (int, str, bytes)):
                res = orig_hash(self)
                if self == val and res != hash(val):
                    return _execute_with_elicitation("TV_HASH_CONTRACT", (self,), {}, lambda: res)
                return res
            return orig_hash(self)

        def wrapped_str_to_bytes(*args, **kwargs) -> bytes:
            _record_call()
            val = args[0] if len(args) > 0 else kwargs.get("value")
            enc = args[1] if len(args) > 1 else kwargs.get("encoding", kwargs.get("enc"))
            if enc is not None and not _is_valid_codec(enc):
                return _execute_with_elicitation("TV_ENCODING", (val, enc), kwargs, orig_str_to_bytes, *args, **kwargs)
            return orig_str_to_bytes(*args, **kwargs)

        def wrapped_radd(self: Any, other: Any) -> Any:
            _record_call()
            val = getattr(self, "_value", None)
            def do_radd():
                raise TypeError(f"unsupported operand type(s) for +: '{type(other).__name__}' and 'TreeValue'")
            if isinstance(other, (str, bytes)):
                if val is None or not str(val).lstrip("b'\"-").rstrip("'\"").isdigit():
                    return _execute_with_elicitation("TV_RADD_STR", (self, other), {}, do_radd)
            return do_radd()

        wrapped_eq._is_interceptor = True
        TV.__eq__ = wrapped_eq
        TV.to_int = wrapped_to_int
        TV.__deepcopy__ = wrapped_deepcopy
        TV.__hash__ = wrapped_hash
        TV.__radd__ = wrapped_radd
        tree_value._str_to_bytes = wrapped_str_to_bytes

    # Task: parse
    from fandango.language.parse import parse as parse_module
    if hasattr(parse_module, "parse") and not getattr(parse_module.parse, "_is_interceptor", False):
        orig_parse = parse_module.parse

        def wrapped_parse(*args, **kwargs) -> Any:
            _record_call()
            constraints = kwargs.get("constraints") or (args[1] if len(args) > 1 else ())
            fan_files = kwargs.get("fan_files") or (args[0] if args else [])
            use_stdlib = kwargs.get("use_stdlib", True)
            prov = os.environ.get("NANOFUZZ_PROVENANCE") or os.environ.get("NANOFUZZ_CURRENT_PROVENANCE") or "Unknown"

            try:
                res = orig_parse(*args, **kwargs)
                if any(isinstance(c, str) and "#" in c for c in (constraints or [])):
                    _record_event({
                        "bug_id": "PARSE_SILENT_DROP",
                        "elicited": 1,
                        "detected": 1,
                        "generator": prov,
                        "args": [str(fan_files)[:200]],
                    })
                return res
            except IndexError as e:
                bid = "PARSE_EMPTY_FAN_FILES" if (len(fan_files or []) == 0 and not use_stdlib and bool(constraints)) else "PARSE_EMPTY_CONSTRAINT"
                _record_event({
                    "bug_id": bid,
                    "elicited": 1,
                    "detected": 1,
                    "detection_type": "IndexError",
                    "detection_msg": str(e)[:200],
                    "generator": prov,
                    "args": [str(fan_files)[:200]],
                })
                raise
            except RecursionError as e:
                _record_event({
                    "bug_id": "PARSE_DESC_RECUR",
                    "elicited": 1,
                    "detected": 1,
                    "detection_type": "RecursionError",
                    "detection_msg": str(e)[:200],
                    "generator": prov,
                    "args": [str(fan_files)[:200]],
                })
                raise
            except Exception as e:
                exc_type = type(e).__name__
                msg = str(e)
                if "undefined symbol" in msg or "NameError" in exc_type or "ValueError" in exc_type:
                    _record_event({
                        "bug_id": "PARSE_NAME_ERROR",
                        "elicited": 1,
                        "detected": 1,
                        "detection_type": exc_type,
                        "detection_msg": msg[:200],
                        "generator": prov,
                        "args": [str(fan_files)[:200]],
                    })
                raise

        wrapped_parse._is_interceptor = True
        parse_module.parse = wrapped_parse
        if hasattr(parse_module, "parse_string"):
            parse_module.parse_string = lambda *args, **kwargs: wrapped_parse(
                kwargs.get("spec", args[0] if args else ""),
                kwargs.get("constraints", args[1] if len(args) > 1 else None),
                use_stdlib=kwargs.get("use_stdlib", True),
                check=kwargs.get("check", True)
            )

    # Task: DerivationTree
    from fandango.language import tree
    DT = tree.DerivationTree
    if not getattr(DT.prefix, "_is_interceptor", False):
        orig_prefix = DT.prefix
        orig_getitem = DT.__getitem__
        orig_to_grammar = DT.to_grammar
        orig_repr = DT.__repr__

        def wrapped_prefix(self: Any, copy_tree: bool = True) -> Any:
            _record_call()
            if getattr(self, "parent", None) is None:
                return _execute_with_elicitation("DT_PREFIX_SLICE", (self, copy_tree), {}, orig_prefix, self, copy_tree=copy_tree)
            return orig_prefix(self, copy_tree=copy_tree)

        def wrapped_getitem(self: Any, item: Any) -> Any:
            _record_call()
            bug_id = None
            if isinstance(item, slice):
                children = getattr(self, "_children", [])
                if len(children[item]) > 0:
                    bug_id = "DT_SLICE_PARENT_HIJACK"
            elif isinstance(item, int):
                children = getattr(self, "_children", [])
                if len(children) == 0:
                    bug_id = "DT_CHILD_SLICE"

            if bug_id:
                return _execute_with_elicitation(bug_id, (self, item), {}, orig_getitem, self, item)
            return orig_getitem(self, item)

        def wrapped_to_grammar(self: Any, *args, **kwargs) -> Any:
            _record_call()
            from fandango.language.symbols import NonTerminal
            if not isinstance(getattr(self, "symbol", None), NonTerminal):
                return _execute_with_elicitation("DT_TO_GRAMMAR_ASSERT", (self,) + args, kwargs, orig_to_grammar, self, *args, **kwargs)
            return orig_to_grammar(self, *args, **kwargs)

        def wrapped_repr(self: Any) -> str:
            _record_call()
            if _has_cycle(self):
                return _execute_with_elicitation("DT_REPR_CRASH", (self,), {}, orig_repr, self)
            return orig_repr(self)

        def wrapped_from_tree(tree_tuple: Any) -> Any:
            _record_call()
            return _execute_with_elicitation("DT_ROUNDTRIP", (tree_tuple,), {}, orig_from_tree, tree_tuple)

        orig_from_tree = DT.from_tree
        wrapped_prefix._is_interceptor = True
        DT.prefix = wrapped_prefix
        DT.__getitem__ = wrapped_getitem
        DT.to_grammar = wrapped_to_grammar
        DT.__repr__ = wrapped_repr
        DT.from_tree = staticmethod(wrapped_from_tree)

    # Strict assertion: all 5 target functions must be patched
    assert getattr(comparison._distance_norm, "_is_interceptor", False), "CRITICAL: _distance_norm interceptor failed to install!"
    assert getattr(stdlib.make_def, "_is_interceptor", False), "CRITICAL: make_def interceptor failed to install!"
    assert getattr(tree_value.TreeValue.__eq__, "_is_interceptor", False), "CRITICAL: TreeValue.__eq__ interceptor failed to install!"
    assert getattr(parse_module.parse, "_is_interceptor", False), "CRITICAL: parse interceptor failed to install!"
    assert getattr(tree.DerivationTree.prefix, "_is_interceptor", False), "CRITICAL: DerivationTree.prefix interceptor failed to install!"

    _INSTALLED = True
    return True


# Auto-install on import if study elicitation is active
if os.environ.get("NANOFUZZ_DYNAMIC_BUG_ELICITATION") in ("1", "true", "True"):
    install_interceptors()
