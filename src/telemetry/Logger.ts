import { Memory } from "./Memory";
import * as util from "util";

/**
 * Lightweight storage for event data prior to de-staging.
 */
export class Logger {
  constructor(private memory: Memory) {
    this.calcPersist();
  }
  private log: LoggerEntry[] = [];
  private oneMinute = 60000;
  private chunkPrefix = `[Logger-Chunk]`;
  private lastPersist: Date = new Date();
  private nextPersist: Date = new Date(
    this.lastPersist.getTime() + this.oneMinute
  );
  private calcPersist() {
    this.lastPersist = new Date();
    this.nextPersist = new Date(this.lastPersist.getTime() + this.oneMinute);
  }
  private persistChunk() {
    const chunkName = `${this.chunkPrefix}${this.lastPersist.toISOString()}`;

    this.calcPersist(); // Reset the persistence stamps
    this.memory.set(chunkName, this.log); // Persist this chunk
    this.log = []; // Clear the persisted data

    console.debug(`Persisted chunk: ${chunkName}`);
  }
  public clear(): void {
    this.log = [];
    const keys: readonly string[] = this.memory.keys();
    for (const keyidx in keys) {
      const key: string = keys[keyidx];
      if (key.startsWith(this.chunkPrefix)) {
        this.memory.delete(key);
        console.debug(`Deleted chunk: ${key}`);
      }
    }
    console.debug(`Deleted log data`);
  }
  public push(logEntry: LoggerEntry): void {
    this.log.push(logEntry);
    console.debug(logEntry.toLogString());

    if (new Date() > this.nextPersist) {
      this.persistChunk(); // Persist if needed
    }
  }
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
  public toLogString(): string {
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
