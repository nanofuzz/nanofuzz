import * as vm from "vm";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";
import {
  CoverageMap,
  CoverageMapData,
  FileCoverage,
} from "istanbul-lib-coverage";
import {
  TypescriptCoverageMeasure,
  isCoverageMapData,
} from "./TypescriptCoverageMeasure";
import { CodeCoverageMeasureStats } from "./AbstractCoverageMeasure";
import {
  ArgDef,
  FunctionDef,
  FuzzEnv,
  FuzzGeneratorStatsBase,
  FuzzStopReason,
  FuzzTestResult,
  FuzzTestResults,
  InputAndSource,
  VmGlobals,
} from "../Fuzzer";
import { normalizePathForKey } from "../Util";
import {
  linearSource as jsSrcLinear,
  logicalSource as jsSrcLogical,
  multiFunctionSource as jsSrcTwoFns,
  switchSource as jsSrcSwitch,
  ternarySource as jsSrcTernary,
  threePathSource as jsSrc3,
  twoPathSource as jsSrc,
} from "./test_fixtures/CoverageMeasure.testfixture1";
import {
  linearSource as tsSrcLinear,
  multiFunctionSource as tsSrcTwoFns,
  threePathSource as tsSrc3,
  twoPathSource as tsSrc,
} from "./test_fixtures/CoverageMeasure.testfixture2";

/**
 * Exposes just enough protected state to drive `onAfterCompile` and its
 * source map registration without running an entire fuzzing campaign.
 */
class TestCoverageMeasure extends TypescriptCoverageMeasure {
  public mergeIntoGlobal(data: CoverageMapData): void {
    this._globalCoverageMap.merge(data);
  }
} // class: TestCoverageMeasure

/**
 * A function under test: every fixture exports functions of this shape.
 *
 * Narrowing an export with `typeof x === "function"` only reaches `Function`,
 * which is not callable with a known signature, so the specs go through this
 * predicate instead. The fixtures are compiled from sources checked in beside
 * these specs, so the signature is known even though the loader cannot see it.
 */
type NumericFn = (n: number) => number;
function isNumericFn(value: unknown): value is NumericFn {
  return typeof value === "function";
} // fn: isNumericFn

/**
 * Runs `jsSrc` in a fresh context shaped like the one `TypescriptCompiler`
 * builds, so that instrumented code writes counters to `global.__coverage__`.
 *
 * @param `jsSrc` (instrumented) source to execute
 * @param `jsFileName` filename to execute it under
 * @returns the context and the module's exported `absValue` function
 */
function runInSandbox(
  jsSrc: string,
  jsFileName: string
): { context: VmGlobals; absValue: NumericFn } {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  const sandbox: VmGlobals = { module, exports: module.exports };
  sandbox.global = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(jsSrc, sandbox, { filename: jsFileName });

  const absValue = module.exports.absValue;
  if (!isNumericFn(absValue)) {
    throw new Error("source under test did not export absValue");
  }
  return { context: sandbox, absValue };
} // fn: runInSandbox

/**
 * Returns the coverage data the instrumented code published in `context`
 */
function coverageOf(context: VmGlobals): CoverageMapData {
  const globals = context.global;
  const coverage =
    typeof globals === "object" && globals && "__coverage__" in globals
      ? globals.__coverage__
      : undefined;
  if (!isCoverageMapData(coverage)) {
    throw new Error("instrumented code published no coverage data");
  }
  return coverage;
} // fn: coverageOf

/**
 * Returns an input record for tick `tick` with no predecessor
 */
function inputAt(tick: number): InputAndSource {
  return { tick, value: [], source: { type: "unknown" } };
} // fn: inputAt

/**
 * Returns an input record for tick `tick` that was mutated from the
 * input at tick `from` (or from no input at all, if `from` is omitted)
 */
function mutantAt(tick: number, from?: number): InputAndSource {
  return {
    tick,
    value: [],
    source: {
      type: "generator",
      generator: "MutationInputGenerator",
      tick: from,
    },
  };
} // fn: mutantAt

/**
 * `measure()` records coverage, not the test result itself, so every spec
 * passes this same passing-and-uninteresting result.
 */
const anyResult: FuzzTestResult = {
  pinned: false,
  input: [],
  output: [],
  exception: false,
  timeout: false,
  passedImplicit: "pass",
  passedHuman: "unknown",
  passedValidator: "unknown",
  passedValidators: [],
  validatorException: false,
  timers: { gen: 0, run: 0 },
  category: "ok",
  interestingReasons: [],
};

/**
 * The environment of a run whose details do not matter here: `onRunEnd` reads
 * nothing from it, but `FuzzTestResults` requires it, and building a real one
 * keeps the stub honest. The function has no arguments because no spec calls
 * it -- these measures are driven by the sandbox above, not by the PUT.
 */
const anyEnv: FuzzEnv = {
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
    measures: {
      FailedTestMeasure: { enabled: false, weight: 0 },
      CoverageMeasure: { enabled: true, weight: 1 },
    },
    generators: {
      RandomInputGenerator: { enabled: true },
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: false },
    },
  },
  function: FunctionDef.fromFunctionRef({
    module: "/tmp/absValue.ts",
    name: "absValue",
    src: "export function absValue(n: number): number {\n  return n;\n}",
    lang: "typescript",
    startOffset: 0,
    endOffset: 0,
    isExported: true,
    isVoid: false,
    args: [],
  }),
  validators: [],
};

/**
 * Per-generator statistics for a run whose details do not matter here
 */
const anyGeneratorStats = (): FuzzGeneratorStatsBase => ({
  counters: { inputsGenerated: 0, dupesGenerated: 0 },
  timers: { run: 0, val: 0, gen: 0, measure: 0 },
});

/**
 * Summarizes what a coverage map says was covered. Used instead of
 * inspecting the measure's internals so that these properties hold
 * regardless of how the measure stores its data.
 */
function coveredCounts(map: CoverageMap): {
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

/**
 * Returns a sorted, stable identifier for every item a coverage map says
 * was covered. Comparing these compares the coverage itself, not just its
 * size. Read a map's keys immediately: a measurement's maps are not
 * guaranteed to be stable once the next test executes.
 */
function coveredKeys(map: CoverageMap): string[] {
  const keys: string[] = [];
  for (const file of map.files()) {
    const fc = map.fileCoverageFor(file);
    for (const [k, hits] of Object.entries(fc.s)) {
      if (hits > 0) keys.push(`${file}:s${k}`);
    }
    for (const [k, hits] of Object.entries(fc.f)) {
      if (hits > 0) keys.push(`${file}:f${k}`);
    }
    for (const [k, arms] of Object.entries(fc.b)) {
      arms.forEach((hits, arm) => {
        if (hits > 0) keys.push(`${file}:b${k}.${arm}`);
      });
    }
  }
  return keys.sort();
} // fn: coveredKeys

describe("fuzzer/analysis/measures/TypescriptCoverageMeasure:", () => {
  it("onAfterCompile preserves the program's behavior", () => {
    const measure = new TestCoverageMeasure();
    const instrumented = measure.onAfterCompile(jsSrc, "/tmp/absValue.js");

    expect(instrumented).not.toEqual(jsSrc);

    const plain = runInSandbox(jsSrc, "/tmp/absValue.js");
    const covered = runInSandbox(instrumented, "/tmp/absValue.js");

    for (const n of [-3, 0, 7]) {
      expect(covered.absValue(n)).toEqual(plain.absValue(n));
    }
  });

  it("onAfterCompile emits counters keyed by the supplied filename", () => {
    const measure = new TestCoverageMeasure();
    const jsFileName = "/tmp/absValue.js";
    const { context, absValue } = runInSandbox(
      measure.onAfterCompile(jsSrc, jsFileName),
      jsFileName
    );

    // The instrumented preamble publishes counters here; this is the
    // object `onAfterLoad` later takes a pointer to.
    const data = coverageOf(context);
    expect(isCoverageMapData(data)).toBeTrue();
    expect(Object.keys(data)).toEqual([jsFileName]);
    expect(data[jsFileName].path).toEqual(jsFileName);

    // Nothing has run yet: the static maps exist, the counters are zero
    expect(Object.keys(data[jsFileName].fnMap).length).toEqual(1);
    expect(Object.keys(data[jsFileName].branchMap).length).toEqual(1);
    expect(Object.values(data[jsFileName].f)).toEqual([0]);

    // Exercise only the negative path
    absValue(-3);

    expect(data[jsFileName].f[0]).toEqual(1); // function entered once
    expect(data[jsFileName].b[0]).toEqual([1, 0]); // if taken, else not taken
    expect(Object.values(data[jsFileName].s).some((s) => s === 0)).toBeTrue(); // `return n` unreached
  });

  /**
   * Loads instrumented source and binds a fresh measure to it.
   *
   * @param `binds` how many times to call `onAfterLoad` with the context
   * @returns the measure, its context, and the loaded function
   */
  const jsFileName = "/tmp/absValue.js";

  const load = (
    binds = 1,
    src = jsSrc
  ): {
    measure: TestCoverageMeasure;
    context: VmGlobals;
    absValue: (n: number) => number;
  } => {
    const measure = new TestCoverageMeasure();
    const { context, absValue } = runInSandbox(
      measure.onAfterCompile(src, jsFileName),
      jsFileName
    );
    for (let i = 0; i < binds; i++) {
      measure.onAfterLoad(context);
    }
    return { measure, context, absValue };
  }; // fn: load

  // onAfterLoad should accept any context produced by loading onAfterCompile output
  it("onAfterLoad accepts the context of any module it instrumented", () => {
    const sources = [
      jsSrc, // branch + early return
      "const absValue = (n) => (n < 0 ? -n : n);\nmodule.exports = { absValue };\n", // arrow fn, ternary
      "function absValue(n) { return n; }\nmodule.exports = { absValue };\n", // no branches
    ];

    sources.forEach((src, i) => {
      const jsFileName = `/tmp/absValue${i}.js`;
      const measure = new TestCoverageMeasure();
      const { context } = runInSandbox(
        measure.onAfterCompile(src, jsFileName),
        jsFileName
      );
      expect(() => measure.onAfterLoad(context)).not.toThrow();
    });
  });

  // onAfterLoad should reject anything else, loudly
  it("onAfterLoad throws on a context without valid coverage data", () => {
    const validEntry = {
      path: "/tmp/absValue.js",
      statementMap: {},
      fnMap: {},
      branchMap: {},
      s: {},
      f: {},
      b: {},
    };
    const badContexts: Record<string, VmGlobals> = {
      "no global": {},
      "undefined global": { global: undefined },
      "null global": { global: null },
      "non-object global": { global: "global" },
      "global without __coverage__": { global: {} },
      "null coverage": { global: { __coverage__: null } },
      "non-object coverage": { global: { __coverage__: "coverage" } },
      "array coverage": { global: { __coverage__: [] } },
      "coverage entry missing counters": {
        global: { __coverage__: { "/tmp/absValue.js": { path: "/x.js" } } },
      },
      "coverage entry missing branch counters": {
        global: {
          __coverage__: {
            "/tmp/absValue.js": { ...validEntry, b: undefined },
          },
        },
      },
    };

    for (const [name, context] of Object.entries(badContexts)) {
      expect(() => new TestCoverageMeasure().onAfterLoad(context))
        .withContext(name)
        .toThrow();
    }

    // ...but an instrumented module that declares no coverage entries yet
    // is valid, not an error
    expect(() =>
      new TestCoverageMeasure().onAfterLoad({ global: { __coverage__: {} } })
    ).not.toThrow();
  });

  // a rejected load leaves the measure no worse than before
  it("onAfterLoad leaves an existing binding intact when a later load is rejected", () => {
    const { measure, absValue } = load();

    // Zero first, so this measures the call alone and not the statements
    // the module executed while loading
    measure.onBeforeNextTestExecution();
    absValue(-3);
    const before = coveredCounts(
      measure.measure(inputAt(0), anyResult).coverageMeasure.current
    );
    expect(before.functions).toEqual(1);

    expect(() => measure.onAfterLoad({ global: {} })).toThrow();

    // The earlier measurement is unchanged...
    expect(
      coveredCounts(measure.getCoverage(0).coverageMeasure.current)
    ).toEqual(before);

    // ...and the measure is still bound to the module it loaded
    measure.onBeforeNextTestExecution();
    absValue(-3);
    expect(
      coveredCounts(
        measure.measure(inputAt(1), anyResult).coverageMeasure.current
      )
    ).toEqual(before);
  });

  // ------------------------------------------------------------------
  // onBeforeNextTestExecution: runs between the load and each test, and
  // zeroes the counters the instrumented code writes so that `measure`
  // sees the coverage of one test at a time.
  // ------------------------------------------------------------------

  // the reset should zero every counter, whatever their hit counts
  it("onBeforeNextTestExecution zeroes every counter in the coverage data", () => {
    const { measure, context, absValue } = load(1, jsSrcSwitch);

    // Take every arm of the switch, so that no counter is incidentally
    // zero when the reset runs
    absValue(0);
    absValue(1);
    absValue(9);
    const before = coverageOf(context)[jsFileName];
    expect(before.s).toEqual({ 0: 3, 1: 1, 2: 1, 3: 1, 4: 1 }); // s4: the load
    expect(before.f).toEqual({ 0: 3 });
    expect(before.b).toEqual({ 0: [1, 1, 1] });

    measure.onBeforeNextTestExecution();

    // Every statement, function, and branch arm is back to zero -- including
    // `module.exports`, which the module ran while loading
    const after = coverageOf(context)[jsFileName];
    expect(after.s).toEqual({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 });
    expect(after.f).toEqual({ 0: 0 });
    expect(after.b).toEqual({ 0: [0, 0, 0] });
  });

  // the reset should touch counter values and nothing else
  it("onBeforeNextTestExecution preserves everything but the counter values", () => {
    const { measure, context, absValue } = load(1, jsSrcSwitch);
    absValue(1);

    // Deep copy: the reset mutates the live data in place
    const before: CoverageMapData = JSON.parse(
      JSON.stringify(coverageOf(context))
    );

    measure.onBeforeNextTestExecution();

    const after = coverageOf(context);

    // The same files are still reported...
    expect(Object.keys(after)).toEqual(Object.keys(before));

    // ...under the same path, with the location maps untouched
    const [was, is] = [before[jsFileName], after[jsFileName]];
    expect(is.path).toEqual(was.path);
    expect(is.statementMap).toEqual(was.statementMap);
    expect(is.fnMap).toEqual(was.fnMap);
    expect(is.branchMap).toEqual(was.branchMap);

    // ...and the counters are still keyed the same way, so that nothing the
    // location maps describe has lost its counter
    expect(Object.keys(is.s)).toEqual(Object.keys(was.s));
    expect(Object.keys(is.f)).toEqual(Object.keys(was.f));
    expect(Object.keys(is.b)).toEqual(Object.keys(was.b));

    // Each branch keeps one arm per location: a reset that shortened these
    // would silently drop arms from every later measurement
    const armCounts = (fc: Pick<FileCoverage, "b">) =>
      Object.entries(fc.b).map(([k, arms]) => [k, arms.length]);
    expect(armCounts(is)).toEqual(armCounts(was));
    expect(armCounts(is)).toEqual([["0", 3]]); // `case 0`, `case 1`, `default`
  });

  // what the reset leaves behind should still be valid coverage data
  it("onBeforeNextTestExecution leaves valid coverage data behind", () => {
    const { measure, context, absValue } = load(1, jsSrcTwoFns);
    absValue(-4);

    measure.onBeforeNextTestExecution();

    expect(isCoverageMapData(coverageOf(context))).toBeTrue();

    // ...valid enough that `onAfterLoad`, which is the only other place the
    // shape is checked, still accepts the context the reset just emptied
    expect(() => measure.onAfterLoad(context)).not.toThrow();
  });

  // checks no phantom coverage before a successful load
  it("measure reports no coverage before onAfterLoad has bound a module", () => {
    const measure = new TestCoverageMeasure();

    const meas = measure.measure(inputAt(0), anyResult);

    expect(meas.coverageMeasure.current.files()).toEqual([]);
    expect(coveredCounts(meas.coverageMeasure.current)).toEqual({
      functions: 0,
      statements: 0,
      branches: 0,
    });
    expect(measure.delta(meas)).toEqual(0);
  });

  /**
   * Runs one test: zero the counters, execute `n`, and measure it
   */
  const runTest = (
    measure: TestCoverageMeasure,
    absValue: (n: number) => number,
    n: number,
    input: InputAndSource
  ) => {
    measure.onBeforeNextTestExecution();
    absValue(n);
    return measure.measure(input, anyResult);
  }; // fn: runTest

  // an input's own coverage should not depend on the run's history
  it("measure reports the same coverage for an input no matter what ran before it", () => {
    const coverageByInput = (order: number[]): Record<number, string[]> => {
      const { measure, absValue } = load(1, jsSrc3);
      const seen: Record<number, string[]> = {};
      order.forEach((n, tick) => {
        const meas = runTest(measure, absValue, n, inputAt(tick));
        seen[n] = coveredKeys(meas.coverageMeasure.current);
      });
      return seen;
    };

    const forward = coverageByInput([-3, 0, 7]);
    const reverse = coverageByInput([7, 0, -3]);

    expect(forward[-3].length).toBeGreaterThan(0); // guard: non-trivial
    for (const n of [-3, 0, 7]) {
      expect(reverse[n]).toEqual(forward[n]);
    }
  });

  // the coverage a run finds should be independent of input order
  it("the coverage a run discovers does not depend on the order of its inputs", () => {
    const runOrder = (
      order: number[]
    ): { deltaSum: number; discovered: string[] } => {
      const { measure, absValue } = load(1, jsSrc3);
      const discovered = new Set<string>();
      let deltaSum = 0;
      order.forEach((n, tick) => {
        const meas = runTest(measure, absValue, n, inputAt(tick));
        coveredKeys(meas.coverageMeasure.current).forEach((k) =>
          discovered.add(k)
        );
        deltaSum += meas.coverageMeasure.globalDelta;
      });
      return { deltaSum, discovered: [...discovered].sort() };
    };

    const forward = runOrder([-3, 0, 7]);
    expect(forward.discovered.length).toBeGreaterThan(0); // guard: non-trivial

    for (const order of [
      [7, 0, -3],
      [0, 7, -3],
    ]) {
      const other = runOrder(order);

      // The same inputs cover the same items either way...
      expect(other.discovered).toEqual(forward.discovered);

      // ...and the run accounts for every item it covered, once
      expect(other.deltaSum).toEqual(forward.discovered.length);
    }
    expect(forward.deltaSum).toEqual(forward.discovered.length);
  });

  // inputs with no predecessor should report no lineage progress
  it("measure reports no lineage progress for an input with no predecessor", () => {
    const { measure, absValue } = load(1, jsSrc3);

    // A user/random input carries no source tick...
    const root = runTest(measure, absValue, -3, inputAt(0));
    expect(root.coverageMeasure.accumDelta).toEqual(0);

    // ...and neither does a mutant whose source tick is unset
    const orphan = runTest(measure, absValue, 0, mutantAt(1));
    expect(orphan.coverageMeasure.accumDelta).toEqual(0);

    // A dangling predecessor reference is tolerated the same way
    const dangling = runTest(measure, absValue, 7, mutantAt(2, 99));
    expect(dangling.coverageMeasure.accumDelta).toEqual(0);
  });

  // a descendant's coverage should accumulate into its lineage root
  it("measure accumulates a descendant's coverage into its lineage root", () => {
    const { measure, absValue } = load(1, jsSrc3);

    runTest(measure, absValue, -3, inputAt(0)); // root: negative path
    runTest(measure, absValue, 0, mutantAt(1, 0)); // child of root: zero path
    const sibling = runTest(measure, absValue, 7, mutantAt(2, 0)); // sibling: positive path
    const siblingKeys = coveredKeys(sibling.coverageMeasure.current);

    // The root's accumulated coverage absorbed its descendants' coverage
    const rootAccum = coveredKeys(measure.getCoverage(0).coverageMeasure.accum);
    for (const key of siblingKeys) {
      expect(rootAccum).toContain(key);
    }

    // A grandchild is scored against that same lineage root, not against
    // its own parent -- the parent never covered the positive path, but
    // the root's lineage has, so this covers nothing new
    const grandchild = runTest(measure, absValue, 7, mutantAt(3, 1));
    expect(grandchild.coverageMeasure.accumDelta).toEqual(0);
  });

  // lineage progress shoulb only be reported for coverage new to the lineage
  it("measure reports lineage progress only for coverage new to the lineage", () => {
    const { measure, absValue } = load(1, jsSrc3);

    runTest(measure, absValue, -3, inputAt(0)); // root: negative path
    const novel = runTest(measure, absValue, 7, mutantAt(1, 0)); // child: positive path
    const dupe = runTest(measure, absValue, 7, mutantAt(2, 0)); // child: same path again

    expect(novel.coverageMeasure.accumDelta).toBeGreaterThan(0);
    expect(dupe.coverageMeasure.accumDelta).toEqual(0);
  });

  // a measurement's accumulated coverage should include its own
  it("a measurement's accumulated coverage includes the coverage it measured", () => {
    const { measure, absValue } = load(1, jsSrc3);

    const inputs = [inputAt(0), mutantAt(1, 0), mutantAt(2, 1)];
    [-3, 0, 7].forEach((n, i) => {
      const meas = runTest(measure, absValue, n, inputs[i]);
      const current = coveredKeys(meas.coverageMeasure.current);
      const accum = coveredKeys(meas.coverageMeasure.accum);

      expect(current.length).toBeGreaterThan(0); // guard: non-trivial
      for (const key of current) {
        expect(accum).toContain(key);
      }
    });
  });

  // `current` should hold exactly the coverage the measured input
  it("measure records exactly the coverage of the input it measured", () => {
    const { measure, absValue } = load();

    measure.onBeforeNextTestExecution();
    absValue(-3); // takes the `if (n < 0)` branch and returns early
    const meas = measure.measure(inputAt(0), anyResult);

    // The measurement is a coverage map of the file under test...
    const current = meas.coverageMeasure.current;
    expect(current.files()).toEqual([jsFileName]);

    // ...whose counters are exactly the negative path
    const fileCoverage = current.fileCoverageFor(jsFileName);
    expect(fileCoverage.path).toEqual(jsFileName);
    expect(fileCoverage.s).toEqual({
      0: 1, // `if (n < 0)`      executed
      1: 1, // `return -n;`      executed
      2: 0, // `return n;`       not reached
      3: 0, // `module.exports`  zeroed by the reset before this test
    });
    expect(fileCoverage.f).toEqual({ 0: 1 }); // absValue entered once
    expect(fileCoverage.b).toEqual({ 0: [1, 0] }); // if taken, else not

    // ...and the measurement carries the base measure fields
    expect(meas.type).toEqual("measure");
    expect(meas.name).toEqual("CoverageMeasure");
  });

  it("measure records exactly the coverage of a second, different input", () => {
    const { measure, absValue } = load();

    measure.onBeforeNextTestExecution();
    absValue(7); // skips the `if`, falls through to `return n`
    const meas = measure.measure(inputAt(0), anyResult);

    const fileCoverage =
      meas.coverageMeasure.current.fileCoverageFor(jsFileName);
    expect(fileCoverage.s).toEqual({ 0: 1, 1: 0, 2: 1, 3: 0 });
    expect(fileCoverage.f).toEqual({ 0: 1 });
    expect(fileCoverage.b).toEqual({ 0: [0, 1] }); // else taken, if not

    // A second test starting from a reset does not inherit the first
    measure.onBeforeNextTestExecution();
    absValue(-3);
    const second = measure.measure(inputAt(1), anyResult);
    const secondCoverage =
      second.coverageMeasure.current.fileCoverageFor(jsFileName);
    expect(secondCoverage.s).toEqual({ 0: 1, 1: 1, 2: 0, 3: 0 });
    expect(secondCoverage.b).toEqual({ 0: [1, 0] });
  });

  // each input should be credited with exactly the items it added to the
  it("measure credits each input with exactly the coverage it added", () => {
    const { measure, absValue } = load(1, jsSrc3);

    // The three paths of jsSrc3 cover 10 distinct items between them:
    // f0, s0..s4, b0.0, b0.1, b1.0, b1.1
    const deltas = [-3, 0, 7].map((n, tick) => {
      measure.onBeforeNextTestExecution();
      absValue(n);
      return measure.measure(inputAt(tick), anyResult).coverageMeasure
        .globalDelta;
    });

    expect(deltas).toEqual([
      4, // f0, s0, s1, b0.0
      4, // b0.1, s2, s3, b1.0   (f0 and s0 already credited to the first input)
      2, // s4, b1.1
    ]);
    expect(deltas.reduce((sum, delta) => sum + delta, 0)).toEqual(10);

    // An input that covers nothing new is credited nothing
    measure.onBeforeNextTestExecution();
    absValue(-3);
    expect(
      measure.measure(inputAt(3), anyResult).coverageMeasure.globalDelta
    ).toEqual(0);
  });

  /**
   * Runs `n` through `src` as a single test and returns the file coverage
   * the measurement recorded for it.
   */
  const coverageOfCall = (src: string, n: number): FileCoverage => {
    const { measure, absValue } = load(1, src);
    measure.onBeforeNextTestExecution();
    absValue(n);
    return measure
      .measure(inputAt(0), anyResult)
      .coverageMeasure.current.fileCoverageFor(jsFileName);
  }; // fn: coverageOfCall

  it("measure reports statements and one function for branch-free code", () => {
    const fileCoverage = coverageOfCall(jsSrcLinear, 5);

    // The initializer of `const doubled`, the return, and module.exports
    expect(Object.keys(fileCoverage.statementMap)).toEqual(["0", "1", "2"]);
    expect(fileCoverage.statementMap[0]).toEqual({
      start: { line: 2, column: 18 }, // `n * 2`, not the whole declaration
      end: { line: 2, column: 23 },
    });
    expect(fileCoverage.statementMap[1]).toEqual({
      start: { line: 3, column: 2 },
      end: { line: 3, column: 17 },
    });
    expect(fileCoverage.statementMap[2]).toEqual({
      start: { line: 5, column: 0 },
      end: { line: 5, column: 30 },
    });
    expect(fileCoverage.s).toEqual({ 0: 1, 1: 1, 2: 0 });

    expect(fileCoverage.fnMap).toEqual({
      0: {
        name: "absValue",
        decl: { start: { line: 1, column: 9 }, end: { line: 1, column: 17 } },
        loc: { start: { line: 1, column: 21 }, end: { line: 4, column: 1 } },
        line: 1,
      },
    });
    expect(fileCoverage.f).toEqual({ 0: 1 });

    // Nothing to branch on, so both the map and its counters are empty
    expect(fileCoverage.branchMap).toEqual({});
    expect(fileCoverage.b).toEqual({});
  });

  it("measure reports a ternary as a cond-expr branch of an anonymous function", () => {
    const fileCoverage = coverageOfCall(jsSrcTernary, -3);

    // An arrow assigned to a const is not named after the const
    expect(fileCoverage.fnMap[0].name).toEqual("(anonymous_0)");
    expect(fileCoverage.fnMap[0].line).toEqual(1);
    expect(fileCoverage.fnMap[0].loc).toEqual({
      start: { line: 1, column: 25 },
      end: { line: 1, column: 39 },
    });
    expect(fileCoverage.f).toEqual({ 0: 1 });

    expect(Object.keys(fileCoverage.branchMap)).toEqual(["0"]);
    expect(fileCoverage.branchMap[0].type).toEqual("cond-expr");
    expect(fileCoverage.branchMap[0].line).toEqual(1);
    expect(fileCoverage.branchMap[0].loc).toEqual({
      start: { line: 1, column: 25 },
      end: { line: 1, column: 39 },
    });
    expect(fileCoverage.branchMap[0].locations).toEqual([
      { start: { line: 1, column: 33 }, end: { line: 1, column: 35 } }, // `-n`
      { start: { line: 1, column: 38 }, end: { line: 1, column: 39 } }, // `n`
    ]);
    expect(fileCoverage.b).toEqual({ 0: [1, 0] }); // consequent taken only
  });

  it("measure counts each operand of a short-circuiting expression", () => {
    // `n || 0` with a truthy left operand: the right one never evaluates
    const truthy = coverageOfCall(jsSrcLogical, 7);
    expect(truthy.branchMap[0].type).toEqual("binary-expr");
    expect(truthy.branchMap[0].line).toEqual(2);
    expect(truthy.branchMap[0].locations).toEqual([
      { start: { line: 2, column: 9 }, end: { line: 2, column: 10 } }, // `n`
      { start: { line: 2, column: 14 }, end: { line: 2, column: 15 } }, // `0`
    ]);
    expect(truthy.b).toEqual({ 0: [1, 0] });

    // ...and with a falsy left operand both operands are evaluated
    expect(coverageOfCall(jsSrcLogical, 0).b).toEqual({ 0: [1, 1] });
  });

  it("measure reports a switch as one branch with an arm per case", () => {
    const fileCoverage = coverageOfCall(jsSrcSwitch, 1);

    expect(fileCoverage.branchMap[0].type).toEqual("switch");
    expect(fileCoverage.branchMap[0].line).toEqual(2);
    expect(fileCoverage.branchMap[0].loc).toEqual({
      start: { line: 2, column: 2 }, // the whole switch statement
      end: { line: 9, column: 3 },
    });
    expect(fileCoverage.branchMap[0].locations.length).toEqual(3);
    expect(
      fileCoverage.branchMap[0].locations.map((l) => l.start.line)
    ).toEqual([3, 5, 7]); // `case 0:`, `case 1:`, `default:`
    expect(fileCoverage.b).toEqual({ 0: [0, 1, 0] }); // only `case 1` taken

    // The switch itself and the taken case body ran; the others did not
    expect(fileCoverage.s).toEqual({ 0: 1, 1: 0, 2: 1, 3: 0, 4: 0 });
  });

  it("measure reports every function in the file, called or not", () => {
    const fileCoverage = coverageOfCall(jsSrcTwoFns, -4);

    expect(Object.keys(fileCoverage.fnMap)).toEqual(["0", "1", "2"]);
    expect(
      Object.values(fileCoverage.fnMap).map((fn) => [fn.name, fn.line])
    ).toEqual([
      ["absValue", 1],
      ["helper", 4],
      ["neverCalled", 7],
    ]);
    expect(fileCoverage.fnMap[1].decl).toEqual({
      start: { line: 4, column: 9 },
      end: { line: 4, column: 15 },
    });

    // absValue called helper; neverCalled was never entered
    expect(fileCoverage.f).toEqual({ 0: 1, 1: 1, 2: 0 });

    // The only branch is the ternary inside helper
    expect(Object.keys(fileCoverage.branchMap)).toEqual(["0"]);
    expect(fileCoverage.branchMap[0].type).toEqual("cond-expr");
    expect(fileCoverage.branchMap[0].line).toEqual(5);
    expect(fileCoverage.b).toEqual({ 0: [1, 0] });
  });

  it("measure repeats the location maps unchanged while the counters change", () => {
    const { measure, absValue } = load(1, jsSrcLogical);

    measure.onBeforeNextTestExecution();
    absValue(7);
    const first = measure
      .measure(inputAt(0), anyResult)
      .coverageMeasure.current.fileCoverageFor(jsFileName);
    const maps = {
      statementMap: JSON.parse(JSON.stringify(first.statementMap)),
      fnMap: JSON.parse(JSON.stringify(first.fnMap)),
      branchMap: JSON.parse(JSON.stringify(first.branchMap)),
    };
    expect(first.b).toEqual({ 0: [1, 0] });

    measure.onBeforeNextTestExecution();
    absValue(0);
    const second = measure
      .measure(inputAt(1), anyResult)
      .coverageMeasure.current.fileCoverageFor(jsFileName);

    // The reset zeroes counters only: the location maps are untouched
    expect(second.statementMap).toEqual(maps.statementMap);
    expect(second.fnMap).toEqual(maps.fnMap);
    expect(second.branchMap).toEqual(maps.branchMap);
    expect(second.b).toEqual({ 0: [1, 1] });
  });

  // ------------------------------------------------------------------
  // Multi-file measurement. A real run loads the module under test together
  // with every module it imports, and all of them publish into the one
  // `__coverage__` the measure binds to. So a measurement is a map over
  // *files*, and each of the fields `measure()` builds -- `current`, the
  // global delta, and the lineage accumulator -- has to span them.
  // ------------------------------------------------------------------

  const fileA = "/tmp/multiFileA.js"; // twoPathSource: 4 stmts, 1 fn, 1 branch
  const fileB = "/tmp/multiFileB.js"; // linearSource:  3 stmts, 1 fn, no branch

  /**
   * Instruments and loads several modules into a single context, the way a
   * run loads the module under test together with the modules it imports,
   * and binds a fresh measure to the coverage they all publish there.
   *
   * @param `files` the modules to load, as `[filename, source]` pairs
   * @returns the measure, and each module's exported `absValue` by filename
   */
  const loadFiles = (
    files: [string, string][]
  ): { measure: TestCoverageMeasure; fns: Record<string, NumericFn> } => {
    const measure = new TestCoverageMeasure();
    const module: { exports: Record<string, unknown> } = { exports: {} };
    const sandbox: VmGlobals = { module, exports: module.exports };
    sandbox.global = sandbox;
    vm.createContext(sandbox);

    const fns: Record<string, NumericFn> = {};
    for (const [fileName, src] of files) {
      // Each module gets its own exports, but they share `__coverage__`
      module.exports = {};
      sandbox.exports = module.exports;
      vm.runInContext(measure.onAfterCompile(src, fileName), sandbox, {
        filename: fileName,
      });
      fns[fileName] = fnOfExports(module.exports, fileName);
    }
    measure.onAfterLoad(sandbox);

    return { measure, fns };
  }; // fn: loadFiles

  /**
   * Returns the `absValue` that `exports` exports
   */
  const fnOfExports = (
    exports: Record<string, unknown>,
    fileName: string
  ): NumericFn => {
    const absValue = exports.absValue;
    if (!isNumericFn(absValue)) {
      throw new Error(`${fileName} did not export absValue`);
    }
    return absValue;
  }; // fn: fnOfExports

  it("measure records each file's own coverage when a test runs through two", () => {
    const { measure, fns } = loadFiles([
      [fileA, jsSrc],
      [fileB, jsSrcLinear],
    ]);

    measure.onBeforeNextTestExecution();
    fns[fileA](-3); // takes the `if (n < 0)` branch and returns early
    fns[fileB](5); // straight through, no branches to take
    const current = measure.measure(inputAt(0), anyResult).coverageMeasure
      .current;

    // The measurement is a map over both files...
    expect(current.files().sort()).toEqual([fileA, fileB].sort());

    // ...and each carries its own counters, not the other's
    const a = current.fileCoverageFor(fileA);
    expect(a.path).toEqual(fileA);
    expect(a.s).toEqual({
      0: 1, // `if (n < 0)`      executed
      1: 1, // `return -n;`      executed
      2: 0, // `return n;`       not reached
      3: 0, // `module.exports`  zeroed by the reset before this test
    });
    expect(a.f).toEqual({ 0: 1 });
    expect(a.b).toEqual({ 0: [1, 0] }); // if taken, else not

    const b = current.fileCoverageFor(fileB);
    expect(b.path).toEqual(fileB);
    expect(b.s).toEqual({
      0: 1, // `n * 2`           executed
      1: 1, // `return doubled;` executed
      2: 0, // `module.exports`  zeroed by the reset before this test
    });
    expect(b.f).toEqual({ 0: 1 });
    expect(b.b).toEqual({}); // the linear fixture has no branches
  });

  it("measure reports a loaded file the test never entered as uncovered", () => {
    const { measure, fns } = loadFiles([
      [fileA, jsSrc],
      [fileB, jsSrcLinear],
    ]);

    measure.onBeforeNextTestExecution();
    fns[fileA](-3); // only file A runs
    const current = measure.measure(inputAt(0), anyResult).coverageMeasure
      .current;

    // File B was loaded, so it is described and counted...
    expect(current.files().sort()).toEqual([fileA, fileB].sort());
    const b = current.fileCoverageFor(fileB);
    expect(Object.keys(b.statementMap)).toEqual(["0", "1", "2"]);
    expect(Object.keys(b.fnMap)).toEqual(["0"]);

    // ...but nothing in it is marked covered
    expect(b.s).toEqual({ 0: 0, 1: 0, 2: 0 });
    expect(b.f).toEqual({ 0: 0 });

    // The file that did run is unaffected by the one that did not
    expect(current.fileCoverageFor(fileA).f).toEqual({ 0: 1 });
    expect(current.fileCoverageFor(fileA).b).toEqual({ 0: [1, 0] });

    // The measurement's totals span both files, and only A's are covered
    const summary = current.getCoverageSummary().toJSON();
    expect(summary.statements.total).toEqual(7); // 4 in A, 3 in B
    expect(summary.statements.covered).toEqual(2); // A's `if` and `return -n`
    expect(summary.functions.total).toEqual(2); // one per file
    expect(summary.functions.covered).toEqual(1); // only A's ran
    expect(summary.branches.total).toEqual(2); // A's `if`; B has none
    expect(summary.branches.covered).toEqual(1);
  });

  it("measure credits an input for the coverage it added in any file", () => {
    const { measure, fns } = loadFiles([
      [fileA, jsSrc],
      [fileB, jsSrcLinear],
    ]);

    // The first input runs file A's negative path and never enters B
    measure.onBeforeNextTestExecution();
    fns[fileA](-3);
    const first = measure.measure(inputAt(0), anyResult).coverageMeasure
      .globalDelta;

    // The second repeats it and additionally runs file B, so everything it
    // is credited with was discovered in the other file
    measure.onBeforeNextTestExecution();
    fns[fileA](-3);
    fns[fileB](5);
    const second = measure.measure(inputAt(1), anyResult).coverageMeasure
      .globalDelta;

    // The third adds file A's other arm, while repeating B
    measure.onBeforeNextTestExecution();
    fns[fileA](7);
    fns[fileB](5);
    const third = measure.measure(inputAt(2), anyResult).coverageMeasure
      .globalDelta;

    // A fourth that repeats what both files have already covered adds nothing
    measure.onBeforeNextTestExecution();
    fns[fileA](-3);
    fns[fileB](5);
    const fourth = measure.measure(inputAt(3), anyResult).coverageMeasure
      .globalDelta;

    expect(first).toEqual(4); // A: f0, s0, s1, b0.0
    expect(second).toEqual(3); // B: f0, s0, s1 -- A added nothing
    expect(third).toEqual(2); // A: s2, b0.1 -- B added nothing
    expect(fourth).toEqual(0);

    // Between them the inputs covered every item in both files that a call
    // can reach: 4 + 3 of A's 7, and 3 of B's 4 (the `module.exports`
    // statements only run at load, before the first reset)
    expect(first + second + third + fourth).toEqual(9);
  });

  it("measure reports lineage progress for coverage new in another file", () => {
    const { measure, fns } = loadFiles([
      [fileA, jsSrc],
      [fileB, jsSrcLinear],
    ]);

    // The lineage root runs only file A
    measure.onBeforeNextTestExecution();
    fns[fileA](-3);
    measure.measure(inputAt(0), anyResult);

    // A child that reaches into file B is new to the lineage...
    measure.onBeforeNextTestExecution();
    fns[fileA](-3);
    fns[fileB](5);
    const novel = measure.measure(mutantAt(1, 0), anyResult);
    expect(novel.coverageMeasure.accumDelta).toEqual(3); // B: f0, s0, s1

    // ...while a sibling that repeats it adds nothing to the lineage
    measure.onBeforeNextTestExecution();
    fns[fileA](-3);
    fns[fileB](5);
    const dupe = measure.measure(mutantAt(2, 0), anyResult);
    expect(dupe.coverageMeasure.accumDelta).toEqual(0);

    // The root's accumulated coverage now spans both files, though it only
    // ever ran through one itself. Note that accumulating is a merge, which
    // sums hit counts: `absValue` reads 2 because both descendants entered
    // it once. Only covered-ness feeds `accumDelta`, never the count.
    const rootAccum = measure.getCoverage(0).coverageMeasure.accum;
    expect(rootAccum.files().sort()).toEqual([fileA, fileB].sort());
    expect(rootAccum.fileCoverageFor(fileB).f).toEqual({ 0: 2 });
    expect(rootAccum.fileCoverageFor(fileB).s).toEqual({ 0: 2, 1: 2, 2: 0 });
  });

  it("measure does not carry a file's coverage into the next test", () => {
    const { measure, fns } = loadFiles([
      [fileA, jsSrc],
      [fileB, jsSrcLinear],
    ]);

    // The first test runs through both files
    measure.onBeforeNextTestExecution();
    fns[fileA](-3);
    fns[fileB](5);
    const firstB = measure
      .measure(inputAt(0), anyResult)
      .coverageMeasure.current.fileCoverageFor(fileB);
    expect(firstB.f).toEqual({ 0: 1 }); // guard: B really ran

    // The second runs through file A only, so the reset has to have zeroed
    // every file's counters, not just those of the first file it walked
    measure.onBeforeNextTestExecution();
    fns[fileA](7);
    const second = measure.measure(inputAt(1), anyResult).coverageMeasure
      .current;

    expect(second.fileCoverageFor(fileB).s).toEqual({ 0: 0, 1: 0, 2: 0 });
    expect(second.fileCoverageFor(fileB).f).toEqual({ 0: 0 });

    // ...and file A shows this test's path, not the union with the last
    expect(second.fileCoverageFor(fileA).s).toEqual({ 0: 1, 1: 0, 2: 1, 3: 0 });
    expect(second.fileCoverageFor(fileA).b).toEqual({ 0: [0, 1] });
  });

  // Files in different directories. A coverage map is keyed by path, and
  // every consumer -- the merge, the per-file stats, the heatmap's lookup --
  // keys on the whole path rather than the file's name. These pin that, so
  // that shortening a key to a basename anywhere downstream fails loudly.

  const dirCore = "/tmp/proj/pkg/core.js"; // twoPathSource
  const dirUtil = "/tmp/proj/lib/util.js"; // linearSource

  it("measure keeps files in separate directories apart", () => {
    const { measure, fns } = loadFiles([
      [dirCore, jsSrc],
      [dirUtil, jsSrcLinear],
    ]);

    measure.onBeforeNextTestExecution();
    fns[dirCore](-3);
    fns[dirUtil](5);
    const current = measure.measure(inputAt(0), anyResult).coverageMeasure
      .current;

    // Each directory's file is its own entry, keyed and named by full path
    expect(current.files().sort()).toEqual([dirCore, dirUtil].sort());
    expect(current.fileCoverageFor(dirCore).path).toEqual(dirCore);
    expect(current.fileCoverageFor(dirUtil).path).toEqual(dirUtil);

    // ...carrying the counters of the file at that path, and no other
    expect(current.fileCoverageFor(dirCore).s).toEqual({
      0: 1,
      1: 1,
      2: 0,
      3: 0,
    });
    expect(current.fileCoverageFor(dirCore).b).toEqual({ 0: [1, 0] });
    expect(current.fileCoverageFor(dirUtil).s).toEqual({ 0: 1, 1: 1, 2: 0 });
    expect(current.fileCoverageFor(dirUtil).b).toEqual({});
  });

  it("measure does not conflate two files sharing a basename", () => {
    // Same file name in two directories, and the same source in both, so
    // only the path distinguishes them
    const pkgUtil = "/tmp/proj/pkg/util.js";
    const libUtil = "/tmp/proj/lib/util.js";
    const { measure, fns } = loadFiles([
      [pkgUtil, jsSrc],
      [libUtil, jsSrc],
    ]);

    // The first test takes the `if` in one of them only
    measure.onBeforeNextTestExecution();
    fns[pkgUtil](-3);
    const first = measure.measure(inputAt(0), anyResult).coverageMeasure;

    expect(first.current.files().sort()).toEqual([libUtil, pkgUtil].sort());
    expect(first.current.fileCoverageFor(pkgUtil).b).toEqual({ 0: [1, 0] });
    expect(first.current.fileCoverageFor(libUtil).b).toEqual({ 0: [0, 0] });
    expect(first.current.fileCoverageFor(libUtil).f).toEqual({ 0: 0 });
    expect(first.globalDelta).toEqual(4); // f0, s0, s1, b0.0 of pkg/util

    // The second takes the other arm in the *other* file. Identical structure
    // and name, so if the two were keyed by basename this would look like
    // coverage already seen and be credited nothing.
    measure.onBeforeNextTestExecution();
    fns[libUtil](7);
    const second = measure.measure(inputAt(1), anyResult).coverageMeasure;

    expect(second.current.fileCoverageFor(libUtil).b).toEqual({ 0: [0, 1] });
    expect(second.current.fileCoverageFor(pkgUtil).b).toEqual({ 0: [0, 0] });
    expect(second.globalDelta).toEqual(4); // f0, s0, s2, b0.1 of lib/util
  });

  // ------------------------------------------------------------------
  // onRunEnd: runs once the last test is done, and hands the run's
  // accumulated coverage to `results` as the stats the UI reads.
  //
  // These tests compile real TypeScript to JavaScript with a real source
  // map, rather than using the hand-written JS fixtures the tests above
  // use: mapping the run's JS coverage back to TypeScript locations is
  // most of what `onRunEnd` does, and there is nothing to map without one.
  // ------------------------------------------------------------------
  describe("onRunEnd", () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-coverage-"));
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * A TypeScript fixture compiled to JavaScript on disk
     */
    type TsProgram = {
      tsFile: string; // path of the TypeScript source
      jsFile: string; // path of the compiled JavaScript
      js: string; // the compiled JavaScript itself
    };

    /**
     * Compiles `tsSrc` to JavaScript and writes the result and its source
     * map to `tmpDir`. `onAfterCompile` reads the map from `<jsFile>.map`,
     * so it has to be a real file on disk.
     *
     * The options mirror the ones `TypescriptCompiler` passes to `tsc`
     * (`--sourceMap --inlineSources`), plus the module and target that make
     * the output loadable by the test sandbox.
     *
     * @param `tsSrc` TypeScript source to compile
     * @param `base` base name to write the files under
     * @param `jsFile` path to write the JavaScript to, if not `tmpDir/base.js`
     * @returns the compiled program
     */
    const compileTs = (
      tsSrc: string,
      base: string,
      jsFile?: string
    ): TsProgram => {
      const tsFile = path.join(tmpDir, `${base}.ts`);
      const jsPath = jsFile ?? path.join(tmpDir, `${base}.js`);

      fs.writeFileSync(tsFile, tsSrc);
      const out = ts.transpileModule(tsSrc, {
        fileName: tsFile,
        compilerOptions: {
          sourceMap: true,
          inlineSources: true,
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      });
      if (!out.sourceMapText) {
        throw new Error(`no source map emitted for ${tsFile}`);
      }
      fs.writeFileSync(jsPath, out.outputText);
      fs.writeFileSync(`${jsPath}.map`, out.sourceMapText);

      return { tsFile, jsFile: jsPath, js: out.outputText };
    }; // fn: compileTs

    /**
     * Instruments and loads every program into a single context, the way a
     * real run loads the module under test together with the modules it
     * imports, and binds `measure` to the coverage data they publish there.
     *
     * @param `measure` the measure to instrument and bind with
     * @param `programs` the compiled programs to load, in load order
     * @returns each program's exports, in the order they were loaded
     */
    const loadTs = (
      measure: TestCoverageMeasure,
      programs: TsProgram[]
    ): Record<string, unknown>[] => {
      const module: { exports: Record<string, unknown> } = { exports: {} };
      const sandbox: VmGlobals = { module, exports: module.exports };
      sandbox.global = sandbox;
      vm.createContext(sandbox);

      const loaded: Record<string, unknown>[] = [];
      for (const program of programs) {
        // Each module gets its own exports, but they share `__coverage__`
        module.exports = {};
        sandbox.exports = module.exports;
        vm.runInContext(
          measure.onAfterCompile(program.js, program.jsFile),
          sandbox,
          { filename: program.jsFile }
        );
        loaded.push(module.exports);
      }
      measure.onAfterLoad(sandbox);

      return loaded;
    }; // fn: loadTs

    /**
     * Returns `exports`' function `name`, which the fixtures export
     */
    const fnOf = (
      exports: Record<string, unknown>,
      name: string
    ): NumericFn => {
      const fn = exports[name];
      if (!isNumericFn(fn)) {
        throw new Error(`fixture did not export ${name}`);
      }
      return fn;
    }; // fn: fnOf

    /**
     * A results object shaped like the one the fuzzer hands to `onRunEnd`.
     *
     * This is a complete `FuzzTestResults` rather than the handful of fields
     * `onRunEnd` reads, so that a field added to the type is a compile error
     * here instead of a stub that quietly stops resembling the real thing.
     * Only `stats.measures` is the subject of these specs; every other value
     * is arbitrary, and the specs assert that `onRunEnd` leaves them alone.
     */
    const resultsStub = (): FuzzTestResults => ({
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
        },
        timers: { total: 21, compile: 5, put: 10, val: 1, gen: 2, measure: 3 },
        generators: {
          RandomInputGenerator: anyGeneratorStats(),
          MutationInputGenerator: anyGeneratorStats(),
          AiInputGenerator: anyGeneratorStats(),
        },
        measures: {},
      },
    });

    /**
     * Ends a run and returns the stats `onRunEnd` installed
     *
     * @param `measure` the measure whose run to end
     * @returns the run's code coverage stats
     */
    const statsOf = async (
      measure: TestCoverageMeasure
    ): Promise<CodeCoverageMeasureStats> => {
      const results = resultsStub();

      measure.onRunEnd(results);

      const stats = results.stats.measures.CodeCoverageMeasure;
      if (!stats) {
        throw new Error("onRunEnd installed no coverage stats");
      }
      return stats();
    }; // fn: statsOf

    // onRunEnd should write one field of `results` and nothing else
    it("onRunEnd installs its stats without disturbing the rest of the results", () => {
      const measure = new TestCoverageMeasure();
      const results = resultsStub();
      const before = {
        results: results.results,
        counters: { ...results.stats.counters },
        timers: { ...results.stats.timers },
      };

      measure.onRunEnd(results);

      // The stats arrive as a thunk the UI calls when it wants them
      expect(typeof results.stats.measures.CodeCoverageMeasure).toEqual(
        "function"
      );

      // ...and that is the only thing the run's results gained
      expect(Object.keys(results.stats.measures)).toEqual([
        "CodeCoverageMeasure",
      ]);
      expect(results.results).toBe(before.results);
      expect(results.stats.counters).toEqual(before.counters);
      expect(results.stats.timers).toEqual(before.timers);
    });

    // the stats should be the union of what the run's inputs covered
    it("the stats report exactly the coverage the run's inputs were credited with", async () => {
      const measure = new TestCoverageMeasure();
      const [exports] = loadTs(measure, [compileTs(tsSrc3, "credited")]);
      const absValue = fnOf(exports, "absValue");

      // Each input is credited with the coverage it added to the run
      const deltas = [-3, 0, 7].map(
        (n, tick) =>
          runTest(measure, absValue, n, inputAt(tick)).coverageMeasure
            .globalDelta
      );
      expect(deltas).toEqual([4, 4, 2]); // guard: the run found something

      const stats = await statsOf(measure);

      // ...and the run's stats report exactly those credits, no more and
      // no less: nothing was lost or double counted on the way out
      const covered =
        stats.counters.functionsCovered +
        stats.counters.statementsCovered +
        stats.counters.branchesCovered;
      expect(covered).toEqual(deltas.reduce((sum, delta) => sum + delta, 0));
      expect(covered).toEqual(10);
    });

    // totals describe the source, not the run
    it("the stats report the same totals no matter which paths the run took", async () => {
      const countersFor = async (inputs: number[]) => {
        const measure = new TestCoverageMeasure();
        const [exports] = loadTs(measure, [
          compileTs(tsSrcTwoFns, `totals${inputs.length}`),
        ]);
        const absValue = fnOf(exports, "absValue");
        inputs.forEach((n, tick) =>
          runTest(measure, absValue, n, inputAt(tick))
        );
        return (await statsOf(measure)).counters;
      };

      // One input takes the negative arm of the ternary; the other run adds
      // a positive input, which takes the arm the first one missed
      const negative = await countersFor([-4]);
      const both = await countersFor([-4, 4]);

      // The totals are identical: three functions, six statements, and one
      // two-armed branch are in the source whatever the run does with them.
      // Only `branchesCovered` moves, because that is all the second input
      // added -- `neverCalled` is never called in either run.
      expect(negative).toEqual({
        functionsTotal: 3,
        functionsCovered: 2,
        statementsTotal: 6,
        statementsCovered: 2,
        branchesTotal: 2,
        branchesCovered: 1,
      });
      expect(both).toEqual({
        functionsTotal: 3,
        functionsCovered: 2,
        statementsTotal: 6,
        statementsCovered: 2,
        branchesTotal: 2,
        branchesCovered: 2,
      });

      // Nothing can be covered that is not there to cover
      for (const counters of [negative, both]) {
        expect(counters.functionsCovered).toBeLessThanOrEqual(
          counters.functionsTotal
        );
        expect(counters.statementsCovered).toBeLessThanOrEqual(
          counters.statementsTotal
        );
        expect(counters.branchesCovered).toBeLessThanOrEqual(
          counters.branchesTotal
        );
      }
    });

    // the headline counters should agree with the per-file breakdown
    it("the global counters are the sum of the per-file counters", async () => {
      const measure = new TestCoverageMeasure();
      const twoPath = compileTs(tsSrc, "sumTwoPath");
      const linear = compileTs(tsSrcLinear, "sumLinear");
      const [twoPathExports, linearExports] = loadTs(measure, [
        twoPath,
        linear,
      ]);

      // One test that runs code in both files
      measure.onBeforeNextTestExecution();
      fnOf(twoPathExports, "absValue")(-3);
      fnOf(linearExports, "double")(5);
      measure.measure(inputAt(0), anyResult);

      const stats = await statsOf(measure);
      expect(stats.files.length).toEqual(2); // guard: the sum is non-trivial

      const summed = stats.files.reduce(
        (sum, file) => ({
          functionsTotal: sum.functionsTotal + file.counters.functionsTotal,
          functionsCovered:
            sum.functionsCovered + file.counters.functionsCovered,
          statementsTotal: sum.statementsTotal + file.counters.statementsTotal,
          statementsCovered:
            sum.statementsCovered + file.counters.statementsCovered,
          branchesTotal: sum.branchesTotal + file.counters.branchesTotal,
          branchesCovered: sum.branchesCovered + file.counters.branchesCovered,
        }),
        {
          functionsTotal: 0,
          functionsCovered: 0,
          statementsTotal: 0,
          statementsCovered: 0,
          branchesTotal: 0,
          branchesCovered: 0,
        }
      );

      expect(stats.counters).toEqual(summed);
      expect(stats.counters).toEqual({
        functionsTotal: 2, // `absValue` and `double`
        functionsCovered: 2,
        statementsTotal: 7, // 4 in the two-path file, 3 in the linear one
        statementsCovered: 4,
        branchesTotal: 2, // the `if`, whose alternate went untaken
        branchesCovered: 1,
      });
    });

    // the counters the stats report can all be placed in a file
    it("every counter the stats report has a location to point at", async () => {
      const measure = new TestCoverageMeasure();
      const [exports] = loadTs(measure, [compileTs(tsSrcTwoFns, "locations")]);
      runTest(measure, fnOf(exports, "absValue"), -4, inputAt(0));

      const stats = await statsOf(measure);

      // Every counter key names an entry of the matching location map, which
      // is what the heatmap looks up to decide what to highlight
      for (const file of stats.files) {
        const { s, f, b, statementMap, fnMap, branchMap } = file.fileMap;
        expect(Object.keys(s).filter((k) => !(k in statementMap))).toEqual([]);
        expect(Object.keys(f).filter((k) => !(k in fnMap))).toEqual([]);
        expect(Object.keys(b).filter((k) => !(k in branchMap))).toEqual([]);
      }

      // Guard: the pruning that makes this worth checking really happened.
      // `neverCalled` was dropped from `f`, but it kept its `fnMap` entry
      // and is still counted as an uncovered function.
      const { fileMap } = stats.files[0];
      expect(Object.keys(fileMap.f)).toEqual(["0", "1"]);
      expect(Object.keys(fileMap.fnMap)).toEqual(["0", "1", "2"]);
      expect(fileMap.fnMap[2].name).toEqual("neverCalled");
      expect(
        stats.counters.functionsTotal - stats.counters.functionsCovered
      ).toEqual(1);
    });

    // the paths the stats report should be ones the UI can key on
    it("the stats report normalized paths to the TypeScript sources", async () => {
      const measure = new TestCoverageMeasure();
      const twoPath = compileTs(tsSrc, "pathsTwoPath");

      // Load the second module from a path that needs normalizing
      fs.mkdirSync(path.join(tmpDir, "nested"), { recursive: true });
      const linear = compileTs(
        tsSrcLinear,
        "pathsLinear",
        // Built by hand: `path.join` would normalize this away
        [tmpDir, "nested", "..", "pathsLinear.js"].join(path.sep)
      );
      expect(linear.jsFile).toContain(`nested${path.sep}..`); // guard

      const [twoPathExports, linearExports] = loadTs(measure, [
        twoPath,
        linear,
      ]);
      measure.onBeforeNextTestExecution();
      fnOf(twoPathExports, "absValue")(-3);
      fnOf(linearExports, "double")(5);
      measure.measure(inputAt(0), anyResult);

      const stats = await statsOf(measure);

      // The files reported are the TypeScript sources the run came from.
      // Both sides are normalized before comparing, because a reported path
      // is a key rather than a spelling: `normalizePathForKey` lowercases on
      // Windows, so the raw `tsFile` under `os.tmpdir()` is not it verbatim.
      expect(stats.files.map((file) => file.path).sort()).toEqual(
        [twoPath.tsFile, linear.tsFile].map(normalizePathForKey).sort()
      );

      for (const file of stats.files) {
        // ...named by an absolute, normalized path to a file that exists,
        // so that the UI can match them against open editors
        expect(file.path).toEqual(normalizePathForKey(file.path));
        expect(path.isAbsolute(file.path)).toBeTrue();
        expect(fs.existsSync(file.path)).toBeTrue();
        expect(path.extname(file.path)).toEqual(".ts"); // not the compiled JS

        // The file's own map agrees about where it came from, though only
        // the outer path is normalized: one `CodeCoverageFileStats` can
        // carry two spellings of the same file
        expect(normalizePathForKey(file.fileMap.path)).toEqual(file.path);
      }
    });

    // a run that measured nothing still needs to report stats
    it("onRunEnd reports empty stats for a run that measured nothing", async () => {
      const stats = await statsOf(new TestCoverageMeasure());

      expect(stats.counters).toEqual({
        functionsTotal: 0,
        functionsCovered: 0,
        statementsTotal: 0,
        statementsCovered: 0,
        branchesTotal: 0,
        branchesCovered: 0,
      });
      expect(stats.files).toEqual([]);
    });

    // the stats should be expressed in the source the user wrote
    it("the stats report TypeScript locations, not the compiled JavaScript ones", async () => {
      const measure = new TestCoverageMeasure();
      const program = compileTs(tsSrc, "tsLocations");
      const [exports] = loadTs(measure, [program]);

      runTest(measure, fnOf(exports, "absValue"), -3, inputAt(0));
      const stats = await statsOf(measure);

      expect(stats.files.length).toEqual(1);
      const file = stats.files[0];

      // The file reported is the TypeScript source, not the compiled JS
      expect(file.path).toEqual(normalizePathForKey(program.tsFile));

      // `return -n;` is line 6 of the emitted JavaScript...
      expect(program.js.split("\n")[5].trim()).toEqual("return -n;");

      // ...and line 3 of the TypeScript, which is what the stats report
      expect(file.fileMap.statementMap).toEqual({
        0: {
          // `export function absValue`, whose export assignment the
          // compiler hoists to the top of the emitted JavaScript
          start: { line: 1, column: 0 },
          end: { line: 1, column: 16 },
        },
        1: {
          start: { line: 2, column: 2 }, // `if (n < 0) {`
          end: { line: 4, column: 3 },
        },
        2: {
          start: { line: 3, column: 4 }, // `return -n;`
          end: { line: 3, column: 14 },
        },
        3: {
          start: { line: 5, column: 2 }, // `return n;`
          end: { line: 5, column: 11 },
        },
      });
      expect(file.fileMap.fnMap[0].name).toEqual("absValue");
      expect(file.fileMap.fnMap[0].loc).toEqual({
        start: { line: 1, column: 34 }, // the body of `absValue`
        end: { line: 6, column: 1 },
      });
      expect(file.fileMap.branchMap[0].type).toEqual("if");
      expect(file.fileMap.branchMap[0].loc).toEqual({
        start: { line: 2, column: 2 },
        end: { line: 4, column: 3 },
      });

      // The implicit `else` has no TypeScript location to map to. The
      // heatmap gets away with this only because it skips `if` branches
      // entirely (see CoverageHeatmap, istanbuljs issue 130).
      const elseArm = file.fileMap.branchMap[0].locations[1];
      expect(Object.keys(elseArm.start)).toEqual([]);
      expect(Object.keys(elseArm.end)).toEqual([]);

      // The counters are the run's: the export assignment ran before the
      // test did, so the reset zeroed it, and `return n` was never reached
      expect(file.fileMap.s).toEqual({ 0: 0, 1: 1, 2: 1, 3: 0 });
      expect(file.fileMap.f).toEqual({ 0: 1 });
      expect(file.fileMap.b).toEqual({ 0: [1, 0] }); // `if` taken, `else` not
      expect(file.counters).toEqual({
        functionsTotal: 1,
        functionsCovered: 1,
        statementsTotal: 4,
        statementsCovered: 2,
        branchesTotal: 2,
        branchesCovered: 1,
      });
      expect(stats.counters).toEqual(file.counters); // the only file
    });

    it("the stats report exact counters for a run that left code uncovered", async () => {
      const measure = new TestCoverageMeasure();
      const program = compileTs(tsSrcTwoFns, "uncovered");
      const [exports] = loadTs(measure, [program]);

      // `absValue(-4)` calls `helper`, which takes the negative arm of its
      // ternary. `neverCalled` is never called.
      runTest(measure, fnOf(exports, "absValue"), -4, inputAt(0));
      const stats = await statsOf(measure);

      expect(stats.files.length).toEqual(1);
      const file = stats.files[0];

      expect(file.path).toEqual(normalizePathForKey(program.tsFile));
      expect(file.counters).toEqual({
        functionsTotal: 3,
        functionsCovered: 2,
        statementsTotal: 6,
        statementsCovered: 2,
        branchesTotal: 2,
        branchesCovered: 1,
      });

      // The two functions that ran are reported with their hit counts; the
      // one that did not is omitted, and so is nothing else
      expect(file.fileMap.f).toEqual({ 0: 1, 1: 1 });
      expect(
        Object.values(file.fileMap.fnMap).map((fn) => [
          fn.name,
          fn.decl.start.line,
        ])
      ).toEqual([
        ["absValue", 1],
        ["helper", 4],
        ["neverCalled", 7],
      ]);

      // The ternary in `helper` kept both arms, so the heatmap can still
      // show which one went untaken
      expect(file.fileMap.b).toEqual({ 0: [1, 0] });
      expect(file.fileMap.branchMap[0].type).toEqual("cond-expr");

      // `return helper(n)` and `return n < 0 ? -n : n` ran; the export
      // assignments were zeroed by the reset and `return 0` never ran
      expect(file.fileMap.s).toEqual({ 0: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 0 });
    });
  });
});
