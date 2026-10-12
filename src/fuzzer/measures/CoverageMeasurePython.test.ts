import { FileCoverageData, createCoverageMap } from "istanbul-lib-coverage";
import { CoverageMeasure } from "./CoverageMeasure";
import {
  CoverageInfo,
  PythonCoverageMapData,
  FullCoverage,
  PythonRunner,
} from "../runners/python/PythonRunner";
import { InputAndSource } from "../Types";
import { normalizePathForKey } from "../Util";
import {
  inputAt,
  anyResult,
  coveredKeys,
  statsOf,
} from "./CoverageMeasureTestHelper";
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
 * A `PythonRunner` that reports fixed in-memory coverage.
 */
class StubPythonRunner extends PythonRunner {
  public constructor(coverage: FullCoverage) {
    super(Object.keys(coverage)[0] ?? pyFileName, "anyFn");
    this._coverageInfo = coverage;
  }
} // class: StubPythonRunner

class TestPythonCoverageMeasure extends CoverageMeasure {
  private readonly _info: CoverageInfo;
  private readonly _coverage: FullCoverage;

  public constructor(staticInfo: CoverageInfo, file: string = pyFileName) {
    super();
    this._requireRunner = true;
    this._info = { ...staticInfo };
    this._coverage = { [file]: this._info };
    const stubRunner = new StubPythonRunner(this._coverage);
    this.onRunStart([stubRunner]);
  }

  public record(run: PythonRun): void {
    this.onBeforeNextTestExecution();
    this._info.lines = run.lines;
    this._info.arcs = run.arcs;
    this.recordHits(this._coverage);
  }

  public get info(): CoverageInfo {
    return this._info;
  }

  public toCoverageMapData(coverage: FullCoverage) {
    return this._toCoverageMapData(coverage);
  }
} // class: TestPythonCoverageMeasure

describe("fuzzer/measures/CoverageMeasure: Python", () => {
  const endOfLine = Number.MAX_SAFE_INTEGER;
  const wholeLine = (line: number) => ({
    start: { line, column: 0 },
    end: { line, column: endOfLine },
  });

  const runTest = (
    measure: TestPythonCoverageMeasure,
    run: PythonRun,
    input: InputAndSource = inputAt(0)
  ) => {
    measure.record(run);
    return measure.measure(input, anyResult);
  }; // fn: runTest

  const coverageOfCall = (staticInfo: CoverageInfo, run: PythonRun) =>
    runTest(
      new TestPythonCoverageMeasure(staticInfo),
      run,
      inputAt(0)
    ).coverageMeasure.current.fileCoverageFor(pyFileName);

  // ------------------------------------------------------------------
  // Runner IPC and State Isolation
  // ------------------------------------------------------------------
  describe("runner connection and isolation", () => {
    it("onBeforeNextTestExecution does not disturb the runner's coverage report", () => {
      const measure = new TestPythonCoverageMeasure(twoPathStatic);
      measure.record(twoPathNegative);
      const before = structuredClone(measure.info);

      measure.onBeforeNextTestExecution();

      expect(structuredClone(measure.info)).toEqual(before);
      expect(measure.info.executable).toEqual([1, 2, 3, 4]);
      expect(measure.info.lines).toEqual([2, 3]);
      expect(measure.info.arcs).toEqual([[2, 3]]);
    });

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

      const unreset = new TestPythonCoverageMeasure(twoPathStatic);
      const withoutReset = [twoPathNegative, twoPathPositive].map((run, tick) =>
        coveredKeys(
          runTest(unreset, run, inputAt(tick)).coverageMeasure.current
        )
      );
      expect(withoutReset).toEqual([firstKeys, secondKeys]);
    });

    it("measure throws when it has not been connected to a runner", () => {
      class UnconnectedPythonMeasure extends CoverageMeasure {
        public constructor() {
          super();
          this._requireRunner = true;
        } // fn: constructor
      } // class: UnconnectedPythonMeasure

      const measure = new UnconnectedPythonMeasure();
      expect(() => measure.measure(inputAt(0), anyResult)).toThrowError(
        "Coverage measure not connected to runner"
      );
    });
  });

  // ------------------------------------------------------------------
  // Translation: coverage.py lines/arcs into Istanbul shape
  // ------------------------------------------------------------------
  describe("_toCoverageMapData", () => {
    const dataFor = (info: CoverageInfo): FileCoverageData =>
      new TestPythonCoverageMeasure(info).toCoverageMapData({
        [pyFileName]: info,
      })[pyFileName];

    it("matches a branch exit by its arc destination, not by its display line", () => {
      const taken = dataFor({ ...earlyExitStatic, ...earlyExitTaken });

      expect(taken.branchMap[0].locations).toEqual([
        wholeLine(2),
        wholeLine(3),
      ]);
      expect(taken.branchMap[0].loc).toEqual(wholeLine(2));
      expect(taken.b).toEqual({ 0: [0, 1] });

      const skipped = dataFor({ ...earlyExitStatic, ...earlyExitSkipped });
      expect(skipped.b).toEqual({ 0: [1, 0] });
      expect(skipped.branchMap).toEqual(taken.branchMap);
    });

    it("ignores arcs that are not exits of the branch they would flip", () => {
      const fileCoverage = dataFor({
        ...earlyExitStatic,
        ...earlyExitNoisyArcs,
      });

      expect(fileCoverage.b).toEqual({ 0: [0, 1] });
      expect(Object.keys(fileCoverage.branchMap)).toEqual(["0"]);
      expect(Object.keys(fileCoverage.b)).toEqual(["0"]);
      expect(Object.keys(fileCoverage.statementMap)).toEqual(["0", "1", "2"]);
    });

    it("matches an arc reported as a fresh array", () => {
      const fileCoverage = dataFor({
        ...earlyExitStatic,
        lines: [2, 3],
        arcs: [[1 + 1, 3]],
      });

      expect(fileCoverage.b).toEqual({ 0: [0, 1] });
    });

    it("reports the full structure with zero counters for a call that reported nothing", () => {
      const fileCoverage = dataFor({
        ...twoPathStatic,
        lines: undefined,
        arcs: undefined,
      });

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
      expect(fileCoverage.s).toEqual({ 0: 0, 1: 0, 2: 0, 3: 0 });
      expect(fileCoverage.f).toEqual({ 0: 0 });
      expect(fileCoverage.b).toEqual({ 0: [0, 0] });
    });

    it("reports a branch with fewer than two exits without corrupting the summary", () => {
      const fileCoverage = dataFor({
        ...degenerateBranchStatic,
        ...degenerateBranchRun,
      });

      expect(fileCoverage.b).toEqual({ 0: [1], 1: [] });
      expect(fileCoverage.branchMap[0].locations).toEqual([wholeLine(3)]);
      expect(fileCoverage.branchMap[1].locations).toEqual([]);

      const summary = createCoverageMap({ [pyFileName]: fileCoverage })
        .getCoverageSummary()
        .toJSON();
      expect(summary.branches.total).toEqual(1);
      expect(summary.branches.covered).toEqual(1);
      expect(summary.branches.pct).toEqual(100);
    });

    it("translates a module with nothing in it into empty maps", () => {
      const data = new TestPythonCoverageMeasure(emptyStatic).toCoverageMapData(
        { [pyFileName]: emptyStatic }
      );

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

    it("marks exactly the executable lines the call reported", () => {
      const zero = dataFor({ ...threePathStatic, ...threePathZero });
      expect(zero.s).toEqual({
        0: 0,
        1: 1,
        2: 0,
        3: 1,
        4: 1,
        5: 0,
      });
      expect(zero.statementMap[4]).toEqual(wholeLine(5));

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

    it("credits a function only for its own lines", () => {
      const outerOnly = dataFor({ ...nestedStatic, ...nestedOuterOnly });
      expect(outerOnly.f).toEqual({
        0: 1,
        1: 0,
        2: 0,
      });
      expect(
        Object.values(outerOnly.fnMap).map((fn) => [fn.name, fn.line])
      ).toEqual([
        ["outer", 1],
        ["outer.inner", 2],
        ["documented", 6],
      ]);

      const importOnly = dataFor({ ...nestedStatic, ...nestedImportOnly });
      expect(importOnly.s).toEqual({ 0: 1, 1: 0, 2: 0, 3: 0, 4: 1 });
      expect(importOnly.f).toEqual({ 0: 0, 1: 0, 2: 0 });
    });
  });

  // ------------------------------------------------------------------
  // Location Synthesis & Arc Mapping
  // ------------------------------------------------------------------
  describe("location synthesis and arc mapping", () => {
    it("measure synthesizes whole-line locations from the runner's report", () => {
      const fileCoverage = coverageOfCall(twoPathStatic, twoPathNegative);

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

      expect(Object.keys(fileCoverage.branchMap)).toEqual(["0"]);
      expect(fileCoverage.branchMap[0].type).toEqual("branch");
      expect(fileCoverage.branchMap[0].line).toEqual(2);
      expect(fileCoverage.branchMap[0].loc).toEqual(wholeLine(2));
      expect(fileCoverage.branchMap[0].locations).toEqual([
        wholeLine(3),
        wholeLine(4),
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
      const fileCoverage = coverageOfCall(
        multiFunctionStatic,
        multiFunctionRun
      );

      expect(Object.keys(fileCoverage.fnMap)).toEqual(["0", "1", "2"]);
      expect(
        Object.values(fileCoverage.fnMap).map((fn) => [fn.name, fn.line])
      ).toEqual([
        ["abs_value", 1],
        ["helper", 4],
        ["never_called", 7],
      ]);
      expect(fileCoverage.fnMap[1].decl).toEqual(wholeLine(4));
      expect(fileCoverage.f).toEqual({ 0: 1, 1: 1, 2: 0 });
      expect(fileCoverage.s).toEqual({ 0: 0, 1: 1, 2: 0, 3: 1, 4: 0, 5: 0 });
    });

    it("maps taken branch arcs to exact branch arm indices without arm inversion", () => {
      const measure = new TestPythonCoverageMeasure(threePathStatic);

      const mNeg = runTest(
        measure,
        threePathNegative,
        inputAt(0)
      ).coverageMeasure.current.fileCoverageFor(pyFileName);
      expect(mNeg.b[0]).toEqual([1, 0]);
      expect(mNeg.b[1]).toEqual([0, 0]);

      const mZero = runTest(
        measure,
        threePathZero,
        inputAt(1)
      ).coverageMeasure.current.fileCoverageFor(pyFileName);
      expect(mZero.b[0]).toEqual([0, 1]);
      expect(mZero.b[1]).toEqual([1, 0]);

      const mPos = runTest(
        measure,
        threePathPositive,
        inputAt(2)
      ).coverageMeasure.current.fileCoverageFor(pyFileName);
      expect(mPos.b[0]).toEqual([0, 1]);
      expect(mPos.b[1]).toEqual([0, 1]);
    });
  });

  // ------------------------------------------------------------------
  // Dynamic Coverage Without Static Scope
  // ------------------------------------------------------------------
  describe("dynamic coverage without static scope", () => {
    const dynFileA = "/tmp/dynamic_a.py";
    const dynFileB = "/tmp/dynamic_b.py";

    class DynamicCoverageMeasure extends CoverageMeasure {
      private readonly _coverage: PythonCoverageMapData = {};

      public constructor(initialFiles: string[] = []) {
        super();
        this._requireRunner = true;
        for (const file of initialFiles) {
          this._coverage[file] = {
            executable: [],
            functions: [],
            branches: [],
          };
        }
        this._runners = [new StubPythonRunner(this._coverage)];
      } // fn: constructor

      public record(runs: Record<string, PythonRun>): void {
        this.onBeforeNextTestExecution();
        for (const [file, run] of Object.entries(runs)) {
          if (!this._coverage[file]) {
            this._coverage[file] = {
              executable: [],
              functions: [],
              branches: [],
            };
          }
          this._coverage[file].lines = run.lines;
          this._coverage[file].arcs = run.arcs;
        }
        this.recordHits(this._coverage);
      } // fn: record
    } // class: DynamicCoverageMeasure

    it("dynamically registers statements and computes positive delta when static coverage is empty", () => {
      const measure = new DynamicCoverageMeasure([dynFileA]);

      measure.record({ [dynFileA]: { lines: [10, 20], arcs: [] } });
      const m1 = measure.measure(inputAt(0), anyResult);

      expect(m1.coverageMeasure.globalDelta).toEqual(2);
      expect(m1.coverageMeasure.accumDelta).toEqual(0);
      const fcA = m1.coverageMeasure.current.fileCoverageFor(dynFileA);
      expect(Object.keys(fcA.statementMap).length).toEqual(2);
      expect(fcA.s[0]).toEqual(1);
      expect(fcA.s[1]).toEqual(1);

      measure.record({ [dynFileA]: { lines: [10, 20], arcs: [] } });
      const m2 = measure.measure(inputAt(1), anyResult);
      expect(m2.coverageMeasure.globalDelta).toEqual(0);

      measure.record({ [dynFileA]: { lines: [10, 30], arcs: [] } });
      const m3 = measure.measure(inputAt(2), anyResult);
      expect(m3.coverageMeasure.globalDelta).toEqual(1);
    });

    it("dynamically discovers and measures a new file appearing mid-run", () => {
      const measure = new DynamicCoverageMeasure([dynFileA]);

      measure.record({ [dynFileA]: { lines: [1, 2], arcs: [] } });
      const m1 = measure.measure(inputAt(0), anyResult);
      expect(m1.coverageMeasure.globalDelta).toEqual(2);
      expect(m1.coverageMeasure.current.files()).toEqual([dynFileA]);

      measure.record({
        [dynFileA]: { lines: [1, 2], arcs: [] },
        [dynFileB]: { lines: [100, 101, 102], arcs: [] },
      });
      const m2 = measure.measure(inputAt(1), anyResult);
      expect(m2.coverageMeasure.globalDelta).toEqual(3);
      expect(m2.coverageMeasure.current.files().sort()).toEqual(
        [dynFileA, dynFileB].sort()
      );
      const fcB = m2.coverageMeasure.current.fileCoverageFor(dynFileB);
      expect(Object.keys(fcB.statementMap).length).toEqual(3);
      expect(fcB.s[0]).toEqual(1);
      expect(fcB.s[1]).toEqual(1);
      expect(fcB.s[2]).toEqual(1);
    });

    it("synthesizes accurate final statistics when static coverage was absent", async () => {
      const measure = new DynamicCoverageMeasure();
      measure.record({ [dynFileA]: { lines: [5, 6, 7], arcs: [] } });
      measure.measure(inputAt(0), anyResult);

      const stats = await statsOf(measure);
      expect(stats.files.length).toEqual(1);
      const fileStats = stats.files[0];
      expect(fileStats.path).toEqual(normalizePathForKey(dynFileA));
      expect(fileStats.counters.statementsCovered).toEqual(3);
      expect(fileStats.counters.statementsTotal).toEqual(3);
    });
  });

  // ------------------------------------------------------------------
  // Python Statistics in onRunEnd
  // ------------------------------------------------------------------
  describe("Python statistics reporting", () => {
    it("static coverage: reports total static statements, functions, and branches before and after test executions", async () => {
      const measure = new TestPythonCoverageMeasure(multiFunctionStatic);

      let stats = await statsOf(measure);
      expect(stats.counters.functionsTotal).toEqual(3);
      expect(stats.counters.statementsTotal).toEqual(6);
      expect(stats.counters.functionsCovered).toEqual(0);
      expect(stats.counters.statementsCovered).toEqual(0);

      runTest(measure, multiFunctionRun, inputAt(0));

      stats = await statsOf(measure);
      expect(stats.counters.functionsTotal).toEqual(3);
      expect(stats.counters.statementsTotal).toEqual(6);
      expect(stats.counters.functionsCovered).toEqual(2);
      expect(stats.counters.statementsCovered).toEqual(2);
    });

    it("the stats report whole-line Python locations from the runner's report", async () => {
      const measure = new TestPythonCoverageMeasure(twoPathStatic);
      runTest(measure, twoPathNegative, inputAt(0));

      const stats = await statsOf(measure);
      expect(stats.files.length).toEqual(1);
      const file = stats.files[0];

      expect(file.path).toEqual(normalizePathForKey(pyFileName));
      expect(file.fileMap.statementMap).toEqual({
        0: wholeLine(1),
        1: wholeLine(2),
        2: wholeLine(3),
        3: wholeLine(4),
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
      expect(file.fileMap.s).toEqual({ 0: 0, 1: 1, 2: 1, 3: 0 });
      expect(file.fileMap.f).toEqual({ 0: 1 });
      expect(file.fileMap.b).toEqual({ 0: [1, 0] });
    });

    it("the stats report exact counters for a run that left code uncovered", async () => {
      const measure = new TestPythonCoverageMeasure(multiFunctionStatic);
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

      expect(file.fileMap.f).toEqual({ 0: 1, 1: 1 });
      expect(
        Object.values(file.fileMap.fnMap).map((fn) => [fn.name, fn.line])
      ).toEqual([
        ["abs_value", 1],
        ["helper", 4],
        ["never_called", 7],
      ]);
      expect(file.fileMap.s).toEqual({ 0: 0, 1: 1, 2: 0, 3: 1, 4: 0, 5: 0 });
      expect(file.fileMap.b).toEqual({});
      expect(file.fileMap.branchMap).toEqual({});
    });
  });
});
