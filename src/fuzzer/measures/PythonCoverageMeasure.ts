import {
  CoverageMap,
  CoverageMapData,
  createCoverageMap,
  FileCoverage,
} from "istanbul-lib-coverage";
import { FuzzTestResult, FuzzTestResults, InputAndSource } from "../Fuzzer";
import { PythonRunner } from "../runners/PythonRunner";
import { AbstractRunner } from "../runners/AbstractRunner";
import * as JSON5 from "json5";
import { normalizePathForKey } from "../Util";
import {
  AbstractCoverageMeasure,
  CodeCoverageFileStats,
  CodeCoverageMeasureStats,
  CoverageMeasurement,
  CoverageMeasurementNode,
} from "./AbstractCoverageMeasure";

/**
 * End column for a synthesized statement location. coverage.py reports
 * coverage by line, not by column, so each executable line is treated as a
 * statement spanning the entire line. Consumers (e.g., the coverage heatmap)
 * clamp this to the line's actual end; a zero-width span would render nothing.
 */
const END_OF_LINE_COLUMN = Number.MAX_SAFE_INTEGER;

export class PythonCoverageMeasure extends AbstractCoverageMeasure {
  protected _runner?: PythonRunner;
  protected _globalCoverageMap = createCoverageMap({});
  protected _history: CoverageMeasurementNode[] = []; // measurement history

  /**
   * Connects this measure to the run's Python runner, which is the source of
   * the coverage data reported by the host process.
   *
   * @param `runner` the test runner for this run
   */
  public onRunStart(runner: AbstractRunner): void {
    if (!(runner instanceof PythonRunner)) {
      throw new Error(
        `${this.name} requires a PythonRunner, but received a ${runner.constructor.name}`
      );
    }
    this._runner = runner;

    // Reset per-run state so a re-run does not accumulate coverage from the
    // previous run.
    this._globalCoverageMap = createCoverageMap({});
    this._history = [];
  } // fn: onRunStart

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

    // Sanity check that we have the runner and its coverage info
    if (this._runner === undefined || !this._runner.coverageInfo) {
      throw new Error("Coverage measure not connected to runner");
    }

    // The Python runner reports coverage as line numbers: the set of
    // executable lines (`executable`) and the subset executed by the most
    // recent call (`lines`). Translate that into an istanbul CoverageMapData
    // (statements only) so we can reuse istanbul's merge/summary machinery
    // and stay compatible with the CoverageMeasurement shape.
    const info = this._runner.coverageInfo;
    const coveredLines = new Set(info.lines ?? []);
    const statementMap: Record<
      string,
      {
        start: { line: number; column: number };
        end: { line: number; column: number };
      }
    > = {};
    const s: Record<string, number> = {};
    info.executable.forEach((line, i) => {
      const key = String(i);
      statementMap[key] = {
        start: { line, column: 0 },
        end: { line, column: END_OF_LINE_COLUMN },
      };
      s[key] = coveredLines.has(line) ? 1 : 0;
    });
    const currentCoverageData: CoverageMapData = {
      [info.file]: {
        path: info.file,
        statementMap,
        fnMap: {},
        branchMap: {},
        s,
        f: {},
        b: {},
      },
    };

    // Number of covered statements (= executed executable lines) in a map
    const covered = (m: CoverageMap): number =>
      m.getCoverageSummary().statements.covered;

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
        accumBefore = covered(nextPred.meas.coverageMeasure.accum);
        nextPred.meas.coverageMeasure.accum.merge(currentCoverageData);
        accumAfter = covered(nextPred.meas.coverageMeasure.accum);
      }
      nextPred = nextPred.pred;
    }

    // Merge the current coverage into the global coverage map
    const globalBefore = covered(this._globalCoverageMap);
    this._globalCoverageMap.merge(currentCoverageData);

    // Build the measurement object
    const meas = {
      ...measure,
      name: this.name,
      coverageMeasure: {
        current: createCoverageMap(currentCoverageData),
        globalDelta: covered(this._globalCoverageMap) - globalBefore,
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

    return meas;
  } // fn: measure

  public onRunEnd(results: FuzzTestResults): void {
    results.stats.measures.CodeCoverageMeasure =
      async (): Promise<CodeCoverageMeasureStats> => {
        // Report the coverage accumulated across the entire run. Note that
        // `runner.coverageInfo` holds only the *most recent* call's lines, so
        // it cannot be used here.
        const pyCoverageMap = this._globalCoverageMap;
        const coverageSummary = pyCoverageMap.getCoverageSummary();
        const files: CodeCoverageFileStats[] = pyCoverageMap
          .files()
          .map((filePath) => {
            const fileSummary = pyCoverageMap
              .fileCoverageFor(filePath)
              .toSummary();
            const fileMap = JSON5.parse<FileCoverage>(
              JSON5.stringify(pyCoverageMap.fileCoverageFor(filePath))
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
  }

  /**
   * Calculates a numeric value representing the test execution's progress
   *
   * @param `a` code coverage measurement
   * @returns a numeric value representing the progress of the test execution
   */
  public delta(a: CoverageMeasurement): number {
    return a.coverageMeasure.globalDelta * 100 + a.coverageMeasure.accumDelta; // !!!!!!!
  } // fn: delta


  public hasCoverage(tick: number): boolean {
    return !!this._history[tick];
  }
  public getCoverage(tick: number): CoverageMeasurement {
    if (this.hasCoverage(tick)) {
      return this._history[tick].meas; // rep leak !!!!!!!
    }
    throw new Error(`No coverahe data for "${tick}"`);
  }
}
