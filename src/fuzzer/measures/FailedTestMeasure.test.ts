import { CoverageMapData, createCoverageMap } from "istanbul-lib-coverage";
import { FailedTestMeasure } from "./FailedTestMeasure";
import {
  AbstractCoverageMeasure,
  CoverageMeasurement,
} from "./AbstractCoverageMeasure";
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
}); // describe: FailedTestMeasure
