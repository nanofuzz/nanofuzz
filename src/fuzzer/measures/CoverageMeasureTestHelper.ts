import { CoverageMap } from "istanbul-lib-coverage";
import { CoverageMeasure, CodeCoverageMeasureStats } from "./CoverageMeasure";
import {
  FuzzEnv,
  FuzzGeneratorStatsBase,
  FuzzStopReason,
  FuzzTestResult,
  FuzzTestResults,
  InputAndSource,
} from "../Types";
import { ArgDef } from "../analysis/ArgDef";
import { FunctionDef } from "../analysis/FunctionDef";
import { getDefaultFuzzExecutionOptions } from "../FuzzerFactory";

/**
 * Shared test helpers and stubs for CoverageMeasure test suites.
 */

export const anyResult: FuzzTestResult = {
  pinned: false,
  inputGenerated: {
    tick: 0,
    value: [],
    source: { type: "unknown" },
  },
  input: [],
  output: [],
  exception: false,
  timeout: false,
  passedImplicit: "pass",
  passedHuman: "unknown",
  passedValidator: "unknown",
  passedValidators: [],
  harnessErrors: [],
  timers: { gen: 0, transform: 0, run: 0 },
  category: "ok",
  interestingReasons: [],
};

export const anyEnv: FuzzEnv = {
  options: {
    argDefaults: ArgDef.getDefaultOptions(),
    maxTests: 3,
    maxDupeInputs: 1,
    maxFailures: 0,
    fnTimeout: 100,
    suiteTimeout: 1000,
    useImplicit: true,
    useHuman: false,
    useProperty: false,
    useTransformer: false,
    measures: {
      FailedTestMeasure: { enabled: false, weight: 0 },
      CoverageMeasure: { enabled: true, weight: 1 },
    },
    generators: {
      RandomInputGenerator: { enabled: true },
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: false },
      UserInputGenerator: { enabled: false },
    },
  },
  executionOptions: getDefaultFuzzExecutionOptions(),
  function: FunctionDef.fromFunctionRef({
    module: "/tmp/abs_value.py",
    name: "abs_value",
    src: "def abs_value(n):\n    return n",
    lang: "python",
    startOffset: 0,
    endOffset: 0,
    isExported: true,
    isVoid: false,
    args: [],
  }),
  validators: [],
  transformers: [],
  userGenerators: [],
};

export function anyGeneratorStats(): FuzzGeneratorStatsBase {
  return {
    counters: { inputsGenerated: 0, dupesGenerated: 0, dupeTicks: [] },
    timers: { run: 0, transform: 0, val: 0, gen: 0, measure: 0 },
  };
} // fn: anyGeneratorStats

export function inputAt(tick: number): InputAndSource {
  return { tick, value: [], source: { type: "unknown" } };
} // fn: inputAt

export function mutantAt(tick: number, from?: number): InputAndSource {
  return {
    tick,
    value: [],
    source: {
      type: "generator",
      generator: "MutationInputGenerator",
      tick: from,
      steps: {
        taken: 1,
        max: 2,
        mode: "mutate",
        mutators: ["dummy-mutator"],
      },
    },
  };
} // fn: mutantAt

export function coveredKeys(map: CoverageMap): string[] {
  const keys: string[] = [];
  for (const file of map.files()) {
    const fileCoverage = map.fileCoverageFor(file);
    for (const [k, hits] of Object.entries(fileCoverage.s)) {
      if (hits > 0) keys.push(`${file}:s${k}`);
    }
    for (const [k, hits] of Object.entries(fileCoverage.f)) {
      if (hits > 0) keys.push(`${file}:f${k}`);
    }
    for (const [k, arms] of Object.entries(fileCoverage.b)) {
      arms.forEach((hits, arm) => {
        if (hits > 0) keys.push(`${file}:b${k}.${arm}`);
      });
    }
  }
  return keys.sort();
} // fn: coveredKeys

export function coveredCounts(map: CoverageMap): {
  functions: number;
  statements: number;
  branches: number;
} {
  const summary = map.getCoverageSummary();
  return {
    functions: summary.functions.covered,
    statements: summary.statements.covered,
    branches: summary.branches.covered,
  };
} // fn: coveredCounts

export function resultsStub(): FuzzTestResults {
  return {
    toolVersion: "0.0.0",
    env: anyEnv,
    stopReason: FuzzStopReason.MAXTESTS,
    interesting: { inputs: [] },
    results: [],
    stats: {
      counters: {
        testingRuns: 1,
        inputsGenerated: 3,
        dupesGenerated: 0,
        inputsInjected: 0,
        erroredTests: 0,
        passedTests: 0,
        inputsSkipped: 0,
        failedTests: 0,
      },
      outcomes: {
        total: 0,
        oracles: {
          heuristic: {
            pass: 0,
            fail: 0,
            unknown: 0,
          },
          human: {
            fail: 0,
            unknown: 0,
            pass: 0,
          },
          property: {
            fail: 0,
            unknown: 0,
            pass: 0,
          },
        },
        exceptions: 0,
        timeouts: 0,
        categories: {
          ok: 0,
          badValue: 0,
          timeout: 0,
          exception: 0,
          skip: 0,
          disagree: 0,
          failure: 0,
        },
      },
      timers: {
        total: 21,
        compile: 5,
        instrument: 0,
        transform: 0,
        put: 10,
        val: 1,
        gen: 2,
        measure: 3,
      },
      generators: {
        RandomInputGenerator: anyGeneratorStats(),
        MutationInputGenerator: anyGeneratorStats(),
        AiInputGenerator: anyGeneratorStats(),
        UserInputGenerator: anyGeneratorStats(),
      },
      measures: {},
    },
  };
} // fn: resultsStub

export async function statsOf(
  measure: CoverageMeasure
): Promise<CodeCoverageMeasureStats> {
  const results = resultsStub();
  measure.onRunEnd(results);
  const stats = results.stats.measures.CodeCoverageMeasure;
  if (!stats) {
    throw new Error("onRunEnd installed no coverage stats");
  }
  return stats();
} // fn: statsOf
