// Enable Node.js compile cache if supported by Node runtime (Node 22.8+)
import moduleApi from "node:module";
if (
  "enableCompileCache" in moduleApi &&
  typeof moduleApi.enableCompileCache === "function"
) {
  moduleApi.enableCompileCache();
}
import { parentPort } from "node:worker_threads";
import pidusage from "pidusage";

const targets = new Map<number, number>();
let isChecking = false;

parentPort?.on("message", processMessage);

// Poll every 100ms
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
} // fn: processMessage

/**
 * Periodic sampling callback that inspects memory usage across all monitored PIDs.
 * Posts an "exceeded" event to the parent thread if any PID surpasses its limit.
 */
function checkMemoryUsage(): void {
  if (isChecking || targets.size === 0) return;
  isChecking = true;

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
} // fn: checkMemoryUsage

export type WatchdogCommandMessage = {
  cmd: "watch" | "unwatch" | "reset";
  pid?: number;
  maxBytes?: number;
};

export type WatchdogEventMessage = {
  event: "exceeded";
  pid: number;
};
