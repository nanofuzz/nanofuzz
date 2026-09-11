import importlib.util
import sys
import os
import io
import json
import struct
import logging
import tempfile
import traceback
import re
import uuid
import ctypes
import threading
from contextlib import redirect_stdout
from typing import Any, Literal, List, Tuple, Union, TypedDict, NotRequired

try:
    import json5
    import coverage
except ModuleNotFoundError as e:
    print(f"ERROR {e}")
    exit(3)


class CollectOptions(TypedDict):
    coverageData: NotRequired[Literal[True]]
    debugData: NotRequired[Literal[True]]


class RunnerInput(TypedDict):
    args: List[Any]
    seq: int
    timeout: NotRequired[int]
    collect: NotRequired[CollectOptions]


class RunnerValueResult(TypedDict):
    tag: Literal["value"]
    value: Any
    seq: int
    # lines executed by this call
    coverageData: NotRequired[dict[str, List[int]]]
    # arcs taken by this call
    coverageArcs: NotRequired[dict[str, List[List[int]]]]
    # static coverage data
    staticCoverage: NotRequired[dict[str, dict[str, List]]]


class RunnerErrorResult(TypedDict):
    tag: Literal["error"]
    name: str
    message: str
    stack: NotRequired[str]
    source: Literal["put", "host"]
    seq: int
    # lines executed by this call
    coverageData: NotRequired[dict[str, List[int]]]
    # arcs taken by this call
    coverageArcs: NotRequired[dict[str, List[List[int]]]]
    # static coverage data
    staticCoverage: NotRequired[dict[str, dict[str, List]]]


class RunnerSkipResult(TypedDict):
    tag: Literal["skip"]
    message: str
    seq: int
    # lines executed by this call
    coverageData: NotRequired[dict[str, List[int]]]
    # arcs taken by this call
    coverageArcs: NotRequired[dict[str, List[List[int]]]]
    # static coverage data
    staticCoverage: NotRequired[dict[str, dict[str, List]]]


class RunnerTimeoutResult(TypedDict):
    tag: Literal["timeout"]
    seq: int
    # lines executed by this call
    coverageData: NotRequired[dict[str, List[int]]]
    # arcs taken by this call
    coverageArcs: NotRequired[dict[str, List[List[int]]]]
    # static coverage data
    staticCoverage: NotRequired[dict[str, dict[str, List]]]


type RunnerResult = Union[RunnerValueResult,
                          RunnerErrorResult, RunnerSkipResult, RunnerTimeoutResult]


pid = os.getpid()


class HostHeartbeat:
    """Sends periodic startup heartbeat messages to the parent process.
    Capped at max_heartbeats (default 60 = 1 minute total allowance).
    Runs as a daemon thread and stops when stop() is called.
    """

    def __init__(self, interval_sec: float = 1.0, max_heartbeats: int = 60):
        self.interval = interval_sec
        self.max_heartbeats = max_heartbeats
        self.heartbeat_count = 0
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        def _worker():
            while not self.stop_event.wait(timeout=self.interval):
                if self.heartbeat_count >= self.max_heartbeats:
                    logging.debug(
                        f"[{pid}] Max heartbeats ({self.max_heartbeats}) reached during startup")
                    break
                self.heartbeat_count += 1
                try:
                    send_msg("HEART")
                except (BrokenPipeError, OSError):
                    break

        self.thread = threading.Thread(target=_worker, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()


class PutTimeoutException(Exception):
    """Raised in the main thread when a test execution times out."""
    pass


def _raise_async_exception(target_thread_id: int, exception_cls: type) -> None:
    """Injects an exception asynchronously into a CPython thread."""
    ret = ctypes.pythonapi.PyThreadState_SetAsyncExc(
        ctypes.c_ulong(target_thread_id),
        ctypes.py_object(exception_cls)
    )
    if ret > 1:
        # Revert if more than one thread was affected
        ctypes.pythonapi.PyThreadState_SetAsyncExc(
            ctypes.c_ulong(target_thread_id), None)


def call_with_timeout(fn: Any, args: List[Any], timeout_ms: int) -> Any:
    """Executes fn(*args) with an in-process timeout across Mac, Linux, and Windows."""
    if not timeout_ms or timeout_ms <= 0:
        return fn(*args)

    main_thread_id = threading.get_ident()
    timer = threading.Timer(
        timeout_ms / 1000.0,
        _raise_async_exception,
        args=(main_thread_id, PutTimeoutException)
    )
    timer.start()
    try:
        return fn(*args)
    finally:
        timer.cancel()


def loadPythonFn(filename: str, modulename: str, fn: str) -> Tuple[Union[RunnerErrorResult, None], Any]:
    rootDir = os.path.dirname(filename)
    if rootDir not in sys.path:
        sys.path.insert(0, rootDir)

    spec = importlib.util.spec_from_file_location(modulename, filename)
    if spec is None:
        return (RunnerErrorResult(
            tag="error",
            name="PythonRunnerHostError",
            message=f"Could not import python module: {filename}",
            source="host",
            seq=-1
        ), None)
    module = importlib.util.module_from_spec(spec)

    try:
        sys.modules[modulename] = module
        with redirect_stdout(io.StringIO()) as f:
            if spec.loader is None:
                return (RunnerErrorResult(
                    tag="error",
                    name="PythonRunnerHostError",
                    message=f"Could not load python module: {filename}",
                    source="host",
                    seq=-1
                ), None)
            spec.loader.exec_module(module)
        return (None, getattr(module, fn))
    except Exception as e:
        return (RunnerErrorResult(
            tag="error",
            name="PythonPutLoadError",
            message=str(e),
            source="put",
            stack=traceback.format_exc(),
            seq=-1
        ), None)


def get_inputs() -> RunnerInput:
    logging.debug(f"[{pid}] Waiting for input")
    while True:
        # Read the 4-byte length header
        header = sys.stdin.buffer.read(4)
        if not header:
            break
        length = struct.unpack('>I', header)[0]
        logging.debug(f"[{pid}]  - Incoming input of length {length}")

        # Read exactly that many bytes
        payload = sys.stdin.buffer.read(length).decode('utf-8')
        logging.debug(f"[{pid}]  - With value {payload}")

        # De-serialize arguments for calling the function
        input: RunnerInput = json5.loads(payload)
        logging.debug(f"[{pid}]  - Parsed ok")

        return input
    raise Exception("Unreachable path")


def measured_key(data, filename: str) -> Union[str, None]:
    """
    Returns the key under which coverage.py recorded `filename`, or None if
    the file was not measured.

    Note: `CoverageData.lines()`/`.arcs()` return None (not an error) when
    `filename` does not exactly match the recorded key, so fall back to
    matching against the measured files by resolved path.
    """
    if filename in data.measured_files():
        return filename
    target = os.path.normcase(os.path.realpath(filename))
    for measured in data.measured_files():
        if os.path.normcase(os.path.realpath(measured)) == target:
            return measured
    return None


def coverage_lines(cov: coverage.Coverage, filename: str) -> List[int]:
    """
    Returns the sorted line numbers executed since the last `cov.erase()`.
    """
    data = cov.get_data()
    key = measured_key(data, filename)
    return sorted(data.lines(key) or []) if key else []


def coverage_arcs(cov: coverage.Coverage, filename: str) -> List[List[int]]:
    """
    Returns the sorted arcs (line transitions) taken since the last
    `cov.erase()`, as `[from, to]` pairs.
    """
    data = cov.get_data()
    key = measured_key(data, filename)
    if key is None:
        return []
    return sorted([src, dest] for src, dest in (data.arcs(key) or []))


def report_lines(entry: dict) -> List[int]:
    """
    Returns the executable lines of a JSON report entry. coverage.py splits
    these into executed and missing, whose union is every line it can measure.
    """
    return sorted(set(entry.get("executed_lines", []))
                  | set(entry.get("missing_lines", [])))


def report_branch_arcs(entry: dict) -> List[List[int]]:
    """
    Returns every branch arc of a JSON report entry as `[from, to]` pairs,
    taken or not.

    Only lines with more than one exit contribute arcs here, so this is exactly
    the set of branches
    """
    arcs = {tuple(arc) for arc in entry.get("executed_branches", [])}
    arcs |= {tuple(arc) for arc in entry.get("missing_branches", [])}
    return sorted([src, dest] for src, dest in arcs)


def static_functions(entry: dict) -> List[dict]:
    """
    Returns each function in a JSON report entry as
    `{name, declLine, startLine, endLine, lines}`. Keys are camelCase because
    this is wire format, consumed by the TypeScript runner.

    `declLine` is the `def` line. `lines` holds the function's own executable
    lines: coverage.py attributes lines per function, so lines belonging to a
    nested function are not charged to its parent. `startLine`/`endLine`
    bound those lines.

    Methods are named `Class.method`. coverage.py also reports the module-level
    code as a region with an empty name; that is not a function, so it is
    skipped.
    """
    functions: List[dict] = []
    for name, fn in entry.get("functions", {}).items():
        lines = report_lines(fn)
        if not name or not lines:
            continue
        functions.append({
            "name": name,
            "declLine": fn.get("start_line", lines[0]),
            "startLine": lines[0],
            "endLine": lines[-1],
            "lines": lines,
        })
    return sorted(functions, key=lambda f: (f["startLine"], f["endLine"]))


def static_branches(entry: dict) -> List[dict]:
    """
    Returns the branch points of a JSON report entry: each line with more than
    one exit, and every destination it can reach.

    Each destination carries both `dest`, the raw arc target used to match
    against the executed arcs from `coverage_arcs`, and `line`, where to
    display it. coverage.py uses non-positive `dest` values to mean "left the
    enclosing scope" (e.g. an `if` whose body returns); those have no line of
    their own, so they display on the branch line.
    """
    exits_by_line: dict = {}
    for src, dest in report_branch_arcs(entry):
        exits_by_line.setdefault(src, []).append(dest)

    return [
        {
            "line": line,
            "exits": [
                {"dest": dest, "line": dest if dest > 0 else line}
                for dest in sorted(exits_by_line[line])
            ],
        }
        for line in sorted(exits_by_line)
    ]


def static_coverage(cov: coverage.Coverage, filename: str) -> dict:
    """
    Returns the PUT's static coverage structure: every executable line, every
    function, and every branch point. These are the denominators for coverage
    and are stable for the whole run, so the caller sends them once rather than
    with every result.

    This comes from coverage.py's own JSON report, which reports branch arcs
    and per-function line attribution directly. It gives each of those as an
    `executed_*`/`missing_*` pair whose union is the full static set; no test
    has run yet, so in practice everything lands in `missing_*`.
    """
    # coverage.py reports branch data only once its data is arc-flavored, which
    # normally happens when the first arcs are recorded. Nothing has run yet at
    # startup, so mark the data explicitly, or the report omits all branches.
    # `run_put` erases this before measuring the first test.
    cov.get_data().add_arcs({filename: set()})

    empty = {"executable": [], "functions": [], "branches": []}

    # `json_report` writes to a path rather than returning the report, and
    # stdout is reserved for the protocol, so route it through a temp file.
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            outfile = os.path.join(tmpdir, "coverage.json")
            cov.json_report(morfs=[filename], outfile=outfile)
            with open(outfile, encoding="utf-8") as f:
                report = json.load(f)
    except coverage.CoverageException as e:
        logging.debug(f"[{pid}] coverage.py could not analyze {filename}: {e}")
        return empty

    # Only `filename` was reported, so there is at most one entry
    files = report.get("files", {})
    if not files:
        logging.debug(
            f"[{pid}] coverage.py reported no coverage data for {filename}")
        return empty
    entry = next(iter(files.values()))

    return {
        "executable": report_lines(entry),
        "functions": static_functions(entry),
        "branches": static_branches(entry),
    }


def is_under(root: str, path: str) -> bool:
    """
    Returns whether `path` is `root` or sits beneath it.
    """
    root = os.path.normcase(root).rstrip(os.sep)
    path = os.path.normcase(path)
    return path == root or path.startswith(root + os.sep)


def program_files(filename: str) -> List[str]:
    """
    Returns the files the program under test is made of: `filename`, plus every
    module imported from `filename`'s own directory tree.

    Must be called after the PUT is loaded, so that its imports have run.
    """
    root = os.path.dirname(filename)
    files = {filename}
    for module in list(sys.modules.values()):
        modfile = getattr(module, "__file__", None)
        if not modfile or os.path.splitext(modfile)[1] != ".py":
            continue
        modfile = os.path.realpath(modfile)
        if is_under(root, modfile):
            files.add(modfile)
    return sorted(files)


def transform_arg(val: Any, hint: Any) -> Any:
    if val is None:
        return None

    if hint == "uuid":
        if isinstance(val, str):
            if len(val) in (32, 36):
                try:
                    return uuid.UUID(val)
                except ValueError:
                    return val
        return val

    if hint == "bytes":
        if isinstance(val, (bytes, bytearray)):
            return val
        if isinstance(val, list):
            return bytes(val)
        if isinstance(val, str):
            return val.encode("latin1")
        return val

    if hint == "number":
        if isinstance(val, str):
            try:
                f = float(val)
                if f.is_integer() and not ("." in val or "e" in val.lower() or val.lower() in ("nan", "inf", "-inf", "infinity", "-infinity")):
                    return int(f)
                return f
            except ValueError:
                return val
        return val

    if hint == "default" or not isinstance(hint, dict):
        return val

    kind = hint.get("kind")

    if kind == "array" and isinstance(val, list):
        elem_hint = hint.get("element", "default")
        return [transform_arg(item, elem_hint) for item in val]

    if kind == "set" and isinstance(val, (list, set, frozenset)):
        elem_hint = hint.get("element", "default")
        items = [transform_arg(item, elem_hint) for item in val]
        return frozenset(items) if hint.get("frozenset") else set(items)

    if kind == "tuple" and (isinstance(val, tuple) or isinstance(val, list)):
        elem_hints = hint.get("elements", [])
        transformed = [
            transform_arg(item, elem_hints[i]) if i < len(elem_hints) else item
            for i, item in enumerate(val)
        ]
        return tuple(transformed)

    if kind == "dictionary" and isinstance(val, dict):
        key_hint = hint.get("key", "default")
        val_hint = hint.get("value", "default")
        return {
            transform_arg(k, key_hint): transform_arg(v, val_hint)
            for k, v in val.items()
        }

    if kind == "object" and isinstance(val, dict):
        field_hints = hint.get("fields", {})
        return {
            k: transform_arg(v, field_hints[k]) if k in field_hints else v
            for k, v in val.items()
        }

    if kind == "union":
        arms = hint.get("arms", [])
        if isinstance(val, str) and any(
            arm == "uuid" or (isinstance(arm, dict)
                              and arm.get("kind") == "uuid")
            for arm in arms
        ):
            try:
                return uuid.UUID(val)
            except ValueError:
                pass
        for arm in arms:
            transformed = transform_arg(val, arm)
            if isinstance(transformed, (uuid.UUID, bytes, bytearray)) or transformed != val:
                return transformed
        return val

    return val


def sanitize_output(obj: Any) -> Any:
    if isinstance(obj, (bytes, bytearray)):
        return list(obj)
    if isinstance(obj, (set, frozenset, tuple, list)):
        return [sanitize_output(x) for x in obj]
    if isinstance(obj, uuid.UUID):
        return str(obj)
    if isinstance(obj, dict):
        res = {}
        for k, v in obj.items():
            s_k = sanitize_output(k)
            if isinstance(s_k, list):
                s_k = str(s_k)
            elif not isinstance(s_k, (str, int, float, bool)) and s_k is not None:
                s_k = str(s_k)
            res[s_k] = sanitize_output(v)
        return res
    return obj


def json5_default(obj: Any) -> Any:
    if isinstance(obj, (bytes, bytearray)):
        return list(obj)
    if isinstance(obj, (set, frozenset)):
        return list(obj)
    if isinstance(obj, uuid.UUID):
        return str(obj)
    raise TypeError(
        f"Object of type {type(obj).__name__} is not JSON5 serializable")


def run_put(input: RunnerInput, filename: str, fnname: str, fn: Any, cov: coverage.Coverage, covInfo: dict[str, dict[str, List]]) -> RunnerResult:
    collect_options = input.get("collect")
    if collect_options is None:
        coverage_enabled = True
        debug_enabled = False
    else:
        coverage_enabled = bool(collect_options.get("coverageData"))
        debug_enabled = bool(collect_options.get("debugData"))

    if debug_enabled:
        if not logging.getLogger().handlers:
            logging.basicConfig(
                filename='nanofuzz_python_debug.log', level=logging.DEBUG)
        else:
            logging.getLogger().setLevel(logging.DEBUG)
        logging.debug(f"[{pid}] Running function '{fnname}' for {input}")
    else:
        logging.getLogger().setLevel(logging.CRITICAL + 1)

    timeout_ms = input.get("timeout", 0)

    if coverage_enabled:
        # cov.erase() is too expensive. Seems like only erasing the data works too
        cov.get_data().erase()
        cov.start()

    error = None
    skip = None
    is_timeout = False
    value = None

    args = list(input["args"])
    type_hints = input.get("typeHints", [])
    for i in range(min(len(args), len(type_hints))):
        args[i] = transform_arg(args[i], type_hints[i])

    try:
        with redirect_stdout(io.StringIO()) as f:
            # If fn is a Hypothesis-wrapped test, bypass Hypothesis
            # and call the original underlying function
            if hasattr(fn, 'hypothesis') and hasattr(fn.hypothesis, 'inner_test'):
                # Unwrap Hypothesis test function
                value = call_with_timeout(
                    fn.hypothesis.inner_test, args, timeout_ms)
            else:
                # Not Hypothesis; call directly
                value = call_with_timeout(fn, args, timeout_ms)
    except PutTimeoutException:
        is_timeout = True
    except Exception as e:
        if e.__class__.__name__ == "UnsatisfiedAssumption":
            skip = e
        else:
            error = e
    finally:
        if coverage_enabled:
            cov.stop()

    # Read coverage after stopping: a failing or timing out input still covers lines
    coverageData = {}
    coverageArcs = {}
    if coverage_enabled:
        for file in cov.get_data().measured_files():
            lines = coverage_lines(cov, file)
            if not lines:
                continue
            if file not in covInfo:
                covInfo[file] = static_coverage(cov, file)
            coverageData[file] = lines
            coverageArcs[file] = coverage_arcs(cov, file)

    if is_timeout:
        return RunnerTimeoutResult(
            tag="timeout",
            seq=input["seq"],
            coverageData=coverageData,
            coverageArcs=coverageArcs,
            staticCoverage=covInfo if coverage_enabled else {}
        )

    if skip is not None:
        return RunnerSkipResult(
            tag="skip",
            message=str(skip),
            seq=input["seq"],
            coverageData=coverageData,
            coverageArcs=coverageArcs,
            staticCoverage=covInfo if coverage_enabled else {}
        )

    if error is not None:
        return RunnerErrorResult(
            tag="error",
            name="PythonPutError",
            message=str(error),
            source="put",
            stack="".join(traceback.format_exception(error)),
            seq=input["seq"],
            coverageData=coverageData,
            coverageArcs=coverageArcs,
            staticCoverage=covInfo if coverage_enabled else {}
        )

    return RunnerValueResult(
        tag="value",
        value=sanitize_output(value),
        seq=input["seq"],
        coverageData=coverageData,
        coverageArcs=coverageArcs,
        staticCoverage=covInfo if coverage_enabled else {}
    )


def put_result(result: RunnerResult) -> None:
    logging.debug(f"[{pid}] Returning result")
    send_msg(result)
    logging.debug(f"[{pid}]  - Result returned")


def send_msg(data: Union[RunnerResult, str, dict[str, Any]]) -> None:
    msg = json5.dumps(data, default=json5_default).encode('utf-8')
    logging.debug(f"[{pid}]  - Writing {len(msg)} bytes: {msg}")
    sys.stdout.buffer.write(struct.pack(
        '>I', len(msg)))  # payload size
    sys.stdout.buffer.write(msg)  # payload
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(
            "Usage: python PythonRunnerHost.py <filename.py> <module_name> <function_name>")
        sys.exit(2)

    # Arguments for loading the function
    filename = sys.argv[1]
    modulename = sys.argv[2]
    fnname = sys.argv[3]

    # Normalize the path: coverage.py keys its data by the resolved filename,
    # and `include` patterns must match it.
    filename = os.path.realpath(filename)

    # Start heartbeat thread during coverage initialization, module import, and static analysis
    hb = HostHeartbeat(interval_sec=1.0, max_heartbeats=60)
    hb.start()

    try:
        # One in-memory coverage instance for the whole run
        cov = coverage.Coverage(
            include=[os.path.join(os.path.dirname(filename), "**", "*.py")], branch=True, data_file=None)

        # Try to load the function: either results in a RunnerErrorResult
        # or a callable function
        logging.debug(f"[{pid}] Loading function '{fnname}' in {filename}")
        [loadError, fn] = loadPythonFn(filename, modulename, fnname)
        if (loadError is not None):
            logging.debug(f"[{pid}]  - Unable to load")
        else:
            logging.debug(f"[{pid}]  - Loaded function")

        # Static analysis of the program: the executable lines, functions, and
        # branches of every file it is made of.
        coverageInfo = {file: static_coverage(cov, file)
                        for file in program_files(filename)}
        logging.debug(
            f"[{pid}] Analyzed {len(coverageInfo)} file(s) of the program under test")

        # Change cwd from the extension to that of the Python script
        os.chdir(os.path.dirname(filename))

        # Pre-warm the coverage machinery. The first `cov.start()` installs the
        # tracer, which costs far more than a steady-state call and can push the
        # first test over `fnTimeout` on its own -- and because a timeout kills
        # the host, the respawned host pays it again, cascading into a run where
        # every test times out.
        #
        # This must happen *before* the handshake below, so the cost is charged to
        # the caller's startup budget (seconds) rather than its per-test budget
        # (~100ms). Nothing runs between start and stop, so no coverage is
        # recorded, and the final erase leaves the data empty for the first test.
        cov.get_data().erase()
        cov.start()
        cov.stop()
        cov.get_data().erase()
        logging.debug(f"[{pid}] Pre-warmed coverage tracer")
    finally:
        hb.stop()

    # Ready for inputs
    send_msg("READY")
    logging.debug(f"[{pid}] Sent READY message")

    # Send the static coverage info once
    send_msg(coverageInfo)
    logging.debug(
        f"[{pid}] Sent coverageInfo for {len(coverageInfo)} file(s)")

    # Start the run loop
    while True:
        logging.debug(f"[{pid}] Top of main loop")
        if (loadError == None):
            put_result(run_put(get_inputs(), filename, fnname, fn,
                       cov, coverageInfo))  # Call the put
        else:
            get_inputs()
            put_result(loadError)  # Return the load error
