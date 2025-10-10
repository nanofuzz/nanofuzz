import { AbstractMeasure, BaseMeasurement } from "./AbstractMeasure";
import { createInstrumenter } from "istanbul-lib-instrument";
import {
  CoverageMap,
  CoverageMapData,
  createCoverageMap,
} from "istanbul-lib-coverage";
import { FuzzTestResult, VmGlobals } from "../Types";
import { FuzzTestResults } from "fuzzer/Fuzzer";
import { InputAndSource } from "fuzzer/generators/Types";

/**
 * Measures code coverage of test executions
 */
export class CoverageMeasure extends AbstractMeasure {
  private _coverageData?: CoverageMapData; // coverage data maintained by instrumented code
  private _globalCoverageMap = createCoverageMap({}); // global code coverage map
  private _history: CoverageMeasurementNode[] = []; // measurement history

  /**
   * Instruments the program under test to capture code coverage data.
   * This runs after compilation (from TS to JS) but prior to load.
   *
   * @param `jsSrc`
   * @param `jsFileName`
   * @returns instrumented code
   */
  public onAfterCompile(jsSrc: string, jsFileName: string): string {
    return createInstrumenter({
      produceSourceMap: true,
      coverageGlobalScope: "global",
    }).instrumentSync(jsSrc, jsFileName);
  } // fn: onAfterCompile

  /**
   * Saves a pointer to the coverage data structurte created and
   * maintained by the code coverage instrumentation. We use this
   * pointer during test execution to extract code coverage data.
   *
   * @param `globals` context of the loaded program
   */
  public onAfterLoad(globals: VmGlobals): void {
    // Save the global context of the original module load because
    // that is where the instrumented code writes coverage data
    if (isCoverageMapData(globals.__coverage__)) {
      this._coverageData = globals.__coverage__;
    } else {
      throw new Error(
        "global.__coverage__ does not contain a valid CoverageMapData object"
      );
    }
  } // fn: onAfterLoad

  /**
   * Measure the code coverage of the most recent test execution.
   *
   * @param `input` test input
   * @param `result` test result
   * @returns a code coverage measurement for the test execution
   */
  public measure(
    input: InputAndSource,
    result: FuzzTestResult
  ): CoverageMeasurement {
    const measure = super.measure(input, result);

    // Sanity check that we have coverage data to ingest
    if (this._coverageData === undefined) {
      throw new Error("No current coverage data found");
    }

    // Shwllow clone the raw current coverage data
    const currentCoverageData = { ...this._coverageData };

    // Merge the current coverage into root predecessor
    const pred =
      input.source.tick === undefined
        ? undefined
        : this._history[input.source.tick];
    let accumBefore = 0;
    let accumAfter = 0;
    let nextPred = pred;
    while (nextPred) {
      if (!nextPred.pred) {
        accumBefore = this.toNumber(nextPred.meas.coverageMeasure.accum);
        nextPred.meas.coverageMeasure.accum.merge(currentCoverageData);
        accumAfter = this.toNumber(nextPred.meas.coverageMeasure.accum);
      }
      nextPred = nextPred.pred;
    }

    // Merge the current coverage into the global coverage map
    const globalBefore = this.toNumber(this._globalCoverageMap);
    this._globalCoverageMap.merge(currentCoverageData);

    // Build the measurement object
    const meas = {
      ...measure,
      name: this.name,
      coverageMeasure: {
        current: createCoverageMap(currentCoverageData),
        globalDelta: this.toNumber(this._globalCoverageMap) - globalBefore,
        accum: createCoverageMap(currentCoverageData),
        accumDelta: accumAfter - accumBefore,
      },
    };

    // Update measure history
    this._history[input.tick] = {
      input,
      pred,
      meas,
    };

    // Return the measurement
    return meas;
  } // fn: measure

  /**
   * Calculates a numeric value representing the test execution's progress
   *
   * @param `a` code coverage measurement
   * @returns a numeric value representing the progress of the test execution
   */
  public delta(a: CoverageMeasurement): number {
    return a.coverageMeasure.globalDelta * 100 + a.coverageMeasure.accumDelta; // !!!!!!!
  } // fn: delta

  /**
   * Zeroes out the code coverage data updated by the instrumented code
   * prior to each test execution so that we record the code coverage for
   * each individual test execution. We aggregate each run's code coverage
   * later in `measure`.
   */
  public onBeforeNextTestExecution(): void {
    // Zero out the coverage data so that we know the incremental
    // coverage for just the present execution
    if (this._coverageData) {
      let fileKey: keyof typeof this._coverageData;
      for (fileKey in this._coverageData) {
        this._coverageData[fileKey] = { ...this._coverageData[fileKey] };
        const fileCoverage = this._coverageData[fileKey];
        Object.keys(fileCoverage.b).forEach((bKey) => {
          fileCoverage.b[bKey] = [0, 0];
        });
        Object.keys(fileCoverage.s).forEach((sKey) => {
          fileCoverage.s[sKey] = 0;
        });
        Object.keys(fileCoverage.f).forEach((fKey) => {
          fileCoverage.f[fKey] = 0;
        });
      }
    }
  } // fn: onBeforeNextTestExecution

  /**
   * Called prior to fuzzer shut down. Currently does nothing.
   *
   * @param `results` all test results
   */
  public onShutdown(results: FuzzTestResults): void {
    results;
  } // fn: onShutdown

  /**
   * Returns a numeric value that is the sum of branches, statements, and
   * functions covered. This is useful when comparing two aggregate coverage
   * measures to detect increases in code coverage.
   *
   * @param `m` a CoverageMap
   * @returns sum of branches, statements, and functions covered
   */
  private toNumber(m: CoverageMap): number {
    const summ = m.getCoverageSummary();
    return (
      summ.branches.covered + summ.statements.covered + summ.functions.covered
    );
  } // fn: toNumber
} // class: CoverageMeasure

/**
 * Type guard function that returns true if `obj` is a CoverageMapData type
 *
 * @param `obj` the object to check
 * @returns true if `obj` is a CoverageMapData object, false otherwise
 */
export function isCoverageMapData(obj: unknown): obj is CoverageMapData {
  return (
    obj !== undefined &&
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    // below is based on istanbul's assertValidObject from file-coverage.js
    Object.values(obj).every(
      (e) =>
        e &&
        e.path &&
        e.statementMap &&
        e.fnMap &&
        e.branchMap &&
        e.s &&
        e.f &&
        e.b
    )
  );
} // fn: isCoverageData

/**
 * Extends BaseMeasurement with code coverage details
 */
export type CoverageMeasurement = BaseMeasurement & {
  name: string;
  coverageMeasure: {
    current: CoverageMap; // coverage of the current test input
    accum: CoverageMap; // accumulated coverage of successors (root only)
    accumDelta: number; // code coverage improvement vs. root aggregate coverage
    globalDelta: number; // code coverage improvement vs. global aggregate coverage
  };
};

/**
 * A node in a directed graph of input relations. For instance, a mutated input
 * points to its predecessor's measurement.
 */
type CoverageMeasurementNode = {
  input: InputAndSource;
  pred: CoverageMeasurementNode | undefined;
  meas: CoverageMeasurement;
};
