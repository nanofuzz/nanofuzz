import * as JSONN from "../../Jsonn";
import { createInstrumenter } from "istanbul-lib-instrument";
import { createSourceMapStore, MapStore } from "istanbul-lib-source-maps";
import { RawSourceMap } from "source-map";
import {
  CoverageMap,
  CoverageMapData,
  createCoverageMap,
  FileCoverage,
} from "istanbul-lib-coverage";
import {
  VmGlobals,
  InputAndSource,
  FuzzTestResult,
  FuzzTestResults,
} from "../Fuzzer";
import { normalizePathForKey } from "../Util";
import * as fs from "fs";
import {
  AbstractCoverageMeasure,
  CodeCoverageFileStats,
  CodeCoverageMeasureStats,
  CoverageMeasurement,
  CoverageMeasurementNode,
} from "./AbstractCoverageMeasure";

/**
 * Measures code coverage of test executions
 */
export class TypescriptCoverageMeasure extends AbstractCoverageMeasure {
  protected _coverageData: CoverageMapData = emptyCoverageMapData([]); // coverage data maintained by instrumented code
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
    let sourceMap: RawSourceMap | undefined;

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
   * Note: At this stage we are working with the raw JS source
   * maps, which we will map to TS at the end of the run.
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

    // Snapshot the raw current coverage data. A shallow clone would share
    // the `s`, `f`, and `b` counters with the instrumented code, which
    // mutates them during the next test and zeroes them in
    // `onBeforeNextTestExecution`. Anything retaining those objects --
    // this measurement, and the global map on its first merge -- would
    // otherwise be rewritten or emptied after the fact.
    const currentCoverageData = this._snapshot();

    // Merge the current coverage into root predecessor
    const pred =
      "tick" in input.source && input.source.tick !== undefined
        ? this._history[input.source.tick]
        : undefined;
    let accumBefore = 0;
    let accumAfter = 0;
    let nextPred = pred;
    while (nextPred) {
      if (!nextPred.pred) {
        accumBefore = this._toNumber(nextPred.meas.coverageMeasure.accum);
        AbstractCoverageMeasure.better_merge(
          nextPred.meas.coverageMeasure.accum,
          currentCoverageData
        );
        accumAfter = this._toNumber(nextPred.meas.coverageMeasure.accum);
      }
      nextPred = nextPred.pred;
    }

    // Merge the current coverage into the global coverage map
    const globalBefore = this._toNumber(this._globalCoverageMap);
    AbstractCoverageMeasure.better_merge(
      this._globalCoverageMap,
      currentCoverageData
    );

    // Build the measurement object
    const meas = {
      ...measure,
      name: this.name,
      coverageMeasure: {
        current: createCoverageMap(currentCoverageData),
        globalDelta: this._toNumber(this._globalCoverageMap) - globalBefore,
        // Python version does not have _snapshot, so this is to keep consistency with Python
        accum: AbstractCoverageMeasure.better_merge(
          createCoverageMap({}),
          currentCoverageData
        ),
        accumDelta: accumAfter - accumBefore,
      },
    };

    // Update measure history
    this._history[input.tick] = {
      input,
      pred,
      meas,
    };

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
          fileCoverage.b[bKey] = Array<number>(
            fileCoverage.b[bKey].length
          ).fill(0);
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
   * Fills in global code coverage statistics.
   *
   * @param `results` all test results
   */
  public onRunEnd(results: FuzzTestResults): void {
    results.stats.measures.CodeCoverageMeasure =
      async (): Promise<CodeCoverageMeasureStats> => {
        // We need to transform the global coverage map using the source maps
        // to get TypeScript locations (not the compiled JS locations).
        const tsCoverageMap = await this._sourceMapStore.transformCoverage(
          this._globalCoverageMap
        );
        const coverageSummary = tsCoverageMap.getCoverageSummary();
        const files: CodeCoverageFileStats[] = tsCoverageMap
          .files()
          .map((filePath) => {
            const fileSummary = tsCoverageMap
              .fileCoverageFor(filePath)
              .toSummary();
            const fileMap = JSONN.parse<FileCoverage>(
              JSONN.stringify(tsCoverageMap.fileCoverageFor(filePath))
            );
            // Omit functions and branches with no hits
            for (const k of Object.keys(fileMap.f)) {
              if (fileMap.f[k] === 0) delete fileMap.f[k];
            }
            for (const k of Object.keys(fileMap.b)) {
              if (Math.max(...fileMap.b[k]) === 0) delete fileMap.b[k];
            }
            for (const k of Object.keys(fileMap.statementMap)) {
              if (!(k in fileMap.s)) delete fileMap.statementMap[k];
            }
            for (const k of Object.keys(fileMap.branchMap)) {
              if (!(k in fileMap.b)) delete fileMap.branchMap[k];
            }

            return {
              path: normalizePathForKey(filePath),
              counters: {
                functionsTotal: fileSummary.functions.total,
                functionsCovered: fileSummary.functions.covered,
                statementsTotal: fileSummary.statements.total,
                statementsCovered: fileSummary.statements.covered,
                branchesTotal: fileSummary.branches.total,
                branchesCovered: fileSummary.branches.covered,
              },
              fileMap,
            };
          });

        return {
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
      };
  } // fn: onRunEnd

  /**
   * Returns a private copy of the current coverage data.
   *
   * Only the `s`, `f`, and `b` counters are copied: those are the objects
   * the instrumented code increments and `onBeforeNextTestExecution` zeroes,
   * so anything that outlives the current test needs its own. The location
   * maps are shared, because nothing mutates them in place -- istanbul's
   * `FileCoverage.merge` replaces them on its target rather than editing
   * them -- and copying them for every test costs far more than the
   * counters themselves.
   *
   * @returns a copy of the current coverage data that no other object holds
   */
  protected _snapshot(): CoverageMapData {
    const snapshot: CoverageMapData = {};
    for (const path of Object.keys(this._coverageData)) {
      const fileCoverage = this._coverageData[path];
      const b: FileCoverage["b"] = {};
      for (const bKey of Object.keys(fileCoverage.b)) {
        b[bKey] = [...fileCoverage.b[bKey]];
      }
      snapshot[path] = {
        ...fileCoverage,
        s: { ...fileCoverage.s },
        f: { ...fileCoverage.f },
        b,
      };
    }
    return snapshot;
  } // fn: _snapshot

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

export function emptyCoverageMapData(files: string[]): CoverageMapData {
  const cov: CoverageMapData = {};
  files.forEach((file) => {
    cov[file] = {
      path: file,
      statementMap: {},
      fnMap: {},
      branchMap: {},
      s: {},
      f: {},
      b: {},
    };
  });
  return cov;
}
