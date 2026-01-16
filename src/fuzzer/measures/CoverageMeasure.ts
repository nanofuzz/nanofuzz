import { AbstractMeasure, BaseMeasurement } from "./AbstractMeasure";
import { createInstrumenter } from "istanbul-lib-instrument";
import { createSourceMapStore, MapStore } from "istanbul-lib-source-maps";
import {
  CoverageMap,
  CoverageMapData,
  createCoverageMap,
} from "istanbul-lib-coverage";
import { FuzzTestResult, VmGlobals } from "../Types";
import { FuzzTestResults } from "../Fuzzer";
import { InputAndSource } from "../generators/Types";
import { normalizePathForKey } from "../../Util";

import * as fs from "fs";

/**
 * Measures code coverage of test executions
 */
export class CoverageMeasure extends AbstractMeasure {
  protected _coverageData?: CoverageMapData; // coverage data maintained by instrumented code
  protected _globalCoverageMap = createCoverageMap({}); // global code coverage map
  protected _history: CoverageMeasurementNode[] = []; // measurement history
  protected _sourceMapStore: MapStore = createSourceMapStore();
  protected _lineHitCounts: Map<string, Map<number, number>> = new Map(); // tracks per-line hit counts across test runs

  /**
   * Instruments the program under test to capture code coverage data.
   * This runs after compilation (from TS to JS) but prior to load.
   *
   * @param `jsSrc` input javascript source code
   * @param `jsFileName` javascript source filename
   * @returns instrumented code
   */
  public onAfterCompile(jsSrc: string, jsFileName: string): string {
    const mapPath = jsFileName + ".map";
    let sourceMap: any | undefined;

    if (fs.existsSync(mapPath)) {
      sourceMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    }

    const instrumenter = createInstrumenter({
      produceSourceMap: true,
      coverageGlobalScope: "global",
    });

    const instrumented = instrumenter.instrumentSync(
      jsSrc,
      jsFileName,
      sourceMap
    );

    const combinedSourceMap = instrumenter.lastSourceMap();
    this._sourceMapStore.registerMap(jsFileName, combinedSourceMap);

    return instrumented;
  } // fn: onAfterCompile

  /**
   * Saves a pointer to the coverage data structurte created and
   * maintained by the code coverage instrumentation. We use this
   * pointer during test execution to extract code coverage data.
   *
   * @param `context` context of the loaded program
   */
  public onAfterLoad(context: VmGlobals): void {
    // Save the global context of the original module load because
    // that is where the instrumented code writes coverage data
    if (
      typeof context.global === "object" &&
      context.global &&
      "__coverage__" in context.global &&
      isCoverageMapData(context.global.__coverage__)
    ) {
      this._coverageData = context.global.__coverage__;
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
  public async measure(
    input: InputAndSource,
    result: FuzzTestResult
  ): Promise<CoverageMeasurement> {
    const measure = await super.measure(input, result);

    // Sanity check that we have coverage data to ingest
    if (this._coverageData === undefined) {
      throw new Error("No current coverage data found");
    }

    // Shallow clone the raw current coverage data
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
        accumBefore = this._toNumber(nextPred.meas.coverageMeasure.accum);
        nextPred.meas.coverageMeasure.accum.merge(currentCoverageData);
        accumAfter = this._toNumber(nextPred.meas.coverageMeasure.accum);
      }
      nextPred = nextPred.pred;
    }

    // Merge the current coverage into the global coverage map
    const globalBefore = this._toNumber(this._globalCoverageMap);
    this._globalCoverageMap.merge(currentCoverageData);

    // Build the measurement object
    const meas = {
      ...measure,
      name: this.name,
      coverageMeasure: {
        current: createCoverageMap(currentCoverageData),
        globalDelta: this._toNumber(this._globalCoverageMap) - globalBefore,
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

    // We need to transform the global coverage map using the source maps
    // to get correct line numbers (and not the compiled JS line numbers).
    // TODO: async call here. im wondering if this will cause issues. if we
    // notice issues, we can look into not having to do this call each time we measure.
    const tsCoverageMap = await this._sourceMapStore.transformCoverage(
      createCoverageMap(currentCoverageData)
    );

    // Track which lines were hit in this test run (binary: hit or not hit)
    this._accumulateLineHitsForTestRun(tsCoverageMap);

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
   * Accumulates line hit counts for a single test run into the
   * _lineHitCounts map. This is a binary +1 or +0 (whether a line was hit during
   *  the test run or not).
   *
   * @param `tsCoverageMap` js-to-ts transformed coverage map from a single test run
   */
  protected _accumulateLineHitsForTestRun(tsCoverageMap: CoverageMap): void {
    for (const filePath of tsCoverageMap.files()) {
      const fileKey = normalizePathForKey(filePath);

      let lineHitCounts = this._lineHitCounts.get(fileKey);
      if (!lineHitCounts) {
        lineHitCounts = new Map<number, number>();
        this._lineHitCounts.set(fileKey, lineHitCounts);
      }

      const fileCoverage = tsCoverageMap.fileCoverageFor(filePath);
      const lineCoverage = fileCoverage.getLineCoverage();

      for (const [lineStr, hits] of Object.entries(lineCoverage)) {
        if (hits > 0) {
          const lineNum = Number(lineStr);
          lineHitCounts.set(lineNum, (lineHitCounts.get(lineNum) ?? 0) + 1);
        }
      }

      // Functions are not accounted for in the above line coverage,
      // so let us account for it here.
      for (const funcId in fileCoverage.f) {
        const funcMap = fileCoverage.fnMap[funcId];
        if (fileCoverage.f[funcId] > 0) {
          const lineNum = funcMap.loc.start.line;
          lineHitCounts.set(lineNum, (lineHitCounts.get(lineNum) ?? 0) + 1);
        }
      }
    }
  }

  /**
   * Called prior to fuzzer shut down.
   *
   * Fills in global code coverage statistics.
   *
   * @param `results` all test results
   */
  public async onShutdown(results: FuzzTestResults): Promise<void> {
    // We need to transform the global coverage map using the source maps
    // to get correct line numbers (and not the compiled JS line numbers).
    const tsCoverageMap = await this._sourceMapStore.transformCoverage(
      this._globalCoverageMap
    );
    const coverageSummary = tsCoverageMap.getCoverageSummary();

    const files: CodeCoverageFileStats[] = tsCoverageMap
      .files()
      .map((filePath) => {
        const filePathKey = normalizePathForKey(filePath);
        const accumulatedLineHits = this._lineHitCounts.get(filePathKey);

        const lineHits: LineHits = {};
        if (accumulatedLineHits) {
          for (const [lineNum, count] of accumulatedLineHits) {
            lineHits[lineNum] = count;
          }
        }

        // TODO: re-add if needed. these are just per-file coverage counters
        // const fileSummary = fileCoverage.toSummary();
        // const counters: CodeCoverageCounters = {
        //   functionsTotal: fileSummary.functions.total,
        //   functionsCovered: fileSummary.functions.covered,
        //   statementsTotal: fileSummary.statements.total,
        //   statementsCovered: fileSummary.statements.covered,
        //   branchesTotal: fileSummary.branches.total,
        //   branchesCovered: fileSummary.branches.covered,
        // };

        return {
          path: normalizePathForKey(filePath),
          // counters,
          lineHits,
        };
      });

    results.stats.measures.CodeCoverageMeasure = {
      counters: {
        functionsTotal: coverageSummary.functions.total,
        functionsCovered: coverageSummary.functions.covered,
        statementsTotal: coverageSummary.statements.total,
        statementsCovered: coverageSummary.statements.covered,
        branchesTotal: coverageSummary.branches.total,
        branchesCovered: coverageSummary.branches.covered,
      },
      files,
    };
  } // fn: onShutdown

  /**
   * Returns a numeric value that is the sum of branches, statements, and
   * functions covered. This is useful when comparing two aggregate coverage
   * measures to detect increases in code coverage.
   *
   * @param `m` a CoverageMap
   * @returns sum of branches, statements, and functions covered
   */
  protected _toNumber(m: CoverageMap): number {
    const summ = m.getCoverageSummary();
    return (
      summ.branches.covered + summ.statements.covered + summ.functions.covered
    );
  } // fn: toNumber

  /**
   * Returns whether coverage data exists for a particular tick
   *
   * @param `tick` input tick
   * @returns true if coverage data exists for `tick`, false otherwise
   */
  public hasCoverage(tick: number): boolean {
    return !!this._history[tick];
  } // fn: hasCoverage

  /**
   * Returns the coverage measurement for `tick`
   *
   * @param `tick` input tick
   * @returns the coverage measure for `tick`
   */
  public getCoverage(tick: number): CoverageMeasurement {
    if (this.hasCoverage(tick)) {
      return this._history[tick].meas; // rep leak !!!!!!!
    }
    throw new Error(`No coverahe data for "${tick}"`);
  } // fn: getCoverage
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

type CodeCoverageCounters = {
  functionsTotal: number;
  functionsCovered: number;
  statementsTotal: number;
  statementsCovered: number;
  branchesTotal: number;
  branchesCovered: number;
};

export type LineHits = { [line: number]: number };

/**
 * Per-file Code Coverage Statistics. Includes line-level hit counts, which necessitates
 * per-file stats since line numbers are file-specific.
 */
type CodeCoverageFileStats = {
  path: string;
  // counters: CodeCoverageCounters; // TODO: re-add if needed
  lineHits: LineHits;
  // lineHitsFromFailedTests: LineHits;
};

/**
 * Code Coverage Statistics
 */
export type CodeCoverageMeasureStats = {
  // Global counters
  counters: CodeCoverageCounters;

  // Per-file breakdown, including line-level hit counts
  files: CodeCoverageFileStats[];
};
