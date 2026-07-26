import importlib.util
import sys
import os
import io
import json
import struct
import logging
import tempfile
import traceback
from contextlib import redirect_stdout
from typing import Any, Literal, List, Union, TypedDict, NotRequired

try:
    import json5
    import coverage
except ModuleNotFoundError as e:
    print(f"ERROR {e}")
    exit(3)


class RunnerInput(TypedDict):
    args: List[any]
    seq: int


class RunnerValueResult(TypedDict):
    tag: Literal["value"]
    value: Any
    seq: int
    coverageData: NotRequired[List[int]]        # lines executed by this call
    coverageArcs: NotRequired[List[List[int]]]  # arcs taken by this call


class RunnerErrorResult(TypedDict):
    tag: Literal["error"]
    name: str
    message: str
    stack: NotRequired[str]
    source: Literal["put", "host"]
    seq: int
    coverageData: NotRequired[List[int]]        # lines executed by this call
    coverageArcs: NotRequired[List[List[int]]]  # arcs taken by this call


type RunnerResult = Union[RunnerValueResult, RunnerErrorResult]


def loadPythonFn(filename: str, modulename: str, fn: str) -> Union[RunnerErrorResult, None]:
    spec = importlib.util.spec_from_file_location(modulename, filename)
    if spec is None:
        return [RunnerErrorResult(
            tag="error",
            name="PythonRunnerHostError",
            message=f"Could not import python module: {filename}",
            source="host",
            seq=-1
        ), None]
    module = importlib.util.module_from_spec(spec)

    try:
        sys.modules[modulename] = module
        with redirect_stdout(io.StringIO()) as f:
            spec.loader.exec_module(module)
        return [None, getattr(module, fnname)]
    except Exception as e:
        return [RunnerErrorResult(
            tag="error",
            name="PythonPutLoadError",
            message=str(e),
            source="put",
            stack=traceback.format_exc(),
            seq=-1
        ), None]


def get_inputs() -> RunnerInput:
    logging.debug("Waiting for input")
    while True:
        # Read the 4-byte length header
        header = sys.stdin.buffer.read(4)
        if not header:
            break
        length = struct.unpack('>I', header)[0]
        logging.debug(f" - Incoming input of length {length}")

        # Read exactly that many bytes
        payload = sys.stdin.buffer.read(length).decode('utf-8')
        logging.debug(f" - With value {payload}")

        # De-serialize arguments for calling the function
        input: RunnerInput = json5.loads(payload)
        logging.debug(f" - Parsed ok")

        return input


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

    Arcs are how coverage.py records branch coverage: a branch line with two
    possible exits contributes one arc per exit actually taken, so comparing
    these against `static_branches` yields which branches were covered.
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
    the set of branches -- unlike `coverage_arcs`, which also reports the
    ordinary line-to-line transitions that are not branches.
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

    # `json_report` writes to a path rather than returning the report, and
    # stdout is reserved for the protocol, so route it through a temp file.
    with tempfile.TemporaryDirectory() as tmpdir:
        outfile = os.path.join(tmpdir, "coverage.json")
        cov.json_report(morfs=[filename], outfile=outfile)
        with open(outfile, encoding="utf-8") as f:
            report = json.load(f)

    # Only `filename` was reported, so there is at most one entry
    files = report.get("files", {})
    if not files:
        logging.debug(f"coverage.py reported no coverage data for {filename}")
        return {"file": filename, "executable": [],
                "functions": [], "branches": []}
    entry = next(iter(files.values()))

    return {
        "file": filename,
        "executable": report_lines(entry),
        "functions": static_functions(entry),
        "branches": static_branches(entry),
    }


def run_put(input: RunnerInput, filename: str, cov: coverage.Coverage) -> RunnerResult:
    logging.debug(f"Running function '{fnname}' for {input}")

    # Measure only the call itself: module-level code already ran at load
    cov.erase()
    cov.start()
    error = None
    value = None
    try:
        with redirect_stdout(io.StringIO()) as f:
            value = fn(*input["args"])
    except Exception as e:
        error = e
    finally:
        cov.stop()

    # Read coverage after stopping: a failing input still covers lines, and
    # those inputs are often the interesting ones.
    coverageData = coverage_lines(cov, filename)
    coverageArcs = coverage_arcs(cov, filename)

    if error is not None:
        return RunnerErrorResult(
            tag="error",
            name="PythonPutError",
            message=str(error),
            source="put",
            stack="".join(traceback.format_exception(
                type(error), error, error.__traceback__)),
            seq=input["seq"],
            coverageData=coverageData,
            coverageArcs=coverageArcs
        )

    return RunnerValueResult(
        tag="value",
        value=value,
        seq=input["seq"],
        coverageData=coverageData,
        coverageArcs=coverageArcs
    )


def put_result(result: RunnerResult) -> None:
    logging.debug(f"Returning result")
    send_msg(result)
    logging.debug(f" - Result returned")


def send_msg(data: RunnerResult):
    msg = json5.dumps(data).encode('utf-8')
    logging.debug(f" - Writing {len(msg)} bytes: {msg}")
    sys.stdout.buffer.write(struct.pack(
        '>I', len(msg)))  # payload size
    sys.stdout.buffer.write(msg)  # payload
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    logging.basicConfig(filename='debug.log',
                        level=logging.DEBUG)  # !!!!!!!!!!

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

    # One in-memory coverage instance for the whole run. `branch=True` makes
    # coverage.py record arcs (line transitions) in addition to lines, which
    # is what both branch and per-function coverage are derived from.
    cov = coverage.Coverage(include=[filename], branch=True, data_file=None)

    # Static analysis of the PUT: the executable lines, functions, and branches
    coverageInfo = static_coverage(cov, filename)

    # Try to load the function: either results in a RunnerErrorResult
    # or a callable function
    logging.debug(f"Loading function '{fnname}' in {filename}")
    [loadError, fn] = loadPythonFn(filename, modulename, fnname)
    if (loadError):
        logging.debug(" - Unable to load")
    else:
        logging.debug(" - Loaded function")

    # Change cwd from the extension to that of the Python script
    os.chdir(os.path.dirname(filename))

    # Ready for inputs
    msg = "READY".encode('utf-8')
    sys.stdout.buffer.write(msg)
    sys.stdout.buffer.flush()
    logging.debug(f"Sent READY message (length {len(msg)})")

    # Send the static coverage info once
    msg = json5.dumps(coverageInfo).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('>I', len(msg)))  # payload size
    sys.stdout.buffer.write(msg)  # payload
    sys.stdout.buffer.flush()
    logging.debug(
        f"Sent coverageInfo ({len(coverageInfo['executable'])} executable "
        f"lines, {len(coverageInfo['functions'])} functions, "
        f"{len(coverageInfo['branches'])} branches)")

    # Start the run loop
    while True:
        logging.debug("Top of main loop")
        if (loadError == None):
            put_result(run_put(get_inputs(), filename, cov))  # Call the put
        else:
            get_inputs()
            put_result(loadError)  # Return the load error
