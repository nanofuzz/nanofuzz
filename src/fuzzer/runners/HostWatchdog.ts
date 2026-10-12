import { Worker } from "node:worker_threads";
import { AbstractHost } from "./AbstractHost";

/**
 * Singleton watchdog that periodically samples memory usage of all active
 * runner host processes using pidusage inside a dedicated worker thread.
 */
export class HostWatchdog {
  private static _hosts = new Map<number, AbstractHost>();
  private static _worker?: Worker;

  /**
   * Registers a host process to be monitored by the watchdog.
   *
   * @param host The host instance to watch.
   */
  public static watch(host: AbstractHost): void {
    const pid = host.pid;
    if (!pid) return;
    this._hosts.set(pid, host);
    this._ensureWorker();
    const maxMb = host.maxRunnerMemory;
    const maxBytes = maxMb <= 65536 ? maxMb * 1024 * 1024 : maxMb;
    this._worker?.postMessage({ cmd: "watch", pid, maxBytes });
  } // fn: watch

  /**
   * Unregisters a host process from the watchdog.
   *
   * @param host The host instance to unwatch.
   */
  public static unwatch(host: AbstractHost): void {
    const pid = host.pid;
    if (!pid) return;
    this._hosts.delete(pid);
    this._worker?.postMessage({ cmd: "unwatch", pid });
    if (this._hosts.size === 0) {
      this._stopWorker();
    }
  } // fn: unwatch

  /**
   * Stops the watchdog timer and clears all registered hosts.
   */
  public static reset(): void {
    this._stopWorker();
    this._hosts.clear();
  } // fn: reset

  /**
   * Lazily spawns the background worker thread if not already running.
   * The worker continuously samples all registered PIDs via pidusage
   * and reports back if any PID exceeds its allocated memory limit.
   */
  private static _ensureWorker(): void {
    if (this._worker) return;
    try {
      const pidusagePath = require.resolve("pidusage");
      // Poll interval: 300ms on Windows (NT) to avoid WMI overhead; 100ms on POSIX
      const interval = process.platform === "win32" ? 300 : 100;
      const workerCode = `
        const { parentPort } = require("node:worker_threads");
        const pidusage = require(${JSON.stringify(pidusagePath)});
        const targets = new Map();
        let isChecking = false;

        // Listen for watch / unwatch / reset commands from main thread
        parentPort.on("message", (msg) => {
          if (msg.cmd === "watch") {
            targets.set(msg.pid, msg.maxBytes);
          } else if (msg.cmd === "unwatch") {
            targets.delete(msg.pid);
          } else if (msg.cmd === "reset") {
            targets.clear();
          }
        });

        // Periodic sampling loop
        setInterval(() => {
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
                parentPort.postMessage({ event: "exceeded", pid });
              }
            }
          });
        }, ${interval});
      `;
      const worker = new Worker(workerCode, { eval: true });
      worker.on("message", (msg: { event: string; pid: number }) => {
        if (msg.event === "exceeded") {
          const host = this._hosts.get(msg.pid);
          if (host && host.isActive) {
            host.kill("SIGKILL", "maxRunnerMemory");
          }
        }
      });
      worker.unref?.();
      this._worker = worker;
    } catch {
      // ignore
    }
  } // fn: _ensureWorker

  /**
   * Terminates the background worker thread and cleans up resources.
   */
  private static _stopWorker(): void {
    if (this._worker) {
      try {
        this._worker.terminate();
      } catch {
        // ignore
      }
      this._worker = undefined;
    }
  } // fn: _stopWorker
} // class: HostWatchdog
