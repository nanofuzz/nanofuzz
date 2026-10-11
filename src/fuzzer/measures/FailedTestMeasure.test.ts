import { CoverageMapData, createCoverageMap } from "istanbul-lib-coverage";
import { FailedTestMeasure } from "./FailedTestMeasure";
import {
  AbstractCoverageMeasure,
  CoverageMeasurement,
} from "./AbstractCoverageMeasure";
import { PythonCoverageMeasure } from "./PythonCoverageMeasure";
import { PythonRunner } from "../runners/python/PythonRunner";
import {
  PythonFileCoverageData,
  PythonCoverageMapData,
} from "../runners/AbstractRunner";
import {
  twoPathStatic,
  twoPathNegative,
  twoPathPositive,
} from "./test_fixtures/PythonCoverageMeasure.testfixture1";
import { FuzzTestResult, InputAndSource } from "../Types";

class MockCoverageMeasure extends AbstractCoverageMeasure {
  public coverageMapPerTick = new Map<number, CoverageMapData>();
  public getCoverageCallCount = 0;
  public hasCoverageCallCount = 0;

  public hasCoverage(tick: number): boolean {
    this.hasCoverageCallCount++;
    return this.coverageMapPerTick.has(tick);
  } // fn: hasCoverage

  public getCoverage(tick: number): CoverageMeasurement {
    this.getCoverageCallCount++;
    const data = this.coverageMapPerTick.get(tick) ?? {};
    return {
      type: "measure",
      name: this.name,
      coverageMeasure: {
        current: createCoverageMap(data),
        accum: createCoverageMap(),
        accumDelta: 0,
        globalDelta: 0,
      },
    };
  } // fn: getCoverage

  public recordHits(_coverageData: unknown): void {
    return;
  } // fn: recordHits

  public delta(_a: unknown): number {
    return 0;
  } // fn: delta
} // class: MockCoverageMeasure

describe("FailedTestMeasure", () => {
  const dummyInput: InputAndSource = {
    tick: 1,
    source: { type: "generator", generator: "RandomInputGenerator" },
    value: [],
  };

  const createPassingResult = (): FuzzTestResult => ({
    input: [],
    inputGenerated: dummyInput,
    output: [{ name: "0", value: 42, offset: 0, origin: { type: "put" } }],
    passedImplicit: "pass",
    passedHuman: "pass",
    passedValidators: ["pass"],
    passedValidator: "pass",
    category: "ok",
    skipped: false,
    timeout: false,
    exception: false,
    harnessErrors: [],
    pinned: false,
    interestingReasons: [],
    timers: { gen: 0, transform: 0, run: 0 },
  });

  const createFailingResult = (): FuzzTestResult => ({
    input: [],
    inputGenerated: dummyInput,
    output: [{ name: "0", value: 0, offset: 0, origin: { type: "put" } }],
    passedImplicit: "fail",
    passedHuman: "pass",
    passedValidators: ["pass"],
    passedValidator: "pass",
    category: "badValue",
    skipped: false,
    timeout: false,
    exception: false,
    harnessErrors: [],
    pinned: false,
    interestingReasons: [],
    timers: { gen: 0, transform: 0, run: 0 },
  });

  it("does not query coverage or stringify coverage maps when tests pass", () => {
    const mockCov = new MockCoverageMeasure();
    mockCov.coverageMapPerTick.set(1, {
      "foo.js": {
        path: "foo.js",
        statementMap: {},
        s: {},
        b: {},
        f: {},
        fnMap: {},
        branchMap: {},
      },
    });
    const measure = new FailedTestMeasure(mockCov);

    const result = measure.measure(dummyInput, createPassingResult());

    expect(result.failedTestMeasure.current).toEqual([]);
    expect(result.failedTestMeasure.pseudoBugsDelta).toBe(0);
    expect(mockCov.hasCoverageCallCount).toBe(0);
    expect(mockCov.getCoverageCallCount).toBe(0);
    expect(measure.delta(result)).toBe(0);
  }); // fn: it

  it("queries coverage and records a pseudo bug when a test fails", () => {
    const mockCov = new MockCoverageMeasure();
    mockCov.coverageMapPerTick.set(1, {
      "foo.js": {
        path: "foo.js",
        statementMap: {},
        s: {},
        b: {},
        f: {},
        fnMap: {},
        branchMap: {},
      },
    });
    const measure = new FailedTestMeasure(mockCov);

    const result = measure.measure(dummyInput, createFailingResult());

    expect(result.failedTestMeasure.current).toEqual([0]);
    expect(result.failedTestMeasure.pseudoBugsDelta).toBe(1);
    expect(mockCov.hasCoverageCallCount).toBe(1);
    expect(mockCov.getCoverageCallCount).toBe(1);
    expect(measure.delta(result)).toBe(1);
  }); // fn: it

  it("does not report a new pseudo bug for identical failure and coverage", () => {
    const mockCov = new MockCoverageMeasure();
    mockCov.coverageMapPerTick.set(1, {
      "foo.js": {
        path: "foo.js",
        statementMap: {},
        s: {},
        b: {},
        f: {},
        fnMap: {},
        branchMap: {},
      },
    });
    const measure = new FailedTestMeasure(mockCov);

    const first = measure.measure(dummyInput, createFailingResult());
    expect(first.failedTestMeasure.pseudoBugsDelta).toBe(1);

    const second = measure.measure(dummyInput, createFailingResult());
    expect(second.failedTestMeasure.current).toEqual([]);
    expect(second.failedTestMeasure.pseudoBugsDelta).toBe(0);
  }); // fn: it

  it("reports a new pseudo bug when failure has distinct coverage", () => {
    const mockCov = new MockCoverageMeasure();
    mockCov.coverageMapPerTick.set(1, {
      "foo.js": {
        path: "foo.js",
        statementMap: {},
        s: { 0: 1 },
        b: {},
        f: {},
        fnMap: {},
        branchMap: {},
      },
    });
    mockCov.coverageMapPerTick.set(2, {
      "foo.js": {
        path: "foo.js",
        statementMap: {},
        s: { 0: 2 },
        b: {},
        f: {},
        fnMap: {},
        branchMap: {},
      },
    });
    const measure = new FailedTestMeasure(mockCov);

    const first = measure.measure(dummyInput, createFailingResult());
    expect(first.failedTestMeasure.pseudoBugsDelta).toBe(1);

    const input2: InputAndSource = { ...dummyInput, tick: 2 };
    const second = measure.measure(input2, createFailingResult());
    expect(second.failedTestMeasure.pseudoBugsDelta).toBe(1);
  }); // fn: it

  it("resets state on onRunStart", () => {
    const measure = new FailedTestMeasure();
    const result1 = measure.measure(dummyInput, createFailingResult());
    expect(result1.failedTestMeasure.pseudoBugsDelta).toBe(1);

    measure.onRunStart([]);
    const result2 = measure.measure(dummyInput, createFailingResult());
    expect(result2.failedTestMeasure.pseudoBugsDelta).toBe(1);
  }); // fn: it

  describe("integration with concrete coverage measures", () => {
    const pyFile = "/tmp/test.py";

    class StubRunner extends PythonRunner {
      public constructor(cov: PythonCoverageMapData) {
        super(pyFile, "testFn");
        this._coverageInfo = cov;
      } // fn: constructor
    } // class: StubRunner

    class RealPythonCovMeasure extends PythonCoverageMeasure {
      private readonly _info: PythonFileCoverageData;
      private readonly _coverage: PythonCoverageMapData;

      public constructor(staticInfo: PythonFileCoverageData) {
        super();
        this._info = { ...staticInfo };
        this._coverage = { [pyFile]: this._info };
        this._runners = [new StubRunner(this._coverage)];
      } // fn: constructor

      public record(lines: number[], arcs: [number, number][]): void {
        this.onBeforeNextTestExecution();
        this._info.lines = lines;
        this._info.arcs = arcs;
        this.recordHits(this._coverage);
      } // fn: record
    } // class: RealPythonCovMeasure

    it("fingerprints distinct bugs using actual coverage maps and preserves zero-delta failing tests", () => {
      const realCov = new RealPythonCovMeasure(twoPathStatic);
      const failedMeasure = new FailedTestMeasure(realCov);

      // Step 1: Input 0 passes and executes the negative branch (lines 1, 2, 4)
      const in0: InputAndSource = { ...dummyInput, tick: 0 };
      realCov.record(twoPathNegative.lines, twoPathNegative.arcs);
      const cov0 = realCov.measure(in0, createPassingResult());
      expect(cov0.coverageMeasure.globalDelta).toBeGreaterThan(0);
      const fail0 = failedMeasure.measure(in0, createPassingResult());
      expect(fail0.failedTestMeasure.pseudoBugsDelta).toEqual(0);

      // Step 2: Input 1 fails but executes the same negative branch (0 new lines discovered)
      const in1: InputAndSource = { ...dummyInput, tick: 1 };
      realCov.record(twoPathNegative.lines, twoPathNegative.arcs);
      const cov1 = realCov.measure(in1, createFailingResult());
      expect(cov1.coverageMeasure.globalDelta).toEqual(0); // zero coverage delta!
      expect(realCov.hasCoverage(in1.tick)).toBeTrue(); // coverage must still be retained!
      const fail1 = failedMeasure.measure(in1, createFailingResult());
      expect(fail1.failedTestMeasure.pseudoBugsDelta).toEqual(1); // 1st distinct pseudo-bug

      // Step 3: Input 2 fails on identical coverage path
      const in2: InputAndSource = { ...dummyInput, tick: 2 };
      realCov.record(twoPathNegative.lines, twoPathNegative.arcs);
      realCov.measure(in2, createFailingResult());
      const fail2 = failedMeasure.measure(in2, createFailingResult());
      expect(fail2.failedTestMeasure.pseudoBugsDelta).toEqual(0); // already seen this bug path

      // Step 4: Input 3 fails but executes the alternate positive branch (lines 1, 2, 3)
      const in3: InputAndSource = { ...dummyInput, tick: 3 };
      realCov.record(twoPathPositive.lines, twoPathPositive.arcs);
      realCov.measure(in3, createFailingResult());
      const fail3 = failedMeasure.measure(in3, createFailingResult());
      expect(fail3.failedTestMeasure.pseudoBugsDelta).toEqual(1); // 2nd distinct pseudo-bug
    }); // fn: it
  }); // describe: integration with concrete coverage measures
}); // describe: FailedTestMeasure
