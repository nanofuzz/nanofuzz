import { CoverageMeasure } from "./CoverageMeasure";
import {
  CoverageInfo,
  FullCoverage,
  PythonRunner,
} from "../runners/python/PythonRunner";
import { InputAndSource } from "../Types";
import { normalizePathForKey } from "../Util";
import {
  inputAt,
  mutantAt,
  anyResult,
  coveredKeys,
  statsOf,
  resultsStub,
} from "./CoverageMeasureTestHelper";
import {
  linearRun,
  linearStatic,
  multiFunctionRun,
  multiFunctionStatic,
  pyFileName,
  PythonRun,
  threePathNegative,
  threePathPositive,
  threePathStatic,
  threePathZero,
  twoPathNegative,
  twoPathPositive,
  twoPathStatic,
} from "./test_fixtures/PythonCoverageMeasure.testfixture1";

/**
 * A `PythonRunner` that holds a fixed coverage report in memory rather than spawning Python.
 */
class StubPythonRunner extends PythonRunner {
  public constructor(coverage: FullCoverage) {
    super(Object.keys(coverage)[0] ?? pyFileName, "anyFn");
    this._coverageInfo = coverage;
  }
} // class: StubPythonRunner

/**
 * A test harness for `CoverageMeasure` providing multi-file or single-file test driving.
 */
class TestCoreCoverageMeasure extends CoverageMeasure {
  private readonly _coverage: FullCoverage;

  public constructor(statics: Record<string, CoverageInfo>) {
    super();
    this._requireRunner = true;
    this._coverage = {};
    for (const [file, info] of Object.entries(statics)) {
      this._coverage[file] = { ...info };
    }
    this._runners = [new StubPythonRunner(this._coverage)];
    this.onRunStart(this._runners);
  }

  public record(runs: Record<string, PythonRun>): void {
    this.onBeforeNextTestExecution();
    for (const [file, info] of Object.entries(this._coverage)) {
      info.lines = runs[file]?.lines;
      info.arcs = runs[file]?.arcs;
    }
    this.recordHits(this._coverage);
  }

  public recordSingle(run: PythonRun, file: string = pyFileName): void {
    this.record({ [file]: run });
  }
} // class: TestCoreCoverageMeasure

describe("fuzzer/measures/CoverageMeasure: core logic", () => {
  const singleFileMeasure = (staticInfo: CoverageInfo = twoPathStatic) =>
    new TestCoreCoverageMeasure({ [pyFileName]: staticInfo });

  const runTest = (
    measure: TestCoreCoverageMeasure,
    run: PythonRun,
    input: InputAndSource,
    file: string = pyFileName
  ) => {
    measure.recordSingle(run, file);
    return measure.measure(input, anyResult);
  }; // fn: runTest

  // ------------------------------------------------------------------
  // Delta attribution and order invariance
  // ------------------------------------------------------------------
  describe("delta attribution and order invariance", () => {
    it("measure reports the same coverage for a call no matter what ran before it", () => {
      const coverageByCall = (order: PythonRun[]): string[][] => {
        const measure = singleFileMeasure(threePathStatic);
        return order.map((run, tick) =>
          coveredKeys(
            runTest(measure, run, inputAt(tick)).coverageMeasure.current
          )
        );
      };

      const runs = [threePathNegative, threePathZero, threePathPositive];
      const forward = coverageByCall(runs);
      const reverse = coverageByCall([...runs].reverse());

      expect(forward[0].length).toBeGreaterThan(0);
      expect(reverse).toEqual([...forward].reverse());
    });

    it("the coverage a run discovers does not depend on the order of its inputs", () => {
      const runOrder = (order: PythonRun[]): string[] => {
        const measure = singleFileMeasure(threePathStatic);
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

      expect(forward.length).toBeGreaterThan(0);
      expect(runOrder([...runs].reverse())).toEqual(forward);
      expect(
        runOrder([threePathZero, threePathPositive, threePathNegative])
      ).toEqual(forward);
    });

    it("measure credits each input with exactly the coverage it added", () => {
      const measure = singleFileMeasure(threePathStatic);

      const deltas = [threePathNegative, threePathZero, threePathPositive].map(
        (run, tick) =>
          runTest(measure, run, inputAt(tick)).coverageMeasure.globalDelta
      );

      expect(deltas).toEqual([4, 4, 2]);
      expect(deltas.reduce((sum, delta) => sum + delta, 0)).toEqual(10);

      expect(
        runTest(measure, threePathNegative, inputAt(3)).coverageMeasure
          .globalDelta
      ).toEqual(0);
    });

    it("measure credits each input in a lineage with the coverage it added", () => {
      const measure = singleFileMeasure(threePathStatic);
      const inputs = [inputAt(0), mutantAt(1, 0), mutantAt(2, 0)];

      const deltas = [threePathNegative, threePathZero, threePathPositive].map(
        (run, i) => runTest(measure, run, inputs[i]).coverageMeasure.globalDelta
      );

      expect(deltas).toEqual([4, 4, 2]);
      expect(deltas.reduce((sum, delta) => sum + delta, 0)).toEqual(10);
    });

    it("measure repeats the location maps unchanged while the counters change", () => {
      const measure = singleFileMeasure(twoPathStatic);

      const first = runTest(
        measure,
        twoPathNegative,
        inputAt(0)
      ).coverageMeasure.current.fileCoverageFor(pyFileName);
      const maps = {
        statementMap: structuredClone(first.statementMap),
        fnMap: structuredClone(first.fnMap),
        branchMap: structuredClone(first.branchMap),
      };
      expect(first.b).toEqual({ 0: [1, 0] });

      const second = runTest(
        measure,
        twoPathPositive,
        inputAt(1)
      ).coverageMeasure.current.fileCoverageFor(pyFileName);

      expect(second.statementMap).toEqual(maps.statementMap);
      expect(second.fnMap).toEqual(maps.fnMap);
      expect(second.branchMap).toEqual(maps.branchMap);
      expect(second.b).toEqual({ 0: [0, 1] });
    });
  });

  // ------------------------------------------------------------------
  // Lineage DAG
  // ------------------------------------------------------------------
  describe("lineage DAG", () => {
    it("measure reports no lineage progress for an input with no predecessor", () => {
      const measure = singleFileMeasure(threePathStatic);

      expect(
        runTest(measure, threePathNegative, inputAt(0)).coverageMeasure
          .accumDelta
      ).toEqual(0);

      expect(
        runTest(measure, threePathZero, mutantAt(1)).coverageMeasure.accumDelta
      ).toEqual(0);

      expect(
        runTest(measure, threePathPositive, mutantAt(2, 99)).coverageMeasure
          .accumDelta
      ).toEqual(0);
    });

    it("measure accumulates a descendant's coverage into its lineage root", () => {
      const measure = singleFileMeasure(threePathStatic);

      runTest(measure, threePathNegative, inputAt(0)); // root
      runTest(measure, threePathZero, mutantAt(1, 0)); // child
      const sibling = runTest(measure, threePathPositive, mutantAt(2, 0));
      const siblingKeys = coveredKeys(sibling.coverageMeasure.current);

      const rootAccum = coveredKeys(
        measure.getCoverage(0).coverageMeasure.accum
      );
      for (const key of siblingKeys) {
        expect(rootAccum).toContain(key);
      }

      // Grandchild is scored against lineage root
      expect(
        runTest(measure, threePathPositive, mutantAt(3, 1)).coverageMeasure
          .accumDelta
      ).toEqual(0);
    });

    it("measure reports lineage progress only for coverage new to the lineage", () => {
      const measure = singleFileMeasure(threePathStatic);

      runTest(measure, threePathNegative, inputAt(0)); // root
      const novel = runTest(measure, threePathPositive, mutantAt(1, 0));
      const dupe = runTest(measure, threePathPositive, mutantAt(2, 0));

      expect(novel.coverageMeasure.accumDelta).toBeGreaterThan(0);
      expect(dupe.coverageMeasure.accumDelta).toEqual(0);
    });

    it("a measurement's accumulated coverage includes the coverage it measured", () => {
      const measure = singleFileMeasure(threePathStatic);
      const inputs = [inputAt(0), mutantAt(1, 0), mutantAt(2, 1)];

      [threePathNegative, threePathZero, threePathPositive].forEach(
        (run, i) => {
          const meas = runTest(measure, run, inputs[i]);
          const current = coveredKeys(meas.coverageMeasure.current);
          const accum = coveredKeys(meas.coverageMeasure.accum);

          expect(current.length).toBeGreaterThan(0);
          for (const key of current) {
            expect(accum).toContain(key);
          }
        }
      );
    });

    it("correctly evaluates lineage when inputs finish out of sequential order", () => {
      const measure = singleFileMeasure(threePathStatic);

      // Root at tick 10
      runTest(measure, threePathNegative, inputAt(10));

      // Child at tick 15 pointing to root at tick 10
      const child15 = runTest(measure, threePathZero, mutantAt(15, 10));
      expect(child15.coverageMeasure.accumDelta).toEqual(4);

      // Sibling at tick 12 pointing to root at tick 10 arrives later
      const sibling12 = runTest(measure, threePathPositive, mutantAt(12, 10));
      expect(sibling12.coverageMeasure.accumDelta).toBeGreaterThan(0);
    });

    it("prunes unreferenced non-improving mutation nodes to prevent unbounded memory growth", () => {
      const measure = singleFileMeasure(threePathStatic);

      runTest(measure, threePathNegative, inputAt(0));
      expect(measure.hasCoverage(0)).toBeTrue();

      // 25 consecutive dead-end mutations that produce zero coverage delta
      for (let t = 1; t <= 25; t++) {
        runTest(measure, threePathNegative, mutantAt(t, 0));
      }

      // Older unreferenced dead-end leaves should be pruned
      expect(measure.hasCoverage(1)).toBeFalse();
      expect(measure.hasCoverage(5)).toBeFalse();
      expect(measure.hasCoverage(15)).toBeFalse();

      // But root tick 0 remains preserved because it is referenced as ancestor
      expect(measure.hasCoverage(0)).toBeTrue();
    });
  });

  // ------------------------------------------------------------------
  // Multi-file coordination
  // ------------------------------------------------------------------
  describe("multiple files", () => {
    const fileA = "/tmp/core_a.py"; // twoPathStatic: 4 lines, 1 fn, 1 branch
    const fileB = "/tmp/util_b.py"; // linearStatic:  3 lines, 1 fn, no branch

    const twoFileMeasure = () =>
      new TestCoreCoverageMeasure({
        [fileA]: twoPathStatic,
        [fileB]: linearStatic,
      });

    it("measure records each file's own coverage when a call runs through two", () => {
      const measure = twoFileMeasure();

      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const current = measure.measure(inputAt(0), anyResult).coverageMeasure
        .current;

      expect(current.files().sort()).toEqual([fileA, fileB].sort());

      const a = current.fileCoverageFor(fileA);
      expect(a.s).toEqual({ 0: 0, 1: 1, 2: 1, 3: 0 });
      expect(a.f).toEqual({ 0: 1 });
      expect(a.b).toEqual({ 0: [1, 0] });

      const b = current.fileCoverageFor(fileB);
      expect(b.s).toEqual({ 0: 0, 1: 1, 2: 1 });
      expect(b.f).toEqual({ 0: 1 });
      expect(b.b).toEqual({});
    });

    it("measure reports a file the call never entered as uncovered", () => {
      const measure = twoFileMeasure();

      measure.record({ [fileA]: twoPathNegative });
      const current = measure.measure(inputAt(0), anyResult).coverageMeasure
        .current;

      expect(current.files().sort()).toEqual([fileA, fileB].sort());
      const b = current.fileCoverageFor(fileB);
      expect(b.s).toEqual({ 0: 0, 1: 0, 2: 0 });
      expect(b.f).toEqual({ 0: 0 });

      expect(current.fileCoverageFor(fileA).f).toEqual({ 0: 1 });
      expect(current.fileCoverageFor(fileA).b).toEqual({ 0: [1, 0] });

      const summary = current.getCoverageSummary().toJSON();
      expect(summary.statements.total).toEqual(7);
      expect(summary.statements.covered).toEqual(2);
      expect(summary.functions.total).toEqual(2);
      expect(summary.functions.covered).toEqual(1);
      expect(summary.branches.total).toEqual(2);
      expect(summary.branches.covered).toEqual(1);
    });

    it("measure credits an input for the coverage it added in any file", () => {
      const measure = twoFileMeasure();

      measure.record({ [fileA]: twoPathNegative });
      const first = measure.measure(inputAt(0), anyResult).coverageMeasure
        .globalDelta;

      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const second = measure.measure(inputAt(1), anyResult).coverageMeasure
        .globalDelta;

      measure.record({ [fileA]: twoPathPositive, [fileB]: linearRun });
      const third = measure.measure(inputAt(2), anyResult).coverageMeasure
        .globalDelta;

      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const fourth = measure.measure(inputAt(3), anyResult).coverageMeasure
        .globalDelta;

      expect(first).toEqual(4);
      expect(second).toEqual(3);
      expect(third).toEqual(2);
      expect(fourth).toEqual(0);
      expect(first + second + third + fourth).toEqual(9);
    });

    it("measure reports lineage progress for coverage new in another file", () => {
      const measure = twoFileMeasure();

      measure.record({ [fileA]: twoPathNegative });
      measure.measure(inputAt(0), anyResult);

      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const novel = measure.measure(mutantAt(1, 0), anyResult);
      expect(novel.coverageMeasure.accumDelta).toEqual(3);

      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const dupe = measure.measure(mutantAt(2, 0), anyResult);
      expect(dupe.coverageMeasure.accumDelta).toEqual(0);

      const rootAccum = measure.getCoverage(0).coverageMeasure.accum;
      expect(rootAccum.files().sort()).toEqual([fileA, fileB].sort());
      expect(rootAccum.fileCoverageFor(fileB).f).toEqual({ 0: 2 });
      expect(rootAccum.fileCoverageFor(fileB).s).toEqual({ 0: 0, 1: 2, 2: 2 });
    });

    it("measure does not carry a file's coverage into the next call", () => {
      const measure = twoFileMeasure();

      measure.record({ [fileA]: twoPathNegative, [fileB]: linearRun });
      const firstB = measure
        .measure(inputAt(0), anyResult)
        .coverageMeasure.current.fileCoverageFor(fileB);
      expect(firstB.f).toEqual({ 0: 1 });

      measure.record({ [fileA]: twoPathPositive });
      const second = measure.measure(inputAt(1), anyResult).coverageMeasure
        .current;

      expect(second.fileCoverageFor(fileB).s).toEqual({ 0: 0, 1: 0, 2: 0 });
      expect(second.fileCoverageFor(fileB).f).toEqual({ 0: 0 });
      expect(second.fileCoverageFor(fileA).s).toEqual({
        0: 0,
        1: 1,
        2: 0,
        3: 1,
      });
      expect(second.fileCoverageFor(fileA).b).toEqual({ 0: [0, 1] });
    });

    it("measure keeps files in separate directories apart", () => {
      const dirCore = "/tmp/proj/pkg/core.py";
      const dirUtil = "/tmp/proj/lib/util.py";
      const measure = new TestCoreCoverageMeasure({
        [dirCore]: twoPathStatic,
        [dirUtil]: linearStatic,
      });

      measure.record({ [dirCore]: twoPathNegative, [dirUtil]: linearRun });
      const current = measure.measure(inputAt(0), anyResult).coverageMeasure
        .current;

      expect(current.files().sort()).toEqual([dirCore, dirUtil].sort());
      expect(current.fileCoverageFor(dirCore).path).toEqual(dirCore);
      expect(current.fileCoverageFor(dirUtil).path).toEqual(dirUtil);
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
      const pkgUtil = "/tmp/proj/pkg/util.py";
      const libUtil = "/tmp/proj/lib/util.py";
      const measure = new TestCoreCoverageMeasure({
        [pkgUtil]: twoPathStatic,
        [libUtil]: twoPathStatic,
      });

      measure.record({ [pkgUtil]: twoPathNegative });
      const first = measure.measure(inputAt(0), anyResult).coverageMeasure;

      expect(first.current.files().sort()).toEqual([libUtil, pkgUtil].sort());
      expect(first.current.fileCoverageFor(pkgUtil).b).toEqual({ 0: [1, 0] });
      expect(first.current.fileCoverageFor(libUtil).b).toEqual({ 0: [0, 0] });
      expect(first.globalDelta).toEqual(4);

      measure.record({ [libUtil]: twoPathPositive });
      const second = measure.measure(inputAt(1), anyResult).coverageMeasure;

      expect(second.current.fileCoverageFor(libUtil).b).toEqual({ 0: [0, 1] });
      expect(second.current.fileCoverageFor(pkgUtil).b).toEqual({ 0: [0, 0] });
      expect(second.globalDelta).toEqual(4);
    });
  });

  // ------------------------------------------------------------------
  // Cumulative Hit Counts, Scale & Run End Statistics
  // ------------------------------------------------------------------
  describe("scale and statistics", () => {
    it("preserves accurate cumulative hit counts exceeding 255 without byte wrapping or clamping", async () => {
      const measure = singleFileMeasure(twoPathStatic);

      for (let i = 0; i < 300; i++) {
        runTest(measure, twoPathNegative, inputAt(i));
      }

      const stats = await statsOf(measure);
      const file = stats.files[0];

      expect(file.fileMap.s[1]).toEqual(300);
      expect(file.fileMap.s[2]).toEqual(300);
      expect(file.fileMap.b[0][0]).toEqual(300);
    });

    it("onRunEnd installs its stats without disturbing the rest of the results", () => {
      const measure = singleFileMeasure(twoPathStatic);
      const results = resultsStub();
      const before = {
        results: results.results,
        counters: structuredClone(results.stats.counters),
        outcomes: structuredClone(results.stats.outcomes),
        timers: structuredClone(results.stats.timers),
        generators: structuredClone(results.stats.generators),
      };

      measure.onRunEnd(results);

      expect(typeof results.stats.measures.CodeCoverageMeasure).toEqual(
        "function"
      );
      expect(Object.keys(results.stats.measures)).toEqual([
        "CodeCoverageMeasure",
      ]);
      expect(results.results).toBe(before.results);
      expect(results.stats.counters).toEqual(before.counters);
      expect(results.stats.outcomes).toEqual(before.outcomes);
      expect(results.stats.timers).toEqual(before.timers);
      expect(results.stats.generators).toEqual(before.generators);
    });

    it("getCoverageStats generates CodeCoverageMeasureStats during run", async () => {
      const measure = singleFileMeasure(twoPathStatic);
      runTest(measure, twoPathNegative, inputAt(0));

      const stats = await measure.getCoverageStats();
      expect(stats).toBeDefined();
      expect(stats.files.length).toEqual(1);
      expect(stats.counters.statementsTotal).toEqual(4);
      expect(stats.counters.statementsCovered).toEqual(2);
    });

    it("getUncoveredLines returns uncovered and partially covered lines", async () => {
      const measure = singleFileMeasure(twoPathStatic);
      const uncoveredBefore = await measure.getUncoveredLines();
      expect(
        Object.keys(uncoveredBefore.uncoveredLinesByFile).length
      ).toBeGreaterThan(0);

      runTest(measure, twoPathNegative, inputAt(0));
      const uncoveredAfter = await measure.getUncoveredLines();
      expect(uncoveredAfter).toBeDefined();
      expect(uncoveredAfter.uncoveredLinesByFile).toBeDefined();
    });

    it("the stats report exactly the coverage the run's inputs were credited with", async () => {
      const measure = singleFileMeasure(threePathStatic);

      const deltas = [threePathNegative, threePathZero, threePathPositive].map(
        (run, tick) =>
          runTest(measure, run, inputAt(tick)).coverageMeasure.globalDelta
      );
      expect(deltas).toEqual([4, 4, 2]);

      const stats = await statsOf(measure);

      const covered =
        stats.counters.functionsCovered +
        stats.counters.statementsCovered +
        stats.counters.branchesCovered;
      expect(covered).toEqual(deltas.reduce((sum, delta) => sum + delta, 0));
      expect(covered).toEqual(10);
    });

    it("the stats report the same totals no matter which paths the run took", async () => {
      const countersFor = async (runs: PythonRun[]) => {
        const measure = singleFileMeasure(threePathStatic);
        runs.forEach((run, tick) => runTest(measure, run, inputAt(tick)));
        return (await statsOf(measure)).counters;
      };

      const negative = await countersFor([threePathNegative]);
      const every = await countersFor([
        threePathNegative,
        threePathZero,
        threePathPositive,
      ]);

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
    });

    it("the global counters are the sum of the per-file counters", async () => {
      const measure = singleFileMeasure(twoPathStatic);
      runTest(measure, twoPathNegative, inputAt(0));
      runTest(measure, twoPathPositive, inputAt(1));

      const stats = await statsOf(measure);

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
      expect(stats.counters).toEqual({
        functionsTotal: 1,
        functionsCovered: 1,
        statementsTotal: 4,
        statementsCovered: 3,
        branchesTotal: 2,
        branchesCovered: 2,
      });
    });

    it("every counter the stats report has a location to point at", async () => {
      const branchless = singleFileMeasure(multiFunctionStatic);
      runTest(branchless, multiFunctionRun, inputAt(0));

      const partial = singleFileMeasure(threePathStatic);
      runTest(partial, threePathNegative, inputAt(0));

      const [byFunction, byBranch] = [
        await statsOf(branchless),
        await statsOf(partial),
      ];

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
    });

    it("the stats report a normalized path to the source", async () => {
      const rawPath = "/tmp/pkg/../abs_value.py";
      const measure = new TestCoreCoverageMeasure({
        [rawPath]: twoPathStatic,
      });
      runTest(measure, twoPathNegative, inputAt(0), rawPath);

      const stats = await statsOf(measure);
      expect(stats.files.length).toEqual(1);
      const file = stats.files[0];

      expect(file.path).toEqual(normalizePathForKey(pyFileName));
      expect(file.path).not.toContain("..");
      expect(file.fileMap.path).toEqual(rawPath);
    });

    it("onRunEnd reports empty stats for a run that measured nothing", async () => {
      const stats = await statsOf(new CoverageMeasure());

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
  });
});
