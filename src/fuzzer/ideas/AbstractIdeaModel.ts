import seedrandom from "seedrandom";
import * as vscode from "vscode";
import { FunctionDef, FuzzTestResults } from "../Fuzzer";
import { IdeaData, IdeaStatus } from "./Types";
import { FuzzPanel } from "../../ui/FuzzPanel";

export abstract class AbstractIdeaModel {
  protected readonly _id: string;
  protected readonly _name: string;
  protected _basis: IdeaBasis;
  protected _priority: number = 0;
  protected _status: IdeaStatus = "proposed";

  constructor(idea: { id: string; name: string }, basis: IdeaBasis) {
    this._id = idea.id;
    this._name = idea.name;
    this._basis = basis;
  }

  public abstract get type(): string;
  public abstract get data(): IdeaData;
  public abstract refresh(): boolean;

  public get id(): string {
    return this._id;
  }
  public get priority(): number {
    return this._priority;
  }
  public get name(): string {
    return this._name;
  }
  public get isProposed(): boolean {
    return this._status === "proposed";
  }
  protected get baseData(): AbstractIdeaData {
    return {
      type: "idea.abstract",
      id: this._id,
      name: this._name,
      priority: this._priority,
      status: this._status,
    };
  }

  public reject(): void {
    this._status = "rejected";
  }
  public accept(): void {
    this._status = "rejected";
  }
}

export type IdeaBasis = {
  webview: vscode.Webview;
  module: NodeJS.Module;
  fn: FunctionDef;
  results: FuzzTestResults;
  prng: seedrandom.prng;
  panel: FuzzPanel;
};

export type AbstractIdeaData = {
  type: string;
  id: string;
  priority: number;
  name: string;
  status: IdeaStatus;
};
