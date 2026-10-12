// Enable Node.js compile cache if supported by Node runtime (Node 22.8+)
import moduleApi from "node:module";
if (
  "enableCompileCache" in moduleApi &&
  typeof moduleApi.enableCompileCache === "function"
) {
  moduleApi.enableCompileCache();
}
import { parentPort } from "node:worker_threads";
import { spawn, ChildProcess } from "node:child_process";
import pidusage from "pidusage";

const targets = new Map<number, number>();
let isChecking = false;
let winPyProc: ChildProcess | undefined;
let winPyStdoutBuffer = "";
let winPyPendingResolve: ((results: Map<number, number>) => void) | undefined;

parentPort?.on("message", processMessage);

// Poll every 100ms across all platforms
const interval = 100;
setInterval(checkMemoryUsage, interval);

/**
 * Handles incoming IPC command messages from the main thread to register,
 * unregister, or reset monitored target PIDs and memory limits.
 *
 * @param msg The command payload received from the parent port.
 */
function processMessage(msg: WatchdogCommandMessage): void {
  if (
    msg.cmd === "watch" &&
    msg.pid !== undefined &&
    msg.maxBytes !== undefined
  ) {
    targets.set(msg.pid, msg.maxBytes);
  } else if (msg.cmd === "unwatch" && msg.pid !== undefined) {
    targets.delete(msg.pid);
  } else if (msg.cmd === "reset") {
    targets.clear();
  }

  if (targets.size === 0 && winPyProc) {
    try {
      winPyProc.kill();
    } catch {
      // ignore
    }
    winPyProc = undefined;
    winPyStdoutBuffer = "";
    winPyPendingResolve = undefined;
  }
} // fn: processMessage

/**
 * Periodic sampling callback that inspects memory usage across all monitored PIDs.
 * Routes to direct Win32 ctypes memory querying on Windows, or pidusage on POSIX.
 */
function checkMemoryUsage(): void {
  if (isChecking || targets.size === 0) return;
  isChecking = true;

  if (process.platform === "win32") {
    checkWindowsMemory();
  } else {
    checkPosixMemory();
  }
} // fn: checkMemoryUsage

/**
 * Samples process memory on POSIX platforms (Linux and macOS) using pidusage.
 * Posts an "exceeded" event to the parent thread if any PID surpasses its limit.
 */
function checkPosixMemory(): void {
  const pids = Array.from(targets.keys());
  pidusage(pids, (err, stats) => {
    isChecking = false;
    if (err || !stats) return;

    for (const [pidStr, stat] of Object.entries(stats)) {
      if (!stat) continue;
      const pid = Number(pidStr);
      const limit = targets.get(pid);
      if (limit !== undefined && stat.memory > limit) {
        targets.delete(pid);
        parentPort?.postMessage({ event: "exceeded", pid });
      }
    }
  });
} // fn: checkPosixMemory

/**
 * Samples process memory on Windows NT by querying a persistent Python helper
 * that directly calls Win32 GetProcessMemoryInfo via ctypes.
 * Falls back to checkPosixMemory if the Python process cannot be spawned.
 */
function checkWindowsMemory(): void {
  const pyProc = getWindowsPyProc();
  if (!pyProc || !pyProc.stdin || pyProc.stdin.destroyed) {
    checkPosixMemory();
    return;
  }

  const pids = Array.from(targets.keys());

  const timeoutTimer = setTimeout(() => {
    if (winPyPendingResolve) {
      winPyPendingResolve = undefined;
      isChecking = false;
    }
  }, 1000);
  timeoutTimer.unref?.();

  winPyPendingResolve = (results: Map<number, number>) => {
    clearTimeout(timeoutTimer);
    isChecking = false;
    for (const [pid, rss] of results.entries()) {
      const limit = targets.get(pid);
      if (limit !== undefined && rss > limit) {
        targets.delete(pid);
        parentPort?.postMessage({ event: "exceeded", pid });
      }
    }
  };

  try {
    pyProc.stdin.write(pids.join(" ") + "\n");
  } catch {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    isChecking = false;
  }
} // fn: checkWindowsMemory

/**
 * Spawns or returns a persistent Python helper process on Windows that reads
 * PIDs from stdin and prints RSS memory measurements to stdout via Win32 ctypes.
 *
 * @returns The active ChildProcess instance, or undefined if spawning fails.
 */
function getWindowsPyProc(): ChildProcess | undefined {
  if (winPyProc && !winPyProc.killed && winPyProc.exitCode === null) {
    return winPyProc;
  }
  try {
    const pythonBin = process.env.PYTHON || "python";
    const proc = spawn(pythonBin, ["-u", "-c", WIN_CTYPES_SCRIPT], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      winPyStdoutBuffer += chunk.toString("utf8");
      while (winPyStdoutBuffer.includes("\n")) {
        const idx = winPyStdoutBuffer.indexOf("\n");
        const line = winPyStdoutBuffer.substring(0, idx).trim();
        winPyStdoutBuffer = winPyStdoutBuffer.substring(idx + 1);

        const results = new Map<number, number>();
        if (line) {
          for (const item of line.split(" ")) {
            const [pStr, rStr] = item.split(":");
            const pid = parseInt(pStr, 10);
            const rss = parseInt(rStr, 10);
            if (!isNaN(pid) && !isNaN(rss)) {
              results.set(pid, rss);
            }
          }
        }
        if (winPyPendingResolve) {
          const cb = winPyPendingResolve;
          winPyPendingResolve = undefined;
          cb(results);
        }
      }
    });

    proc.on("error", () => {
      winPyProc = undefined;
    });

    proc.on("exit", () => {
      winPyProc = undefined;
      if (winPyPendingResolve) {
        const cb = winPyPendingResolve;
        winPyPendingResolve = undefined;
        cb(new Map());
      }
    });

    winPyProc = proc;
    return proc;
  } catch {
    winPyProc = undefined;
    return undefined;
  }
} // fn: getWindowsPyProc

/**
 * Standalone Python script running inside a persistent background process on Windows.
 * Reads space-separated PIDs from stdin and calls Win32 OpenProcess + GetProcessMemoryInfo
 * directly via ctypes, returning PID-to-RSS byte mappings with microsecond latency.
 */
const WIN_CTYPES_SCRIPT = `
import sys, ctypes
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ('cb', wintypes.DWORD),
        ('PageFaultCount', wintypes.DWORD),
        ('PeakWorkingSetSize', ctypes.c_size_t),
        ('WorkingSetSize', ctypes.c_size_t),
        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
        ('QuotaPagedPoolUsage', ctypes.c_size_t),
        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
        ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
        ('PagefileUsage', ctypes.c_size_t),
        ('PeakPagefileUsage', ctypes.c_size_t),
    ]

psapi = ctypes.windll.psapi
kernel32 = ctypes.windll.kernel32

def get_rss(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return 0
    try:
        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        if psapi.GetProcessMemoryInfo(h, ctypes.byref(counters), counters.cb):
            return int(counters.WorkingSetSize)
        return 0
    except Exception:
        return 0
    finally:
        kernel32.CloseHandle(h)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    results = []
    for p in line.split():
        try:
            pid = int(p)
            rss = get_rss(pid)
            if rss > 0:
                results.append(f"{pid}:{rss}")
        except Exception:
            pass
    sys.stdout.write(" ".join(results) + "\\n")
    sys.stdout.flush()
`;

export type WatchdogCommandMessage = {
  cmd: "watch" | "unwatch" | "reset";
  pid?: number;
  maxBytes?: number;
};

export type WatchdogEventMessage = {
  event: "exceeded";
  pid: number;
};
