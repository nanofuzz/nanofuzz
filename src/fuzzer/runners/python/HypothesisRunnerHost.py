"""pytest plugin for NaNofuzz Hypothesis / Hypofuzz integration.

Hooks into pytest and Hypothesis test execution to:
1. Configure Hypothesis global profile (disable shrinking, suppress health checks).
2. Measure test execution counts and durations in real-time.
3. Capture exact in-memory Python objects for falsifying counterexamples via inner_test hook.
4. Periodically flush execution state via MessagePack IPC protocol atomically to disk
   every 1.5s (and on any failure) so data survives timeouts and process termination.
5. Enforce global suite timeout cleanly via pytest.exit().
"""

from PythonIpc import sanitize_output, pack_payload
import atexit
import functools
import inspect
import os
import signal
import sys
import time

_VENDOR_DIR = os.path.join(os.path.dirname(
    os.path.realpath(__file__)), "_nanofuzz_python")
if os.path.exists(_VENDOR_DIR) and _VENDOR_DIR not in sys.path:
    sys.path.insert(0, _VENDOR_DIR)


# Path to write the structured execution summary MessagePack report
REPORT_PATH = os.environ.get(
    "NANOFUZZ_PBT_OUT_FILE", ".nanofuzz_pbt_run.msgpack")

# Path to optional file containing injected seed inputs to execute
INJECTED_FILE = os.environ.get("NANOFUZZ_PBT_INJECTED_FILE")

# Maximum runtime allowed for the entire test suite in seconds
TIMEOUT_SEC = float(os.environ.get("NANOFUZZ_SUITE_TIMEOUT_SEC", "300"))

# Maximum failure count before stopping (0 = unlimited / continuous exploration)
MAX_FAILURES = int(os.environ.get("NANOFUZZ_MAX_FAILURES", "0"))

# Maximum test count before stopping (0 = unlimited / continuous exploration until timeout)
MAX_TESTS = int(os.environ.get("NANOFUZZ_MAX_TESTS", "0"))

# Epoch timestamp when the test suite process started
START_TIME = time.time()

# Timestamp of the most recent disk report flush
LAST_FLUSH = 0.0

# Initialize code coverage tracer
_cov = None
try:
    import coverage

    _cov = coverage.Coverage(branch=True, data_file=None)
    _cov.start()
except Exception:
    _cov = None

# In-memory execution state maintained across all test cases
run_data = {
    "total_executions": 0,
    "pass_count": 0,
    "fail_count": 0,
    "timeout_count": 0,
    "primary_counterexample": None,
    "stop_reason": "completed",
    "duration_ms": 0,
    "coverage": None,
}


def _bind_inputs(fn, args, kwargs):
    """Binds runtime positional and keyword arguments to the test function's parameter names."""
    sig = inspect.signature(fn)
    bound = sig.bind_partial(*args, **kwargs)
    return {k: sanitize_output(v) for k, v in bound.arguments.items()}


def _collect_coverage():
    """Extracts statement and branch coverage across project source files."""
    if _cov is None:
        return None
    try:
        data = _cov.get_data()
        measured = data.measured_files()
        cwd = os.getcwd()
        tot_stmts = 0
        cov_stmts = 0
        tot_br = 0
        cov_br = 0
        uncovered = {}
        for f in measured:
            if not f.startswith(cwd):
                continue
            rel = os.path.relpath(f, cwd)
            # Exclude tests, virtualenvs, site-packages, build artifacts
            parts = rel.split(os.sep)
            if any(part in parts for part in (".venv", "venv", "tests", "test", "__pycache__", "build", "dist")):
                continue
            if not f.endswith(".py"):
                continue
            try:
                analysis = _cov._analyze(f)
                ts = len(analysis.statements)
                ms = len(analysis.missing)
                cs = ts - ms
                tot_stmts += ts
                cov_stmts += cs
                bs = analysis.branch_stats()
                tot_br += sum(b[0] for b in bs.values())
                cov_br += sum(b[1] for b in bs.values())
                if analysis.missing:
                    uncovered[rel] = sorted(list(analysis.missing))
            except Exception:
                pass

        if tot_stmts == 0:
            return None

        stmt_pct = round((cov_stmts / tot_stmts) * 100, 2)
        br_pct = round((cov_br / tot_br) * 100, 2) if tot_br > 0 else 100.0
        return {
            "statements_total": tot_stmts,
            "statements_covered": cov_stmts,
            "statement_pct": stmt_pct,
            "branches_total": tot_br,
            "branches_covered": cov_br,
            "branch_pct": br_pct,
            "uncovered_lines": uncovered,
        }
    except Exception:
        return None


def _flush():
    """Flushes current in-memory run_data atomically to REPORT_PATH using MessagePack."""
    global LAST_FLUSH
    now = time.time()
    run_data["duration_ms"] = int((now - START_TIME) * 1000)
    cov_data = _collect_coverage()
    if cov_data:
        run_data["coverage"] = cov_data
    tmp_path = f"{REPORT_PATH}.{os.getpid()}.tmp"
    packed = pack_payload(run_data)
    with open(tmp_path, "wb") as f:
        f.write(packed)
    os.replace(tmp_path, REPORT_PATH)
    LAST_FLUSH = now


def _record_step(is_fail=False):
    """Throttles periodic flushing to at most once every 1.5 seconds, or immediately on failure."""
    global LAST_FLUSH
    now = time.time()
    if is_fail or (now - LAST_FLUSH >= 1.5):
        _flush()


def _sig_handler(signum, frame):
    """Signal handler for SIGINT/SIGTERM to record interruption and flush before exit."""
    run_data["stop_reason"] = "interrupted"
    _flush()
    sys.exit(0)


# Register signal handlers for clean interruption
try:
    signal.signal(signal.SIGINT, _sig_handler)
    signal.signal(signal.SIGTERM, _sig_handler)
except Exception:
    pass

# Register atexit flush callback as fallback
atexit.register(_flush)


def pytest_configure(config):
    """Configures the global Hypothesis settings profile on pytest startup.

    Disables Phase.shrink so tests fail fast without spending minutes on byte-level
    shrinking, and suppresses all health checks so unconstrained generators do not abort.
    Configures max_examples dynamically based on NANOFUZZ_MAX_TESTS (or 10,000,000 for
    continuous exploration mode) so tests do not exit prematurely after Hypothesis's default 100.
    """
    from hypothesis import settings, Phase, HealthCheck

    max_examples = MAX_TESTS if MAX_TESTS > 0 else 10_000_000

    settings.register_profile(
        "nanofuzz_pbt",
        phases=(Phase.explicit, Phase.reuse, Phase.generate),
        suppress_health_check=list(HealthCheck),
        deadline=None,
        max_examples=max_examples,
    )
    settings.load_profile("nanofuzz_pbt")


def pytest_sessionfinish(session, exitstatus):
    """Called when the pytest session completes. Stops coverage collection and flushes final report."""
    global _cov
    if _cov is not None:
        try:
            _cov.stop()
        except Exception:
            pass
    _flush()


def pytest_collection_modifyitems(session, config, items):
    """Inspects collected test items, binds injected examples, and instruments Hypothesis @given test functions."""
    from hypothesis import example
    from PythonIpc import unpack_payload

    injected_examples = []
    if INJECTED_FILE and os.path.exists(INJECTED_FILE):
        with open(INJECTED_FILE, "rb") as f:
            raw_injected = unpack_payload(f.read())
            if isinstance(raw_injected, list):
                for item in raw_injected:
                    if isinstance(item, dict):
                        # Item may be a dictionary of arguments or {"input": {...}}
                        in_args = item.get("input") if "input" in item and isinstance(
                            item["input"], dict) else item
                        injected_examples.append(in_args)

    instrumented_count = 0
    for item in items:
        fn = getattr(item, "obj", None)
        if fn and hasattr(fn, "hypothesis") and hasattr(fn.hypothesis, "inner_test"):
            for ex in injected_examples:
                example(**ex)(fn)
            _instrument_hypothesis_test(fn, item.name)
            instrumented_count += 1

    if instrumented_count == 0:
        run_data["stop_reason"] = "no_hypothesis_tests"
        _flush()


def _instrument_hypothesis_test(fn, test_name):
    """Wraps Hypothesis's inner_test function to track executions and capture counterexamples.

    Hypothesis invokes inner_test for each generated example. Wrapping it allows:
    1. Incrementing test counters for every execution.
    2. Enforcing global suite timeouts before each example runs.
    3. Capturing the exact in-memory argument values when an exception or assertion fails.
    """
    original = fn.hypothesis.inner_test

    @functools.wraps(original)
    def _wrapped(*args, **kwargs):
        now = time.time()
        # Enforce global suite timeout
        if now - START_TIME >= TIMEOUT_SEC:
            run_data["stop_reason"] = "timeout"
            _flush()
            try:
                import pytest

                pytest.exit(
                    f"NaNofuzz suite timeout of {TIMEOUT_SEC}s reached", returncode=0)
            except Exception:
                sys.exit(0)

        # Enforce max tests limit when configured
        if MAX_TESTS > 0 and run_data["total_executions"] >= MAX_TESTS:
            run_data["stop_reason"] = "max_tests"
            _flush()
            try:
                import pytest

                pytest.exit(
                    f"NaNofuzz max tests limit of {MAX_TESTS} reached", returncode=0)
            except Exception:
                sys.exit(0)

        run_data["total_executions"] += 1
        try:
            res = original(*args, **kwargs)
            run_data["pass_count"] += 1
            _record_step(is_fail=False)
            return res
        except Exception as exc:
            run_data["fail_count"] += 1
            if run_data["primary_counterexample"] is None:
                run_data["primary_counterexample"] = {
                    "test_name": test_name,
                    "inputs": _bind_inputs(original, args, kwargs),
                    "exception_type": type(exc).__name__,
                    "exception_message": str(exc),
                }
            _record_step(is_fail=True)
            # If MAX_FAILURES is configured (>0) and reached, stop the run
            if MAX_FAILURES > 0 and run_data["fail_count"] >= MAX_FAILURES:
                run_data["stop_reason"] = "max_failures"
                _flush()
                raise
            # In continuous exploration mode (MAX_FAILURES == 0), swallow the exception
            # so Hypothesis does not abort on the first failure and continues fuzzing.
            return None

    fn.hypothesis.inner_test = _wrapped
