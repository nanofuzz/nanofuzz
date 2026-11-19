import os
import sys

# Auto-load benchmark defect interceptor if study elicitation is active
if os.environ.get("NANOFUZZ_DYNAMIC_BUG_ELICITATION") in ("1", "true", "True"):
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    try:
        import bug_interceptor
        bug_interceptor.install_interceptors()
    except Exception:
        pass
