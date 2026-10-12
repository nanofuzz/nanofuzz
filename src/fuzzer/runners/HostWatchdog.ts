import { Worker } from "node:worker_threads";
import * as path from "node:path";
import * as fs from "node:fs";
import { findInAncestor } from "../Util";
import { AbstractHost } from "./AbstractHost";
import type {
  WatchdogCommandMessage,
  WatchdogEventMessage,
} from "./HostWatchdogWorker";

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
    const msg: WatchdogCommandMessage = { cmd: "watch", pid, maxBytes };
    this._worker?.postMessage(msg);
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
    const msg: WatchdogCommandMessage = { cmd: "unwatch", pid };
    this._worker?.postMessage(msg);
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
      const workerPath = resolveWatchdogWorkerPath();
      if (!workerPath || !fs.existsSync(workerPath)) {
        return;
      }
      const worker = new Worker(workerPath, { name: "HostWatchdogWorker" });
      worker.on("message", (msg: WatchdogEventMessage) => {
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

/**
 * Resolves the path to the built HostWatchdogWorker.js script.
 */
function resolveWatchdogWorkerPath(): string | undefined {
  const currModuleDir =
    typeof module !== "undefined" && module.filename
      ? path.dirname(path.resolve(module.filename))
      : __dirname;
  const packageJsonPath = findInAncestor(currModuleDir, "package.json");
  if (!packageJsonPath) {
    return undefined;
  }
  return path.resolve(
    path.join(
      path.dirname(packageJsonPath),
      "build",
      "workers",
      "HostWatchdogWorker.js"
    )
  );
} // fn: resolveWatchdogWorkerPath
