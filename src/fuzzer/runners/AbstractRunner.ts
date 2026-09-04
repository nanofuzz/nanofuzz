import { VmGlobals } from "../Types";

/**
 * Abstract test runner class
 */
export abstract class AbstractRunner {
  protected readonly _name: string;

  /**
   * Creates a new test runner for a given module and exported module function.
   *
   * @param `module` loaded program module
   * @param `jsFn` exported function within `module` to call
   */
  public constructor(name: string) {
    this._name = name;
  } // fn: constructor

  /**
   * Returns the runner's name
   */
  public get name(): string {
    return this._name;
  } // property: get name

  /**
   * Called prior to the start of the run
   */
  public onRunStart(): Promise<void> {
    return new Promise((resolve, _reject) => resolve());
  }

  /**
   * Executes the test with a set of inputs and a timeout threshold.
   *
   * @param `inputs` test inputs
   * @param timeout  timeout threshold
   */
  public abstract run(
    inputs: unknown[],
    timeout?: number
  ): Promise<RunnerResult>;

  /**
   * Called after the end of the run
   */
  public async onRunEnd(): Promise<void> {
    return new Promise((resolve, _reject) => resolve());
  }
}

/**
 * Coverage reported for one file. Used in Python
 */
export type CoverageInfo = {
  executable: number[]; // static: all executable lines
  functions: FunctionInfo[]; // static: all functions
  branches: BranchInfo[]; // static: all branch points
  lines?: number[]; // dynamic: lines executed by this one call
  arcs?: Arc[]; // dynamic: arcs taken by this one call
};

/**
 * A function in the program under test. `lines` holds only the function's own
 * executable lines: coverage.py attributes lines per function, so lines inside
 * a nested function are not charged to its parent.
 */
export type FunctionInfo = {
  name: string; // e.g. "fn" or "Class.method"
  declLine: number; // the `def` line
  startLine: number; // first executable line of the body
  endLine: number; // last executable line of the body
  lines: number[]; // the function's own executable lines
};

/**
 * A branch point: a line with more than one possible exit.
 */
export type BranchInfo = {
  line: number; // the branching line
  exits: BranchExit[]; // every destination it can reach
};

/**
 * One possible exit from a branch. `dest` is the raw arc target, used to match
 * against the arcs actually taken. coverage.py uses non-positive `dest` values
 * to mean "left the enclosing scope"; those have no line of their own, so
 * `line` reports where to display them (the branch line itself).
 */
export type BranchExit = {
  dest: number; // arc target, for matching against `Arc`s
  line: number; // where to display this exit
};

export type RunnerResult = {
  result: (
    | { tag: "timeout" }
    | {
        tag: "error";
        name: string;
        message: string;
        stack?: string;
        source?: "put" | "host"; // if the error originated within the put
        coverageData?: number[]; // lines executed by this call
        coverageArcs?: Arc[]; // arcs taken by this call
        staticCoverage?: Record<string, CoverageInfo>;
      }
    | {
        tag: "skip";
        message: string;
        coverageData?: number[]; // lines executed by this call
        coverageArcs?: Arc[]; // arcs taken by this call
        staticCoverage?: Record<string, CoverageInfo>;
      }
    | {
        tag: "value";
        value: unknown;
        coverageData?: number[]; // lines executed by this call
        coverageArcs?: Arc[]; // arcs taken by this call
        staticCoverage?: Record<string, CoverageInfo>;
      }
  ) & { seq: number };
  env: VmGlobals;
};

export type TypeHint =
  | "uuid"
  | "bytes"
  | "default"
  | { kind: "array"; element: TypeHint }
  | { kind: "tuple"; elements: TypeHint[] }
  | { kind: "object"; fields: Record<string, TypeHint> }
  | { kind: "union"; arms: TypeHint[] };

export type RunnerInput = {
  args: unknown[];
  seq: number;
  typeHints?: TypeHint[];
};

/**
 * A transition between two lines, as `[from, to]`. Runners that measure branch
 * coverage report which of these a call took.
 */
export type Arc = [number, number];
