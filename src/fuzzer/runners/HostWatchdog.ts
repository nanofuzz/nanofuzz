import pidusage from "pidusage";
import { AbstractHost } from "./AbstractHost";

/**
 * Singleton watchdog that periodically samples memory usage of all active
 * runner host processes using pidusage.
 */
export class HostWatchdog {
  private static _hosts = new Map<number, AbstractHost>();
  private static _timer?: NodeJS.Timeout;
  private static _isChecking = false;

  /**
   * Registers a host process to be monitored by the watchdog.
   *
   * @param host The host instance to watch.
   */
  public static watch(host: AbstractHost): void {
    const pid = host.pid;
    if (!pid) return;
    this._hosts.set(pid, host);
    this._ensureTimer();
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
    if (this._hosts.size === 0) {
      try {
        pidusage.clear();
      } catch {
        // ignore
      }
      this._stopTimer();
    }
  } // fn: unwatch

  /**
   * Stops the watchdog timer and clears all registered hosts.
   */
  public static reset(): void {
    this._stopTimer();
    this._hosts.clear();
  } // fn: reset

  private static _ensureTimer(): void {
    if (this._timer) return;
    // On Windows (NT), query less frequently (1500ms) to avoid WMI thrashing.
    // On POSIX (Darwin/Linux), queries are lightweight (100ms).
    const interval = process.platform === "win32" ? 1500 : 100;
    this._timer = setInterval(() => {
      this._check();
    }, interval);
    this._timer.unref?.();
  } // fn: _ensureTimer

  private static _stopTimer(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  } // fn: _stopTimer

  private static _check(): void {
    if (this._isChecking || this._hosts.size === 0) return;
    this._isChecking = true;

    const pids = Array.from(this._hosts.keys());
    pidusage(pids, (err, stats) => {
      this._isChecking = false;
      if (err || !stats) return;

      for (const [pidStr, stat] of Object.entries(stats)) {
        if (!stat) continue;
        const pid = Number(pidStr);
        const host = this._hosts.get(pid);
        if (!host || !host.isActive) continue;

        const maxMb = host.maxRunnerMemory;
        const maxBytes = maxMb <= 65536 ? maxMb * 1024 * 1024 : maxMb;

        if (stat.memory > maxBytes) {
          host.kill("SIGKILL", "maxRunnerMemory");
        }
      }
    });
  } // fn: _check
} // class: HostWatchdog
