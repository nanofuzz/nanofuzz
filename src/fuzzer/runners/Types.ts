import { CoverageMapData } from "istanbul-lib-coverage";
import { VmGlobals } from "../Types";

/**
 * Overrides for configuring runner instances.
 */
export interface RunnerOverrides {
  acceptsStaticCoverage?: true;
}

/**
 * Coverage reported for one file in Python.
 */
export type PythonFileCoverageData = {
  executable: number[]; // static: all executable lines
  functions: FunctionInfo[]; // static: all functions
  branches: BranchInfo[]; // static: all branch points
  lines?: number[]; // dynamic: lines executed by this one call
  arcs?: Arc[]; // dynamic: arcs taken by this one call
};

/**
 * Coverage for the entire program under test in Python.
 */
export type PythonCoverageMapData = Record<string, PythonFileCoverageData>;

/**
 * Unified runner coverage data: Istanbul CoverageMapData for JS/TS, or PythonCoverageMapData for Python.
 */
export type RunnerCoverage = CoverageMapData | PythonCoverageMapData;

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

/**
 * Result of evaluating a property validator in-host.
 */
export type ValidatorResult =
  | {
      tag: "value";
      value: unknown;
    }
  | {
      tag: "error";
      name?: string;
      message?: string;
      stack?: string;
    }
  | {
      tag: "timeout";
    }
  | {
      tag: "skip";
      message?: string;
    };

export type RunnerResultItem =
  | {
      tag: "timeout";
      coverageData?: Record<string, number[]>;
      coverageArcs?: Record<string, Arc[]>;
      validators?: Record<string, ValidatorResult>;
    }
  | {
      tag: "error";
      name: string;
      message: string;
      stack?: string;
      source?: "put" | "host"; // if the error originated within the put
      coverageData?: Record<string, number[]>;
      coverageArcs?: Record<string, Arc[]>; // arcs taken by this call
      validators?: Record<string, ValidatorResult>;
    }
  | {
      tag: "skip";
      message: string;
      coverageData?: Record<string, number[]>;
      coverageArcs?: Record<string, Arc[]>; // arcs taken by this call
      validators?: Record<string, ValidatorResult>;
    }
  | {
      tag: "value";
      value: unknown;
      coverageData?: Record<string, number[]>;
      coverageArcs?: Record<string, Arc[]>; // arcs taken by this call
      validators?: Record<string, ValidatorResult>;
    };

export type RunnerResult = {
  results: RunnerResultItem[]; // array of `repetitions` results
  seq: number;
  env: VmGlobals;
};

export type TypeHint =
  | "uuid"
  | "bytes"
  | "number"
  | "float"
  | "int"
  | "default"
  | { kind: "array"; element: TypeHint }
  | { kind: "set"; element: TypeHint; frozenset?: boolean }
  | { kind: "tuple"; elements: TypeHint[] }
  | { kind: "dictionary"; key: TypeHint; value: TypeHint }
  | { kind: "object"; fields: Record<string, TypeHint> }
  | { kind: "union"; arms: TypeHint[] };

export type RunnerInput = {
  args: unknown[];
  seq: number;
  repetitions: number;
  timeout: number;
  validators: string[];
  env: Record<string, string>;
  typeHints?: TypeHint[];
  collect?: {
    coverageData?: true;
    debugData?: true;
  };
};

/**
 * A transition between two lines, as `[from, to]`. Runners that measure branch
 * coverage report which of these a call took.
 */
export type Arc = [number, number];
