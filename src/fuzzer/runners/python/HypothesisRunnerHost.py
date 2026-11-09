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

# Epoch timestamp when the test suite process started
START_TIME = time.time()

# Timestamp of the most recent disk report flush
LAST_FLUSH = 0.0

# In-memory execution state maintained across all test cases
run_data = {
    "total_executions": 0,
    "pass_count": 0,
    "fail_count": 0,
    "timeout_count": 0,
    "primary_counterexample": None,
    "stop_reason": "completed",
    "duration_ms": 0,
}


def _bind_inputs(fn, args, kwargs):
    """Binds runtime positional and keyword arguments to the test function's parameter names."""
    sig = inspect.signature(fn)
    bound = sig.bind_partial(*args, **kwargs)
    return {k: sanitize_output(v) for k, v in bound.arguments.items()}


def _flush():
    """Flushes current in-memory run_data atomically to REPORT_PATH using MessagePack."""
    global LAST_FLUSH
    now = time.time()
    run_data["duration_ms"] = int((now - START_TIME) * 1000)
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
    """
    from hypothesis import settings, Phase, HealthCheck

    settings.register_profile(
        "nanofuzz_pbt",
        phases=(Phase.explicit, Phase.reuse, Phase.generate),
        suppress_health_check=list(HealthCheck),
        deadline=None,
    )
    settings.load_profile("nanofuzz_pbt")


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
