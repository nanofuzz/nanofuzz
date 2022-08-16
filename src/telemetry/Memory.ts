import * as vscode from "vscode";

/**
 * Front-end for the Memento VS Code persistence service
 */
export class Memory {
  constructor(private memento: vscode.Memento) {}
  public has(key: string): boolean {
    return this.get(key) === undefined;
  }
  public get<T>(key: string): T | undefined {
    return this.memento.get<T>(key);
  }
  public delete(key: string): void {
    this.memento.update(key, undefined);
  }
  public set<T>(key: string, value: T): void {
    console.debug(`Mementoizing ${key}`);
    this.memento.update(key, value);
  }
  public keys(): readonly string[] {
    return this.memento.keys();
  }
}
