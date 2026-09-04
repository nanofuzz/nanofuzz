import {
  CoverageMap,
  CoverageMapData,
  FileCoverageData,
  createCoverageMap,
} from "istanbul-lib-coverage";
import { PythonCoverageMeasure } from "./PythonCoverageMeasure";
import { CodeCoverageMeasureStats } from "./AbstractCoverageMeasure";
import {
  CoverageInfo,
  FullCoverage,
  PythonRunner,
} from "../runners/PythonRunner";
import {
  ArgDef,
  FunctionDef,
  FuzzEnv,
  FuzzGeneratorStatsBase,
  FuzzStopReason,
  FuzzTestResult,
  FuzzTestResults,
  InputAndSource,
} from "../Fuzzer";
import { normalizePathForKey } from "../Util";
import {
  degenerateBranchRun,
  degenerateBranchStatic,
  earlyExitNoisyArcs,
  earlyExitSkipped,
  earlyExitStatic,
  earlyExitTaken,
  emptyStatic,
  linearRun,
  linearStatic,
  multiFunctionRun,
  multiFunctionStatic,
  nestedImportOnly,
  nestedOuterOnly,
  nestedStatic,
  PythonRun,
  pyFileName,
  threePathNegative,
  threePathPositive,
  threePathStatic,
  threePathZero,
  twoPathNegative,
  twoPathPositive,
  twoPathStatic,
} from "./test_fixtures/PythonCoverageMeasure.testfixture1";

/**
 * A `PythonRunner` that reports a fixed coverage report rather than spawning
 * Python.
 *
 * Only the report is stubbed. The constructor does no I/O -- a real runner
 * starts its host in `onRunStart`, which these specs never call -- so the
 * `coverageInfo` getter here is the inherited one, returning the live
 * `_coverageInfo` on every read exactly as it does during a real run.
 */
class StubPythonRunner extends PythonRunner {
  public constructor(coverage: FullCoverage) {
    super(Object.keys(coverage)[0] ?? pyFileName, "anyFn");
    this._coverageInfo = coverage;
  }
} // class: StubPythonRunner

/**
 * Connects the measure to a stub runner so that `measure()` can be driven
 * without spawning Python. The real `PythonRunner` keeps one `coverageInfo`
 * object alive for the whole run and replaces the `lines`/`arcs` of each file
 * it describes after every call; `record` does exactly that.
 *
 * The runner reports coverage for the whole program under test, keyed by file,
 * so a report is a `FullCoverage`. Most specs below describe a single Python
 * file, and name it with the constructor's `file` argument.
 */
class TestPythonCoverageMeasure extends PythonCoverageMeasure {
  private readonly _info: CoverageInfo;
  private readonly _coverage: FullCoverage;

  public constructor(staticInfo: CoverageInfo, file: string = pyFileName) {
    super();
    this._info = { ...staticInfo };
    this._coverage = { [file]: this._info };
    this._runner = new StubPythonRunner(this._coverage);
  }

  public record(run: PythonRun): void {
    this._info.lines = run.lines;
    this._info.arcs = run.arcs;
  }

  /**
   * The report the runner is holding for the single file these specs describe,
   * which is the measure's only source of coverage data
   */
  public get info(): CoverageInfo {
    return this._info;
  }

  /**
   * Exposes the translation from the runner's report into istanbul's shape,
   * which `measure()` performs on every call
   */
  public toCoverageMapData(coverage: FullCoverage): CoverageMapData {
    return this._toCoverageMapData(coverage);
  }
} // class: TestPythonCoverageMeasure

/**
 * Returns an input record for tick `tick` with no predecessor
 */
function inputAt(tick: number): InputAndSource {
  return { tick, value: [], source: { type: "unknown" } };
} // fn: inputAt

/**
 * Returns an input record for tick `tick` that was mutated from the input at
 * tick `from` (or from no input at all, if `from` is omitted)
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
  validatorException: false,
  timers: { gen: 0, transform: 0, run: 0 },
  category: "ok",
  interestingReasons: [],
};

/**
 * The environment of a run whose details do not matter here: `onRunEnd` reads
 * nothing from it, but `FuzzTestResults` requires it, and building a real one
 * keeps the stub honest. The function has no arguments because no spec calls
 * it -- these measures are driven by coverage reports, not by the PUT.
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
    useTransformer: false,
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
    module: pyFileName,
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
};

/**
 * Per-generator statistics for a run whose details do not matter here
 */
const anyGeneratorStats = (): FuzzGeneratorStatsBase => ({
  counters: { inputsGenerated: 0, dupesGenerated: 0 },
  timers: { run: 0, transform: 0, val: 0, gen: 0, measure: 0 },
});

/**
 * Returns a sorted, stable identifier for every item a coverage map says was
 * covered. Comparing these compares the coverage itself, not just its size.
 */
function coveredKeys(map: CoverageMap): string[] {
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

describe("fuzzer/analysis/measures/PythonCoverageMeasure:", () => {
  /**
   * Reports `run` as the most recent call and measures it as `input`
   */
  const runTest = (
    measure: TestPythonCoverageMeasure,
    run: PythonRun,
    input: InputAndSource
  ) => {
    measure.record(run);
    return measure.measure(input, anyResult);
  }; // fn: runTest

  /**
   * Measures a single call and returns the file coverage recorded for it
   */
  const coverageOfCall = (staticInfo: CoverageInfo, run: PythonRun) =>
    runTest(
      new TestPythonCoverageMeasure(staticInfo),
      run,
      inputAt(0)
    ).coverageMeasure.current.fileCoverageFor(pyFileName);

  // The whole-line spans coverage.py forces on every synthesized location
  const endOfLine = Number.MAX_SAFE_INTEGER;
  const wholeLine = (line: number) => ({
    start: { line, column: 0 },
    end: { line, column: endOfLine },
  });

  // ------------------------------------------------------------------
  // onBeforeNextTestExecution: runs between tests. `TypescriptCoverageMeasure`
  // overrides it to zero the counters its instrumentation accumulates; this
  // measure has no counters of its own, because coverage.py reports each call
  // separately and the runner replaces `lines`/`arcs` after every one. The
  // inherited no-op is therefore the correct behavior, and these tests pin it:
  // anything zeroed here would be taken out of the report the next `measure()`
  // reads, not out of a private accumulator.
  // ------------------------------------------------------------------

  // the reset should leave the runner's report exactly as it found it
  it("onBeforeNextTestExecution does not disturb the runner's coverage report", () => {
    const measure = new TestPythonCoverageMeasure(twoPathStatic);
    measure.record(twoPathNegative);
    const before = JSON.parse(JSON.stringify(measure.info));

    measure.onBeforeNextTestExecution();

    // Both halves survive: the static structure sent once at host start, and
    // the lines and arcs of the call that just ran
    expect(JSON.parse(JSON.stringify(measure.info))).toEqual(before);
    expect(measure.info.executable).toEqual([1, 2, 3, 4]);
    expect(measure.info.lines).toEqual([2, 3]);
    expect(measure.info.arcs).toEqual([[2, 3]]);
  });

  // after the reset the measure should still measure, and still measures each call on its own
  it("onBeforeNextTestExecution leaves each call measured on its own", () => {
    const measure = new TestPythonCoverageMeasure(twoPathStatic);

    measure.onBeforeNextTestExecution();
    const first = runTest(
      measure,
      twoPathNegative,
      inputAt(0)
    ).coverageMeasure.current.fileCoverageFor(pyFileName);
    expect(first.s).toEqual({ 0: 0, 1: 1, 2: 1, 3: 0 });
    expect(first.b).toEqual({ 0: [1, 0] });
    const firstKeys = coveredKeys(
      measure.getCoverage(0).coverageMeasure.current
    );

    // The next call inherits nothing from the first...
    measure.onBeforeNextTestExecution();
    const second = runTest(
      measure,
      twoPathPositive,
      inputAt(1)
    ).coverageMeasure.current.fileCoverageFor(pyFileName);
    expect(second.s).toEqual({ 0: 0, 1: 1, 2: 0, 3: 1 });
    expect(second.b).toEqual({ 0: [0, 1] });
    const secondKeys = coveredKeys(
      measure.getCoverage(1).coverageMeasure.current
    );

    // ...and that isolation comes from the runner, not from the reset: the
    // same calls measured without any reset produce the same coverage.
    // Each measurement's keys are read while it is the most recent one,
    // because a measurement's maps are not stable once the next is taken.
    const unreset = new TestPythonCoverageMeasure(twoPathStatic);
    const withoutReset = [twoPathNegative, twoPathPositive].map((run, tick) =>
      coveredKeys(runTest(unreset, run, inputAt(tick)).coverageMeasure.current)
    );
    expect(withoutReset).toEqual([firstKeys, secondKeys]);
  });

  // ------------------------------------------------------------------
  // _toCoverageMapData: the translation `measure()` performs on every call,
  // from coverage.py's lines and arcs into istanbul's statements, functions
  // and branches. Everything downstream -- merging, summarizing, pruning,
  // and the heatmap -- inherits whatever this gets wrong.
  // ------------------------------------------------------------------
  describe("_toCoverageMapData", () => {
    /**
     * Translates `info` and returns the coverage data for the one file it
     * describes. The constructor argument only seeds the stub runner, which
     * this call does not read.
     *
     * @param `info` the report to translate
     * @returns the translated coverage data for `pyFileName`
     */
    const dataFor = (info: CoverageInfo): FileCoverageData =>
      new TestPythonCoverageMeasure(info).toCoverageMapData({
        [pyFileName]: info,
      })[pyFileName];

    // every exit should be matched by `dest` and located by `line`
    it("matches a branch exit by its arc destination, not by its display line", () => {
      // The `if`-not-taken exit leaves the function: `dest` is -1, but there
      // is no line -1 to point at, so it displays on the branching line. The
      // host sorts exits by `dest`, so -1 sorts ahead of 3 and the exit that
      // displays on line 2 is arm 0. Matching on `line` rather than on `dest`
      // would therefore look for an arc into line 2 for that arm, and find
      // the entry arc into the function instead of the exit out of it.
      const taken = dataFor({ ...earlyExitStatic, ...earlyExitTaken });

      expect(taken.branchMap[0].locations).toEqual([
        wholeLine(2), // the exit out of the function, shown on the `if`
        wholeLine(3), // the `print(n)` the `if` jumps to
      ]);
      expect(taken.branchMap[0].loc).toEqual(wholeLine(2));

      // `report(-3)` took the `if`: the arc 2 -> 3 was reported, and the arc
      // out of the branching line, 2 -> -1, was not
      expect(taken.b).toEqual({ 0: [0, 1] });

      // `report(7)` skipped it, leaving the function from line 2 instead
      const skipped = dataFor({ ...earlyExitStatic, ...earlyExitSkipped });
      expect(skipped.b).toEqual({ 0: [1, 0] });

      // Both arms are located identically however the call went: only the
      // counters follow the call
      expect(skipped.branchMap).toEqual(taken.branchMap);
    });

    // arcs that are not this branch's exits should be ignored
    it("ignores arcs that are not exits of the branch they would flip", () => {
      const fileCoverage = dataFor({
        ...earlyExitStatic,
        ...earlyExitNoisyArcs,
      });

      // The report contains 3 -> -1, whose destination matches the first
      // exit, but whose source is not the branching line. It must not count.
      expect(fileCoverage.b).toEqual({ 0: [0, 1] });

      // The entry arc -1 -> 2 and the unrelated 7 -> 8 add nothing at all
      expect(Object.keys(fileCoverage.branchMap)).toEqual(["0"]);
      expect(Object.keys(fileCoverage.b)).toEqual(["0"]);
      expect(Object.keys(fileCoverage.statementMap)).toEqual(["0", "1", "2"]);
    });

    // arcs are matched by value, not by identity
    it("matches an arc reported as a fresh array", () => {
      // Nothing in the report shares an object with the static structure: the
      // host sends the two halves as separate JSON messages
      const fileCoverage = dataFor({
        ...earlyExitStatic,
        lines: [2, 3],
        arcs: [[1 + 1, 3]],
      });

      expect(fileCoverage.b).toEqual({ 0: [0, 1] });
    });

    //a call that reported nothing is all zeros, not an error
    it("reports the full structure with zero counters for a call that reported nothing", () => {
      // The runner clears `lines` and `arcs` when a call times out or throws
      const fileCoverage = dataFor({
        ...twoPathStatic,
        lines: undefined,
        arcs: undefined,
      });

      // Every statement, function and branch is still described...
      expect(Object.keys(fileCoverage.statementMap)).toEqual([
        "0",
        "1",
        "2",
        "3",
      ]);
      expect(fileCoverage.statementMap[1]).toEqual(wholeLine(2));
      expect(Object.keys(fileCoverage.fnMap)).toEqual(["0"]);
      expect(fileCoverage.branchMap[0].locations).toEqual([
        wholeLine(3),
        wholeLine(4),
      ]);

      // ...and nothing at all is marked covered
      expect(fileCoverage.s).toEqual({ 0: 0, 1: 0, 2: 0, 3: 0 });
      expect(fileCoverage.f).toEqual({ 0: 0 });
      expect(fileCoverage.b).toEqual({ 0: [0, 0] });
    });

    // a branch with fewer than two arms should not corrupt anything
    it("reports a branch with fewer than two exits without corrupting the summary", () => {
      const fileCoverage = dataFor({
        ...degenerateBranchStatic,
        ...degenerateBranchRun,
      });

      // One arm for the single-exit branch, none for the armless one
      expect(fileCoverage.b).toEqual({ 0: [1], 1: [] });
      expect(fileCoverage.branchMap[0].locations).toEqual([wholeLine(3)]);
      expect(fileCoverage.branchMap[1].locations).toEqual([]);

      // An empty set of arms contributes nothing to the totals rather than
      // a NaN, which is what the UI would otherwise render as a percentage
      const summary = createCoverageMap({ [pyFileName]: fileCoverage })
        .getCoverageSummary()
        .toJSON();
      expect(summary.branches.total).toEqual(1);
      expect(summary.branches.covered).toEqual(1);
      expect(summary.branches.pct).toEqual(100);
    });

    // an empty report is valid, not a special case
    it("translates a module with nothing in it into empty maps", () => {
      const data = new TestPythonCoverageMeasure(emptyStatic).toCoverageMapData(
        { [pyFileName]: emptyStatic }
      );

      // Still one file entry, keyed by and naming the file it describes
      expect(Object.keys(data)).toEqual([pyFileName]);
      expect(data[pyFileName]).toEqual({
        path: pyFileName,
        statementMap: {},
        fnMap: {},
        branchMap: {},
        s: {},
        f: {},
        b: {},
      });
      expect(
        createCoverageMap(data).getCoverageSummary().toJSON().statements
      ).toEqual({ total: 0, covered: 0, skipped: 0, pct: 100 });
    });

    // a statement is hit exactly when its line was reported
    it("marks exactly the executable lines the call reported", () => {
      // `abs_value(0)` of the three-path fixture: lines 2, 4 and 5 ran
      const zero = dataFor({ ...threePathStatic, ...threePathZero });
      expect(zero.s).toEqual({
        0: 0, // line 1, `def abs_value(n):`   runs at import, not on a call
        1: 1, // line 2, `if n < 0:`
        2: 0, // line 3, `return -n`
        3: 1, // line 4, `if n == 0:`
        4: 1, // line 5, `return 0`
        5: 0, // line 6, `return n`
      });

      // The statement indices are positions in `executable`, so they say
      // which line each counter belongs to
      expect(zero.statementMap[4]).toEqual(wholeLine(5));

      // A reported line that is not executable is not a statement, and does
      // not disturb the ones that are
      const stray = dataFor({
        ...threePathStatic,
        lines: [2, 4, 5, 99],
        arcs: [],
      });
      expect(stray.s).toEqual(zero.s);
      expect(Object.keys(stray.statementMap)).toEqual([
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
      ]);
    });

    // a function is covered exactly when one of its own lines ran
    it("credits a function only for its own lines", () => {
      // `outer(5)` runs the `def inner` statement and the return that
      // follows it, but never calls `inner`
      const outerOnly = dataFor({ ...nestedStatic, ...nestedOuterOnly });
      expect(outerOnly.f).toEqual({
        0: 1, // outer:        lines 2 and 4 ran
        1: 0, // outer.inner:  line 3 did not
        2: 0, // documented:   has no lines of its own to run (robustness
        //                    only -- the host omits such a function entirely)
      });

      // The nested function is still described, on its own lines
      expect(
        Object.values(outerOnly.fnMap).map((fn) => [fn.name, fn.line])
      ).toEqual([
        ["outer", 1],
        ["outer.inner", 2],
        ["documented", 6],
      ]);
      expect(outerOnly.fnMap[1].decl).toEqual(wholeLine(2));
      expect(outerOnly.fnMap[1].loc).toEqual({
        start: { line: 3, column: 0 },
        end: { line: 3, column: endOfLine },
      });

      // Importing the module runs the `def` lines themselves. A `def` line is
      // not one of the function's own lines, so it covers no function.
      const importOnly = dataFor({ ...nestedStatic, ...nestedImportOnly });
      expect(importOnly.s).toEqual({ 0: 1, 1: 0, 2: 0, 3: 0, 4: 1 });
      expect(importOnly.f).toEqual({ 0: 0, 1: 0, 2: 0 });
    });
  });

  it("measure records exactly the coverage of the call it measured", () => {
    const measure = new TestPythonCoverageMeasure(twoPathStatic);

    const meas = runTest(measure, twoPathNegative, inputAt(0));

    // The measurement is a coverage map of the file under test...
    const current = meas.coverageMeasure.current;
    expect(current.files()).toEqual([pyFileName]);

    // ...whose counters are exactly the negative path. Statement 0 is the
    // `def` line, which only runs at import, so a call never covers it.
    const fileCoverage = current.fileCoverageFor(pyFileName);
    expect(fileCoverage.path).toEqual(pyFileName);
    expect(fileCoverage.s).toEqual({
      0: 0, // `def abs_value(n):`  not reached by a call
      1: 1, // `if n < 0:`          executed
      2: 1, // `return -n`          executed
      3: 0, // `return n`           not reached
    });
    expect(fileCoverage.f).toEqual({ 0: 1 }); // abs_value entered
    expect(fileCoverage.b).toEqual({ 0: [1, 0] }); // if taken, else not

    // ...and the measurement carries the base measure fields. Both coverage
    // measures report the same name: they are mutually exclusive.
    expect(meas.type).toEqual("measure");
    expect(meas.name).toEqual("CoverageMeasure");
  });

  it("measure records exactly the coverage of a second, different call", () => {
    const measure = new TestPythonCoverageMeasure(twoPathStatic);

    const first = runTest(measure, twoPathPositive, inputAt(0));
    const firstCoverage =
      first.coverageMeasure.current.fileCoverageFor(pyFileName);
    expect(firstCoverage.s).toEqual({ 0: 0, 1: 1, 2: 0, 3: 1 });
    expect(firstCoverage.b).toEqual({ 0: [0, 1] }); // else taken, if not

    // The next call is measured on its own, not on top of the previous one
    const second = runTest(measure, twoPathNegative, inputAt(1));
    const secondCoverage =
      second.coverageMeasure.current.fileCoverageFor(pyFileName);
    expect(secondCoverage.s).toEqual({ 0: 0, 1: 1, 2: 1, 3: 0 });
    expect(secondCoverage.b).toEqual({ 0: [1, 0] });
  });

  it("measure synthesizes whole-line locations from the runner's report", () => {
    const fileCoverage = coverageOfCall(twoPathStatic, twoPathNegative);

    // coverage.py measures by line, so every location spans a whole line
    expect(Object.keys(fileCoverage.statementMap)).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);
    expect(fileCoverage.statementMap[0]).toEqual(wholeLine(1));
    expect(fileCoverage.statementMap[1]).toEqual(wholeLine(2));
    expect(fileCoverage.statementMap[2]).toEqual(wholeLine(3));
    expect(fileCoverage.statementMap[3]).toEqual(wholeLine(4));

    // The function spans its body; `decl` is the `def` line
    expect(fileCoverage.fnMap).toEqual({
      0: {
        name: "abs_value",
        decl: wholeLine(1),
        loc: {
          start: { line: 2, column: 0 },
          end: { line: 4, column: endOfLine },
        },
        line: 1,
      },
    });

    // One branch per branching line, one arm per exit. The type is
    // deliberately "branch" rather than "if": the heatmap skips if-branches
    // to work around istanbul's if-branch locations, which do not apply to
    // locations computed from arcs.
    expect(Object.keys(fileCoverage.branchMap)).toEqual(["0"]);
    expect(fileCoverage.branchMap[0].type).toEqual("branch");
    expect(fileCoverage.branchMap[0].line).toEqual(2);
    expect(fileCoverage.branchMap[0].loc).toEqual(wholeLine(2));
    expect(fileCoverage.branchMap[0].locations).toEqual([
      wholeLine(3), // the `if` exit
      wholeLine(4), // the fall-through exit
    ]);
  });

  it("measure reports no branch entries when the runner reports no branches", () => {
    const fileCoverage = coverageOfCall(linearStatic, linearRun);

    expect(Object.keys(fileCoverage.statementMap)).toEqual(["0", "1", "2"]);
    expect(fileCoverage.s).toEqual({ 0: 0, 1: 1, 2: 1 });
    expect(fileCoverage.f).toEqual({ 0: 1 });
    expect(fileCoverage.branchMap).toEqual({});
    expect(fileCoverage.b).toEqual({});
  });

  it("measure reports every function the runner knows about, called or not", () => {
    const fileCoverage = coverageOfCall(multiFunctionStatic, multiFunctionRun);

    expect(Object.keys(fileCoverage.fnMap)).toEqual(["0", "1", "2"]);
    expect(
      Object.values(fileCoverage.fnMap).map((fn) => [fn.name, fn.line])
    ).toEqual([
      ["abs_value", 1],
      ["helper", 4],
      ["never_called", 7],
    ]);
    expect(fileCoverage.fnMap[1].decl).toEqual(wholeLine(4));

    // abs_value called helper; never_called was never entered
    expect(fileCoverage.f).toEqual({ 0: 1, 1: 1, 2: 0 });

    // A function is covered when any of its own lines ran
    expect(fileCoverage.s).toEqual({ 0: 0, 1: 1, 2: 0, 3: 1, 4: 0, 5: 0 });
  });

  it("measure repeats the location maps unchanged while the counters change", () => {
    const measure = new TestPythonCoverageMeasure(twoPathStatic);

    const first = runTest(
      measure,
      twoPathNegative,
      inputAt(0)
    ).coverageMeasure.current.fileCoverageFor(pyFileName);
    const maps = {
      statementMap: JSON.parse(JSON.stringify(first.statementMap)),
      fnMap: JSON.parse(JSON.stringify(first.fnMap)),
      branchMap: JSON.parse(JSON.stringify(first.branchMap)),
    };
    expect(first.b).toEqual({ 0: [1, 0] });

    const second = runTest(
      measure,
      twoPathPositive,
      inputAt(1)
    ).coverageMeasure.current.fileCoverageFor(pyFileName);

    // Only the counters follow the call; the static structure is unchanged
    expect(second.statementMap).toEqual(maps.statementMap);
    expect(second.fnMap).toEqual(maps.fnMap);
    expect(second.branchMap).toEqual(maps.branchMap);
    expect(second.b).toEqual({ 0: [0, 1] });
  });

  it("measure credits each input with exactly the coverage it added", () => {
    const measure = new TestPythonCoverageMeasure(threePathStatic);

    // The three paths cover 10 distinct items between them: the function,
    // five of the six statements, and both arms of both branches
    const deltas = [threePathNegative, threePathZero, threePathPositive].map(
      (run, tick) =>
        runTest(measure, run, inputAt(tick)).coverageMeasure.globalDelta
    );

    expect(deltas).toEqual([
      4, // f0, s1, s2, b0.0
      4, // s3, s4, b0.1, b1.0
      2, // s5, b1.1
    ]);
    expect(deltas.reduce((sum, delta) => sum + delta, 0)).toEqual(10);

    // An input that covers nothing new is credited nothing
    expect(
      runTest(measure, threePathNegative, inputAt(3)).coverageMeasure
        .globalDelta
    ).toEqual(0);
  });

  it("measure reports the same coverage for a call no matter what ran before it", () => {
    const coverageByCall = (order: PythonRun[]): string[][] => {
      const measure = new TestPythonCoverageMeasure(threePathStatic);
      return order.map((run, tick) =>
        coveredKeys(
          runTest(measure, run, inputAt(tick)).coverageMeasure.current
        )
      );
    };

    const runs = [threePathNegative, threePathZero, threePathPositive];
    const forward = coverageByCall(runs);
    const reverse = coverageByCall([...runs].reverse());

    expect(forward[0].length).toBeGreaterThan(0); // guard: non-trivial
    expect(reverse).toEqual([...forward].reverse());
  });

  it("the coverage a run discovers does not depend on the order of its inputs", () => {
    const runOrder = (order: PythonRun[]): string[] => {
      const measure = new TestPythonCoverageMeasure(threePathStatic);
      const discovered = new Set<string>();
      order.forEach((run, tick) => {
        coveredKeys(
          runTest(measure, run, inputAt(tick)).coverageMeasure.current
        ).forEach((key) => discovered.add(key));
      });
      return [...discovered].sort();
    };

    const runs = [threePathNegative, threePathZero, threePathPositive];
    const forward = runOrder(runs);

    expect(forward.length).toBeGreaterThan(0); // guard: non-trivial
    expect(runOrder([...runs].reverse())).toEqual(forward);
    expect(
      runOrder([threePathZero, threePathPositive, threePathNegative])
    ).toEqual(forward);
  });

  it("measure reports no lineage progress for an input with no predecessor", () => {
    const measure = new TestPythonCoverageMeasure(threePathStatic);

    // A user/random input carries no source tick...
    expect(
      runTest(measure, threePathNegative, inputAt(0)).coverageMeasure.accumDelta
    ).toEqual(0);

    // ...and neither does a mutant whose source tick is unset
    expect(
      runTest(measure, threePathZero, mutantAt(1)).coverageMeasure.accumDelta
    ).toEqual(0);

    // A dangling predecessor reference is tolerated the same way
    expect(
      runTest(measure, threePathPositive, mutantAt(2, 99)).coverageMeasure
        .accumDelta
    ).toEqual(0);
  });

  it("measure accumulates a descendant's coverage into its lineage root", () => {
    const measure = new TestPythonCoverageMeasure(threePathStatic);

    runTest(measure, threePathNegative, inputAt(0)); // root
    runTest(measure, threePathZero, mutantAt(1, 0)); // child of root
    const sibling = runTest(measure, threePathPositive, mutantAt(2, 0));
    const siblingKeys = coveredKeys(sibling.coverageMeasure.current);

    // The root's accumulated coverage absorbed its descendants' coverage
    const rootAccum = coveredKeys(measure.getCoverage(0).coverageMeasure.accum);
    for (const key of siblingKeys) {
      expect(rootAccum).toContain(key);
    }

    // A grandchild is scored against that same lineage root, not against its
    // own parent: the parent never covered the positive path, but the root's
    // lineage has, so this covers nothing new
    expect(
      runTest(measure, threePathPositive, mutantAt(3, 1)).coverageMeasure
        .accumDelta
    ).toEqual(0);
  });

  it("measure reports lineage progress only for coverage new to the lineage", () => {
    const measure = new TestPythonCoverageMeasure(threePathStatic);

    runTest(measure, threePathNegative, inputAt(0)); // root
    const novel = runTest(measure, threePathPositive, mutantAt(1, 0));
    const dupe = runTest(measure, threePathPositive, mutantAt(2, 0));

    expect(novel.coverageMeasure.accumDelta).toBeGreaterThan(0);
    expect(dupe.coverageMeasure.accumDelta).toEqual(0);
  });

  it("a measurement's accumulated coverage includes the coverage it measured", () => {
    const measure = new TestPythonCoverageMeasure(threePathStatic);
    const inputs = [inputAt(0), mutantAt(1, 0), mutantAt(2, 1)];

    [threePathNegative, threePathZero, threePathPositive].forEach((run, i) => {
      const meas = runTest(measure, run, inputs[i]);
      const current = coveredKeys(meas.coverageMeasure.current);
      const accum = coveredKeys(meas.coverageMeasure.accum);

      expect(current.length).toBeGreaterThan(0); // guard: non-trivial
      for (const key of current) {
        expect(accum).toContain(key);
      }
    });
  });

  it("measure throws when it has not been connected to a runner", () => {
    // The TypeScript measure binds to instrumented globals in `onAfterLoad`;
    // this one sources its data from the runner, so an unconnected measure
    // has nothing to report and says so rather than reporting zero coverage.
    expect(() =>
      new PythonCoverageMeasure().measure(inputAt(0), anyResult)
    ).toThrowError("Coverage measure not connected to runner");
  });

  // telescoping property over a mutation lineage rather than three
  // independent inputs.
  it("measure credits each input in a lineage with the coverage it added", () => {
    const measure = new TestPythonCoverageMeasure(threePathStatic);
    const inputs = [inputAt(0), mutantAt(1, 0), mutantAt(2, 0)];

    const deltas = [threePathNegative, threePathZero, threePathPositive].map(
      (run, i) => runTest(measure, run, inputs[i]).coverageMeasure.globalDelta
    );

    expect(deltas).toEqual([4, 4, 2]);
    expect(deltas.reduce((sum, delta) => sum + delta, 0)).toEqual(10);
  });

  // ------------------------------------------------------------------
  // Multi-file measurement. The host measures every Python file the program
  // under test loads, not just the file the fuzz target is written in, so a
  // report is a `FullCoverage` keyed by file and a measurement is a map over
  // all of them. Each field `measure()` builds -- `current`, the global
  // delta, and the lineage accumulator -- has to span them.
  //
  // These mirror the multi-file specs in `TypescriptCoverageMeasure.test.ts`.
  // The one difference is where per-test isolation comes from: the TypeScript
  // measure zeroes its own counters in `onBeforeNextTestExecution`, while here
  // the runner replaces each file's `lines`/`arcs` after every call, leaving
  // them `undefined` for a file the call never entered.
  // ------------------------------------------------------------------
  describe("multiple files", () => {
    const fileA = "/tmp/multi_a.py"; // twoPathStatic: 4 lines, 1 fn, 1 branch
    const fileB = "/tmp/multi_b.py"; // linearStatic:  3 lines, 1 fn, no branch

    /**
     * Drives `measure()` with a report describing more than one Python file,
     * the way the host reports a program under test that imports helpers.
     */
    class MultiFileMeasure extends PythonCoverageMeasure {
      private readonly _coverage: FullCoverage = {};

      public constructor(statics: Record<string, CoverageInfo>) {
        super();
        for (const [file, info] of Object.entries(statics)) {
          this._coverage[file] = { ...info };
        }
        this._runner = new StubPythonRunner(this._coverage);
      }

      /**
       * Reports `runs` as the most recent call. A file with no entry in `runs`
       * was not reached by the call, which the runner reports by leaving its
       * `lines` and `arcs` undefined rather than by omitting the file.
       *
       * @param `runs` what the call executed, by file
       */
      public record(runs: Record<string, PythonRun>): void {
        for (const [file, info] of Object.entries(this._coverage)) {
          info.lines = runs[file]?.lines;
          info.arcs = runs[file]?.arcs;
        }
      }
    } // class: MultiFileMeasure

    /**
     * A measure over the two-path file A and the branch-free file B
     */
    const twoFileMeasure = () =>
      new MultiFileMeasure({ [fileA]: twoPathStatic, [fileB]: linearStatic });

    it("measure records each file's own coverage when a call runs through two", () => {
      const measure = twoFileMeasure();

      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const current = measure.measure(inputAt(0), anyResult).coverageMeasure
        .current;

      // The measurement is a map over both files...
      expect(current.files().sort()).toEqual([fileA, fileB].sort());

      // ...and each carries its own counters, not the other's
      const a = current.fileCoverageFor(fileA);
      expect(a.path).toEqual(fileA);
      expect(a.s).toEqual({
        0: 0, // line 1, `def abs_value(n):`  runs at import, not on a call
        1: 1, // line 2, `if n < 0:`          executed
        2: 1, // line 3, `return -n`          executed
        3: 0, // line 4, `return n`           not reached
      });
      expect(a.f).toEqual({ 0: 1 });
      expect(a.b).toEqual({ 0: [1, 0] }); // if taken, else not

      const b = current.fileCoverageFor(fileB);
      expect(b.path).toEqual(fileB);
      expect(b.s).toEqual({
        0: 0, // line 1, the `def`
        1: 1, // line 2, `doubled = n * 2`
        2: 1, // line 3, `return doubled`
      });
      expect(b.f).toEqual({ 0: 1 });
      expect(b.b).toEqual({}); // the linear fixture has no branches
    });

    it("measure reports a file the call never entered as uncovered", () => {
      const measure = twoFileMeasure();

      // Only file A runs: the runner leaves B's lines and arcs undefined
      measure.record({ [fileA]: twoPathNegative });
      const current = measure.measure(inputAt(0), anyResult).coverageMeasure
        .current;

      // File B is still described and counted...
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
      const measure = twoFileMeasure();

      // The first input runs file A's negative path and never enters B
      measure.record({ [fileA]: twoPathNegative });
      const first = measure.measure(inputAt(0), anyResult).coverageMeasure
        .globalDelta;

      // The second repeats it and additionally runs file B, so everything it
      // is credited with was discovered in the other file
      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const second = measure.measure(inputAt(1), anyResult).coverageMeasure
        .globalDelta;

      // The third adds file A's other arm, while repeating B
      measure.record({ [fileA]: twoPathPositive, [fileB]: linearRun });
      const third = measure.measure(inputAt(2), anyResult).coverageMeasure
        .globalDelta;

      // A fourth that repeats what both files have already covered adds nothing
      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const fourth = measure.measure(inputAt(3), anyResult).coverageMeasure
        .globalDelta;

      expect(first).toEqual(4); // A: f0, s1, s2, b0.0
      expect(second).toEqual(3); // B: f0, s1, s2 -- A added nothing
      expect(third).toEqual(2); // A: s3, b0.1 -- B added nothing
      expect(fourth).toEqual(0);

      // Between them the inputs covered every item in both files that a call
      // can reach: 6 of A's 7 and 3 of B's 4 (the `def` lines only run at
      // import, so no run of calls ever covers them)
      expect(first + second + third + fourth).toEqual(9);
    });

    it("measure reports lineage progress for coverage new in another file", () => {
      const measure = twoFileMeasure();

      // The lineage root runs only file A
      measure.record({ [fileA]: twoPathNegative });
      measure.measure(inputAt(0), anyResult);

      // A child that reaches into file B is new to the lineage...
      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const novel = measure.measure(mutantAt(1, 0), anyResult);
      expect(novel.coverageMeasure.accumDelta).toEqual(3); // B: f0, s1, s2

      // ...while a sibling that repeats it adds nothing to the lineage
      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const dupe = measure.measure(mutantAt(2, 0), anyResult);
      expect(dupe.coverageMeasure.accumDelta).toEqual(0);

      // The root's accumulated coverage now spans both files, though it only
      // ever ran through one itself. Note that accumulating is a merge, which
      // sums hit counts: file B reads 2 because both descendants ran it once.
      // Only covered-ness feeds `accumDelta`, never the count.
      const rootAccum = measure.getCoverage(0).coverageMeasure.accum;
      expect(rootAccum.files().sort()).toEqual([fileA, fileB].sort());
      expect(rootAccum.fileCoverageFor(fileB).f).toEqual({ 0: 2 });
      expect(rootAccum.fileCoverageFor(fileB).s).toEqual({ 0: 0, 1: 2, 2: 2 });
    });

    it("measure does not carry a file's coverage into the next call", () => {
      const measure = twoFileMeasure();

      // The first call runs through both files
      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const firstB = measure
        .measure(inputAt(0), anyResult)
        .coverageMeasure.current.fileCoverageFor(fileB);
      expect(firstB.f).toEqual({ 0: 1 }); // guard: B really ran

      // The second runs through file A only. Isolation is the runner's doing
      // rather than a reset: it replaces every file's `lines` and `arcs`, so
      // B's go back to undefined rather than keeping the previous call's.
      measure.record({ [fileA]: twoPathPositive });
      const second = measure.measure(inputAt(1), anyResult).coverageMeasure
        .current;

      expect(second.fileCoverageFor(fileB).s).toEqual({ 0: 0, 1: 0, 2: 0 });
      expect(second.fileCoverageFor(fileB).f).toEqual({ 0: 0 });

      // ...and file A shows this call's path, not the union with the last
      expect(second.fileCoverageFor(fileA).s).toEqual({
        0: 0,
        1: 1,
        2: 0,
        3: 1,
      });
      expect(second.fileCoverageFor(fileA).b).toEqual({ 0: [0, 1] });
    });

    // Files in different directories. A coverage map is keyed by path, and
    // every consumer -- the merge, the per-file stats, the heatmap's lookup --
    // keys on the whole path rather than the file's name. These pin that, so
    // that shortening a key to a basename anywhere downstream fails loudly.

    const dirCore = "/tmp/proj/pkg/core.py"; // twoPathStatic
    const dirUtil = "/tmp/proj/lib/util.py"; // linearStatic

    it("measure keeps files in separate directories apart", () => {
      const measure = new MultiFileMeasure({
        [dirCore]: twoPathStatic,
        [dirUtil]: linearStatic,
      });

      measure.record({ [dirCore]: twoPathNegative, [dirUtil]: linearRun });
      const current = measure.measure(inputAt(0), anyResult).coverageMeasure
        .current;

      // Each directory's file is its own entry, keyed and named by full path
      expect(current.files().sort()).toEqual([dirCore, dirUtil].sort());
      expect(current.fileCoverageFor(dirCore).path).toEqual(dirCore);
      expect(current.fileCoverageFor(dirUtil).path).toEqual(dirUtil);

      // ...carrying the counters of the file at that path, and no other
      expect(current.fileCoverageFor(dirCore).s).toEqual({
        0: 0,
        1: 1,
        2: 1,
        3: 0,
      });
      expect(current.fileCoverageFor(dirCore).b).toEqual({ 0: [1, 0] });
      expect(current.fileCoverageFor(dirUtil).s).toEqual({ 0: 0, 1: 1, 2: 1 });
      expect(current.fileCoverageFor(dirUtil).b).toEqual({});
    });

    it("measure does not conflate two files sharing a basename", () => {
      // Same file name in two directories, and the same source in both, so
      // only the path distinguishes them
      const pkgUtil = "/tmp/proj/pkg/util.py";
      const libUtil = "/tmp/proj/lib/util.py";
      const measure = new MultiFileMeasure({
        [pkgUtil]: twoPathStatic,
        [libUtil]: twoPathStatic,
      });

      // The first call takes the `if` in one of them only
      measure.record({ [pkgUtil]: twoPathNegative });
      const first = measure.measure(inputAt(0), anyResult).coverageMeasure;

      expect(first.current.files().sort()).toEqual([libUtil, pkgUtil].sort());
      expect(first.current.fileCoverageFor(pkgUtil).b).toEqual({ 0: [1, 0] });
      expect(first.current.fileCoverageFor(libUtil).b).toEqual({ 0: [0, 0] });
      expect(first.current.fileCoverageFor(libUtil).f).toEqual({ 0: 0 });
      expect(first.globalDelta).toEqual(4); // f0, s1, s2, b0.0 of pkg/util

      // The second takes the other arm in the *other* file. Identical
      // structure and name, so if the two were keyed by basename this would
      // look like coverage already seen and be credited nothing.
      measure.record({ [libUtil]: twoPathPositive });
      const second = measure.measure(inputAt(1), anyResult).coverageMeasure;

      expect(second.current.fileCoverageFor(libUtil).b).toEqual({ 0: [0, 1] });
      expect(second.current.fileCoverageFor(pkgUtil).b).toEqual({ 0: [0, 0] });
      expect(second.globalDelta).toEqual(4); // f0, s1, s3, b0.1 of lib/util
    });
  });

  // ------------------------------------------------------------------
  // onRunEnd: runs once the last test is done, and hands the run's
  // accumulated coverage to `results` as the stats the UI reads.
  //
  // The TypeScript measure has to map its stats back through a source map
  // to reach the source the user wrote; this one is already there, because
  // coverage.py reports Python lines. What remains is the same: report the
  // whole run rather than the last call, and shape it for the UI.
  // ------------------------------------------------------------------
  describe("onRunEnd", () => {
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
        timers: {
          total: 21,
          compile: 5,
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
      measure: PythonCoverageMeasure
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
      const measure = new TestPythonCoverageMeasure(twoPathStatic);
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
      const measure = new TestPythonCoverageMeasure(threePathStatic);

      // Each input is credited with the coverage it added to the run
      const deltas = [threePathNegative, threePathZero, threePathPositive].map(
        (run, tick) =>
          runTest(measure, run, inputAt(tick)).coverageMeasure.globalDelta
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
      const countersFor = async (runs: PythonRun[]) => {
        const measure = new TestPythonCoverageMeasure(threePathStatic);
        runs.forEach((run, tick) => runTest(measure, run, inputAt(tick)));
        return (await statsOf(measure)).counters;
      };

      const negative = await countersFor([threePathNegative]);
      const every = await countersFor([
        threePathNegative,
        threePathZero,
        threePathPositive,
      ]);

      // The totals are identical: one function, six executable lines, and two
      // two-armed branches are in the source whatever the run reaches of them.
      // Line 1 -- the `def` -- is executable but only runs at import, so no
      // run of calls ever covers all six statements.
      expect(negative).toEqual({
        functionsTotal: 1,
        functionsCovered: 1,
        statementsTotal: 6,
        statementsCovered: 2,
        branchesTotal: 4,
        branchesCovered: 1,
      });
      expect(every).toEqual({
        functionsTotal: 1,
        functionsCovered: 1,
        statementsTotal: 6,
        statementsCovered: 5,
        branchesTotal: 4,
        branchesCovered: 4,
      });

      // Nothing can be covered that is not there to cover
      for (const counters of [negative, every]) {
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
      const measure = new TestPythonCoverageMeasure(twoPathStatic);
      runTest(measure, twoPathNegative, inputAt(0));
      runTest(measure, twoPathPositive, inputAt(1));

      const stats = await statsOf(measure);

      // The Python host reports one file per run, so the breakdown has a
      // single entry -- but the two are computed from separate reads of the
      // coverage map, and have to agree however many entries there are
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

      expect(stats.files.length).toEqual(1);
      expect(stats.counters).toEqual(summed);

      // Both calls are in there, not just the last one: the runner keeps only
      // the most recent call's lines, so these can only come from the run's
      // accumulated map
      expect(stats.counters).toEqual({
        functionsTotal: 1,
        functionsCovered: 1,
        statementsTotal: 4,
        statementsCovered: 3, // `if`, `return -n`, and `return n`
        branchesTotal: 2,
        branchesCovered: 2, // one arm from each call
      });
    });

    // the counters the stats report should all be placed in a file
    it("every counter the stats report has a location to point at", async () => {
      const branchless = new TestPythonCoverageMeasure(multiFunctionStatic);
      runTest(branchless, multiFunctionRun, inputAt(0));

      // One call of the three-path fixture leaves the second branch with no
      // arm taken, which is what gets a branch pruned
      const partial = new TestPythonCoverageMeasure(threePathStatic);
      runTest(partial, threePathNegative, inputAt(0));

      const [byFunction, byBranch] = [
        await statsOf(branchless),
        await statsOf(partial),
      ];

      // Every counter key names an entry of the matching location map, which
      // is what the heatmap looks up to decide what to highlight
      for (const stats of [byFunction, byBranch]) {
        for (const file of stats.files) {
          const { s, f, b, statementMap, fnMap, branchMap } = file.fileMap;
          expect(Object.keys(s).filter((k) => !(k in statementMap))).toEqual(
            []
          );
          expect(Object.keys(f).filter((k) => !(k in fnMap))).toEqual([]);
          expect(Object.keys(b).filter((k) => !(k in branchMap))).toEqual([]);
        }
      }

      // Guard: the pruning that makes this worth checking really happened.
      // `never_called` was dropped from `f` but kept its `fnMap` entry, and
      // is still counted as an uncovered function.
      expect(Object.keys(byFunction.files[0].fileMap.f)).toEqual(["0", "1"]);
      expect(Object.keys(byFunction.files[0].fileMap.fnMap)).toEqual([
        "0",
        "1",
        "2",
      ]);
      expect(byFunction.files[0].fileMap.fnMap[2].name).toEqual("never_called");
      expect(
        byFunction.counters.functionsTotal -
          byFunction.counters.functionsCovered
      ).toEqual(1);

      // The untaken branch was dropped from `b` *and* from `branchMap`, so
      // neither is left pointing at the other's missing entry -- while both
      // of its arms are still counted as uncovered
      expect(Object.keys(byBranch.files[0].fileMap.b)).toEqual(["0"]);
      expect(Object.keys(byBranch.files[0].fileMap.branchMap)).toEqual(["0"]);
      expect(byBranch.counters.branchesTotal).toEqual(4);
      expect(byBranch.counters.branchesCovered).toEqual(1);
    });

    // the paths the stats report should be ones the UI can key on
    it("the stats report a normalized path to the Python source", async () => {
      // The path is whatever the Python host reported the file as
      const rawPath = "/tmp/pkg/../abs_value.py";
      const measure = new TestPythonCoverageMeasure(twoPathStatic, rawPath);
      runTest(measure, twoPathNegative, inputAt(0));

      const stats = await statsOf(measure);
      expect(stats.files.length).toEqual(1);
      const file = stats.files[0];

      // The reported path is normalized, so the UI can match it against
      // open editors: the `pkg/..` spelling keys to the same file as the
      // plain one. Compared after normalizing rather than against a literal,
      // because the separator -- and, on Windows, the case -- of the key is
      // the host platform's.
      expect(file.path).toEqual(normalizePathForKey(pyFileName));
      expect(file.path).not.toContain("..");

      // The file's own map is not: one `CodeCoverageFileStats` can carry two
      // spellings of the same file, and only the outer one is normalized
      expect(file.fileMap.path).toEqual(rawPath);
    });

    // a run that measured nothing still reports stats
    it("onRunEnd reports empty stats for a run that measured nothing", async () => {
      // Not even connected to a runner: `measure` throws in that state, but
      // ending the run has to work anyway
      const stats = await statsOf(new PythonCoverageMeasure());

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

    // the stats are expressed in the source the user wrote.
    it("the stats report whole-line Python locations from the runner's report", async () => {
      const measure = new TestPythonCoverageMeasure(twoPathStatic);
      runTest(measure, twoPathNegative, inputAt(0));

      const stats = await statsOf(measure);
      expect(stats.files.length).toEqual(1);
      const file = stats.files[0];

      expect(file.path).toEqual(normalizePathForKey(pyFileName));

      // One statement per executable line, each spanning its whole line
      expect(file.fileMap.statementMap).toEqual({
        0: wholeLine(1), // `def abs_value(n):`
        1: wholeLine(2), // `if n < 0:`
        2: wholeLine(3), // `return -n`
        3: wholeLine(4), // `return n`
      });
      expect(file.fileMap.fnMap).toEqual({
        0: {
          name: "abs_value",
          decl: wholeLine(1),
          loc: {
            start: { line: 2, column: 0 },
            end: { line: 4, column: endOfLine },
          },
          line: 1,
        },
      });
      expect(file.fileMap.branchMap[0].type).toEqual("branch");
      expect(file.fileMap.branchMap[0].loc).toEqual(wholeLine(2));
      expect(file.fileMap.branchMap[0].locations).toEqual([
        wholeLine(3), // the `if` exit
        wholeLine(4), // the fall-through exit
      ]);

      // The counters are the run's. `def abs_value` runs at import, not on a
      // call, so line 1 stays uncovered; `return n` was never reached.
      expect(file.fileMap.s).toEqual({ 0: 0, 1: 1, 2: 1, 3: 0 });
      expect(file.fileMap.f).toEqual({ 0: 1 });
      expect(file.fileMap.b).toEqual({ 0: [1, 0] }); // `if` taken, else not
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
      const measure = new TestPythonCoverageMeasure(multiFunctionStatic);

      // `abs_value(-4)` calls `helper`; `never_called` is never called, and
      // the conditional expression on line 5 is not a branch for coverage.py
      runTest(measure, multiFunctionRun, inputAt(0));

      const stats = await statsOf(measure);
      expect(stats.files.length).toEqual(1);
      const file = stats.files[0];

      expect(file.path).toEqual(normalizePathForKey(pyFileName));
      expect(file.counters).toEqual({
        functionsTotal: 3,
        functionsCovered: 2,
        statementsTotal: 6,
        statementsCovered: 2,
        branchesTotal: 0,
        branchesCovered: 0,
      });

      // The two functions that ran are reported; the one that did not is
      // omitted, and so is nothing else
      expect(file.fileMap.f).toEqual({ 0: 1, 1: 1 });
      expect(
        Object.values(file.fileMap.fnMap).map((fn) => [fn.name, fn.line])
      ).toEqual([
        ["abs_value", 1],
        ["helper", 4],
        ["never_called", 7],
      ]);

      // `return helper(n)` (line 2) and `return -n if ... else n` (line 5)
      // ran; the three `def` lines and `return 0` did not
      expect(file.fileMap.s).toEqual({ 0: 0, 1: 1, 2: 0, 3: 1, 4: 0, 5: 0 });
      expect(file.fileMap.b).toEqual({});
      expect(file.fileMap.branchMap).toEqual({});
    });
  });
});
