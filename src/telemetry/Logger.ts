import * as util from "util";
import * as vscode from "vscode";

/**
 * Lightweight storage for event data prior to de-staging.
 *
 * This is a singleton.  Use getLogger() to get the instance.
 */
export class Logger {
  public static getLogger(extensionUri: vscode.Uri): Logger {
    if (Logger.theInstance === undefined)
      Logger.theInstance = new Logger(extensionUri);
    return Logger.theInstance;
  }
  private constructor(private extensionUri: vscode.Uri) {
    this.calcPersist();
  }
  private static theInstance?: Logger;
  private log: LoggerEntry[] = [];
  private interval = 30000; // 30 seconds
  private chunkPrefix = `LoggerChunk`;
  private lastPersist: Date = new Date();
  private nextPersist: Date = new Date(
    this.lastPersist.getTime() + this.interval
  );
  private calcPersist() {
    this.lastPersist = new Date();
    this.nextPersist = new Date(this.lastPersist.getTime() + this.interval);
  }
  private persistChunk() {
    const chunkName = `${this.chunkPrefix}-${this.lastPersist.toISOString()}`;
    const chunkUri = vscode.Uri.joinPath(
      this.extensionUri,
      "telemetry",
      chunkName + ".json"
    ); // !!! externalize

    this.calcPersist(); // Reset the persistence stamps

    if (this.log.length) {
      const logCopy = this.log;
      this.log = []; // Clear the persisted data
      console.debug(`Persisting chunk: ${chunkName}...`); // !!!
      vscode.workspace.fs
        .writeFile(chunkUri, Buffer.from(JSON.stringify(logCopy)))
        .then(() => {
          //this.memory.set(chunkName, this.log); // Persist this chunk
          console.debug(`Persisted chunk: ${chunkName}`);
        });
    } else {
      console.debug("No log data to persist");
    }
  }
  public clear(): void {
    this.log = [];
    /*
    const keys: readonly string[] = this.memory.keys();
    for (const keyidx in keys) {
      const key: string = keys[keyidx];
      if (key.startsWith(this.chunkPrefix)) {
        this.memory.delete(key);
        console.debug(`Deleted chunk: ${key}`);
      }
    }
    */
    console.debug(`Cleared in-memory log data (any persisted chunks remain)`);
  }
  public flush(): void {
    this.persistChunk();
  }
  public push(logEntry: LoggerEntry): void {
    this.log.push(logEntry);

    if (new Date() > this.nextPersist) {
      this.persistChunk(); // Persist if needed
    }
  }
  /*
  public toJSON(): string {
    // Flush any pending chunks to storage - so we get them in the next step.
    if (this.log.length) {
      this.persistChunk();
    }

    // Get each chunk from storage and re-construct the log
    const fullLog: LoggerEntry[] = [];
    const keys: readonly string[] = this.memory.keys();
    for (const keyidx in keys) {
      const key: string = keys[keyidx];
      console.debug(`Evaluating key: ${key}`);
      if (key.startsWith(this.chunkPrefix)) {
        const chunk: LoggerEntry[] | undefined = this.memory.get(key);
        if (chunk !== undefined) {
          for (const chunkidx in chunk) {
            fullLog.push(chunk[chunkidx]);
          }
          console.debug(`Loaded chunk: ${key}`);
        }
      }
    }

    return JSON.stringify(fullLog);
  }
  */
}

/**
 * An entry in the log
 */
export class LoggerEntry {
  constructor(
    private src: string,
    private msg?: string,
    private prm?: string[]
  ) {
    this.time = new Date().toISOString();
  }
  private time: string;
  public toString(): string {
    const logStart = `${this.time}:${this.src}`;
    if (this.msg === undefined) {
      return logStart;
    } else if (this.prm === undefined) {
      return `${logStart}: ${this.msg}`;
    } else {
      return `${logStart}: ${util.format(this.msg, ...this.prm)}`;
    }
  }
}
