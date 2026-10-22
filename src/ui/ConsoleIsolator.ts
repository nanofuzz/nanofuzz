/**
 * Isolates and captures console methods and stdout writes to prevent third-party
 * or dependency log pollution from leaking onto standard output during CLI runs.
 *
 * Allows CLI output to pass through cleanly via `.asCli()` or dedicated helper
 * methods, while recording external logs in memory and optionally routing them
 * to stderr when debug mode is enabled.
 */
export class ConsoleIsolator {
  private static _activeInstance?: ConsoleIsolator;
  private static readonly _globalCapturedLogs: CapturedConsoleLog[] = [];

  private _isCliOutput = false;
  private readonly _capturedLogs: CapturedConsoleLog[] = [];
  private readonly _origConsoleLog = console.log;
  private readonly _origConsoleInfo = console.info;
  private readonly _origConsoleWarn = console.warn;
  private readonly _origConsoleError = console.error;
  private readonly _origConsoleDebug = console.debug;
  private readonly _origStdoutWrite = process.stdout.write;
  private readonly _origStderrWrite = process.stderr.write;
  private readonly _isDebug?: () => boolean;
  private _isRestored = false;

  /**
   * Constructs a new ConsoleIsolator instance and installs the console/stream hooks.
   *
   * @param options Configuration options including debug check callback
   */
  public constructor(options?: ConsoleIsolatorOptions) {
    this._isDebug = options?.isDebug;
    this._install();
  } // fn: constructor

  /**
   * Activates console isolation globally, restoring any previously active isolator.
   *
   * @param options Configuration options including debug check callback
   * @returns The active ConsoleIsolator instance
   */
  public static activate(options?: ConsoleIsolatorOptions): ConsoleIsolator {
    if (ConsoleIsolator._activeInstance) {
      ConsoleIsolator._activeInstance.restore();
    }
    const instance = new ConsoleIsolator(options);
    ConsoleIsolator._activeInstance = instance;
    ConsoleIsolator._globalCapturedLogs.length = 0;
    return instance;
  } // fn: activate

  /**
   * Returns a shallow copy of all logs captured by the active isolator or globally.
   *
   * @returns Array of captured console log entries
   */
  public static getCapturedLogs(): CapturedConsoleLog[] {
    if (ConsoleIsolator._activeInstance) {
      return ConsoleIsolator._activeInstance.getCapturedLogs();
    }
    return [...ConsoleIsolator._globalCapturedLogs];
  } // fn: getCapturedLogs

  /**
   * Clears all captured log entries from the active isolator and global buffer.
   */
  public static clearCapturedLogs(): void {
    if (ConsoleIsolator._activeInstance) {
      ConsoleIsolator._activeInstance.clearCapturedLogs();
    }
    ConsoleIsolator._globalCapturedLogs.length = 0;
  } // fn: clearCapturedLogs

  /**
   * Restores original console methods and stream write handlers, uninstalling the isolator.
   */
  public restore(): void {
    if (this._isRestored) return;
    this._isRestored = true;
    console.log = this._origConsoleLog;
    console.info = this._origConsoleInfo;
    console.warn = this._origConsoleWarn;
    console.error = this._origConsoleError;
    console.debug = this._origConsoleDebug;
    process.stdout.write = this._origStdoutWrite;
    if (ConsoleIsolator._activeInstance === this) {
      ConsoleIsolator._activeInstance = undefined;
    }
  } // fn: restore

  /**
   * Executes a callback function with CLI output privileges, allowing console
   * and stream writes to bypass capture and write directly to standard streams.
   *
   * @param fn Callback to execute with CLI privileges
   * @returns Return value of the callback
   */
  public asCli<T>(fn: () => T): T {
    const prev = this._isCliOutput;
    this._isCliOutput = true;
    try {
      return fn();
    } finally {
      this._isCliOutput = prev;
    }
  } // fn: asCli

  /**
   * Writes arguments directly to the underlying console.log with CLI privileges.
   *
   * @param args Log arguments
   */
  public log(...args: unknown[]): void {
    this.asCli(() => {
      this._origConsoleLog(...args);
    });
  } // fn: log

  /**
   * Writes arguments directly to the underlying console.info with CLI privileges.
   *
   * @param args Info arguments
   */
  public info(...args: unknown[]): void {
    this.asCli(() => {
      this._origConsoleInfo(...args);
    });
  } // fn: info

  /**
   * Writes arguments directly to the underlying console.warn with CLI privileges.
   *
   * @param args Warning arguments
   */
  public warn(...args: unknown[]): void {
    this.asCli(() => {
      this._origConsoleWarn(...args);
    });
  } // fn: warn

  /**
   * Writes arguments directly to the underlying console.error with CLI privileges.
   *
   * @param args Error arguments
   */
  public error(...args: unknown[]): void {
    this.asCli(() => {
      this._origConsoleError(...args);
    });
  } // fn: error

  /**
   * Writes arguments directly to the underlying console.debug with CLI privileges.
   *
   * @param args Debug arguments
   */
  public debug(...args: unknown[]): void {
    this.asCli(() => {
      this._origConsoleDebug(...args);
    });
  } // fn: debug

  /**
   * Returns a copy of logs captured during this isolator instance's lifetime.
   *
   * @returns Array of captured log records
   */
  public getCapturedLogs(): CapturedConsoleLog[] {
    return [...this._capturedLogs];
  } // fn: getCapturedLogs

  /**
   * Clears all log records captured by this isolator instance.
   */
  public clearCapturedLogs(): void {
    this._capturedLogs.length = 0;
  } // fn: clearCapturedLogs

  /**
   * Returns true if debug mode is currently active via options callback.
   *
   * @returns True if debug mode is active; false otherwise
   */
  private _isDebugMode(): boolean {
    return Boolean(this._isDebug?.());
  } // fn: _isDebugMode

  /**
   * Records an intercepted console or stream write entry into the log buffers.
   *
   * @param channel Output channel intercepted
   * @param message Formatted string message
   * @param args Optional original call arguments
   */
  private _record(
    channel: CapturedConsoleLog["channel"],
    message: string,
    args?: unknown[]
  ): void {
    const entry: CapturedConsoleLog = {
      channel,
      message,
      args,
      timestamp: Date.now(),
    };
    this._capturedLogs.push(entry);
    ConsoleIsolator._globalCapturedLogs.push(entry);
  } // fn: _record

  /**
   * Installs monkey-patched console and process.stdout.write methods.
   */
  private _install(): void {
    console.log = (...args: unknown[]) => {
      if (this._isCliOutput) {
        this._origConsoleLog(...args);
        return;
      }
      this._record("log", args.map(String).join(" "), args);
      if (this._isDebugMode()) {
        this._origConsoleError(...args);
      }
    };

    console.info = (...args: unknown[]) => {
      if (this._isCliOutput) {
        this._origConsoleInfo(...args);
        return;
      }
      this._record("info", args.map(String).join(" "), args);
      if (this._isDebugMode()) {
        this._origConsoleError(...args);
      }
    };

    console.warn = (...args: unknown[]) => {
      if (this._isCliOutput) {
        this._origConsoleWarn(...args);
        return;
      }
      this._record("warn", args.map(String).join(" "), args);
      if (this._isDebugMode()) {
        this._origConsoleWarn(...args);
      }
    };

    console.error = (...args: unknown[]) => {
      if (this._isCliOutput) {
        this._origConsoleError(...args);
        return;
      }
      this._record("error", args.map(String).join(" "), args);
      this._origConsoleError(...args);
    };

    console.debug = (...args: unknown[]) => {
      if (this._isCliOutput) {
        this._origConsoleDebug(...args);
        return;
      }
      this._record("debug", args.map(String).join(" "), args);
      if (this._isDebugMode()) {
        this._origConsoleError(...args);
      }
    };

    process.stdout.write = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void
    ): boolean => {
      if (!this._isCliOutput) {
        const str = typeof chunk === "string" ? chunk : chunk.toString();
        this._record("stdout", str);
        if (typeof encodingOrCallback === "function") {
          return Reflect.apply(this._origStderrWrite, process.stderr, [
            chunk,
            encodingOrCallback,
          ]);
        }
        if (typeof encodingOrCallback === "string") {
          return Reflect.apply(this._origStderrWrite, process.stderr, [
            chunk,
            encodingOrCallback,
            callback,
          ]);
        }
        return Reflect.apply(this._origStderrWrite, process.stderr, [chunk]);
      }
      if (typeof encodingOrCallback === "function") {
        return Reflect.apply(this._origStdoutWrite, process.stdout, [
          chunk,
          encodingOrCallback,
        ]);
      }
      if (typeof encodingOrCallback === "string") {
        return Reflect.apply(this._origStdoutWrite, process.stdout, [
          chunk,
          encodingOrCallback,
          callback,
        ]);
      }
      return Reflect.apply(this._origStdoutWrite, process.stdout, [chunk]);
    };
  } // fn: _install
} // class: ConsoleIsolator

/**
 * Returns a copy of all captured console and stream logs.
 *
 * @returns Array of captured log records
 */
export function getCapturedConsoleLogs(): CapturedConsoleLog[] {
  return ConsoleIsolator.getCapturedLogs();
} // fn: getCapturedConsoleLogs

/**
 * Clears all captured console and stream logs.
 */
export function clearCapturedConsoleLogs(): void {
  ConsoleIsolator.clearCapturedLogs();
} // fn: clearCapturedConsoleLogs

/**
 * Options for configuring ConsoleIsolator behavior.
 */
export interface ConsoleIsolatorOptions {
  /** Optional callback returning whether debug logging is enabled */
  isDebug?: () => boolean;
}

/**
 * Record representing an intercepted console call or stream write.
 */
export interface CapturedConsoleLog {
  /** Log channel / method that was intercepted */
  channel: "log" | "info" | "warn" | "error" | "debug" | "stdout" | "stderr";
  /** Formatted string representation of the log */
  message: string;
  /** Original arguments passed to the console method */
  args?: unknown[];
  /** Timestamp (epoch ms) when the log was captured */
  timestamp: number;
}
