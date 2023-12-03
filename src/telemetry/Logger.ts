import * as util from "util";
import * as vscode from "vscode";
import * as JSON5 from "json5";

/**
 * Lightweight storage for event data prior to de-staging.
 *
 * This is a singleton. Use getLogger() to get the instance.
 */
export class Logger {
  private static theInstance?: Logger; // Singleton instance
  private log: LoggerEntry[] = []; // In-memory log data
  private chunkPrefix = `LoggerChunk`; // Prefix for log chunk filenames
  private active = false; // Whether logging is active

  /**
   * Get the logger singleton
   *
   * @returns the singleton instance of Logger
   */
  public static getLogger(): Logger {
    if (Logger.theInstance === undefined) Logger.theInstance = new Logger();
    return Logger.theInstance;
  }

  /**
   * Persist the in-memory log to storage
   * @returns
   */
  private persistChunk(): void {
    const { workspaceFolders } = vscode.workspace;

    // We only persist if there is one workspace folder
    if (workspaceFolders === undefined) {
      console.debug(`No workspace folders, not persisting log chunk`);
      return;
    }
    if (workspaceFolders.length !== 1) {
      console.debug(
        `${workspaceFolders.length} workspace folders instead of 1, not persisting log chunk`
      );
      return;
    }

    // Determine the persisted log chunk filename
    const chunkName = `${this.chunkPrefix}-${new Date().toISOString()}`;
    const chunkUri = vscode.Uri.joinPath(
      workspaceFolders[0].uri,
      "telemetry",
      chunkName + ".json"
    );

    // Persist the log chunk if data is present
    if (this.log.length) {
      const logCopy = this.log;
      this.log = []; // Clear the persisted data
      vscode.workspace.fs.writeFile(
        chunkUri,
        Buffer.from(JSON5.stringify(logCopy))
      );
    } else {
      console.debug("No telemetry log data to persist");
    }
  } // persistChunk()

  /**
   * Clear the in-memory log
   */
  public clear(): void {
    this.log = [];
    console.debug(`Cleared in-memory log data (any persisted chunks remain)`);
  } // clear()

  /**
   * Flush the in-memory log to storage
   */
  public flush(): void {
    this.persistChunk();
  } // flush()

  /**
   * Push the log entry to the in-memory log
   *
   * @param logEntry
   */
  public push(logEntry: LoggerEntry): void {
    if (this.active) this.log.push(logEntry);
  } // push()

  /**
   * Sets whether logging is active
   *
   * @param active Whether logging is active
   */
  public setActive(active: boolean): void {
    this.active = active;
  } // setActive()

  /**
   * Returns whether logging is active
   *
   * @returns whether logging is active
   */
  public isActive(): boolean {
    return this.active;
  } // isActive()
}

/**
 * An entry in the log
 */
export class LoggerEntry {
  private time: string; // Log timestamp

  /**
   * Build a log entry object
   *
   * @param src Source of the log entry
   * @param msg Parameterized message to log (e.g., %s)
   * @param prm Parameters for the message
   */
  constructor(
    private src: string, // Source of the log entry
    private msg?: string, // Parameterized message to log
    private prm?: string[] // Parameters for the message
  ) {
    this.time = new Date().toISOString();
  }

  /**
   * Returns a string representation of the log entry
   *
   * @returns a string representation of the log entry
   */
  public toString(): string {
    const logStart = `${this.time}:${this.src}`;
    if (this.msg === undefined) {
      return logStart;
    } else if (this.prm === undefined) {
      return `${logStart}: ${this.msg}`;
    } else {
      return `${logStart}: ${util.format(this.msg, ...this.prm)}`;
    }
  } // toString()
}
