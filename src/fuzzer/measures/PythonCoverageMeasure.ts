import {
  CoverageMap,
  CoverageMapData,
  createCoverageMap,
  FileCoverageData,
  FileCoverage,
  Range,
} from "istanbul-lib-coverage";
import { FuzzTestResult, FuzzTestResults, InputAndSource } from "../Fuzzer";
import { FullCoverage, PythonRunner } from "../runners/PythonRunner";
import { AbstractRunner, Arc } from "../runners/AbstractRunner";
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

/**
 * Returns the range covering all of `line`. coverage.py reports coverage by
 * line, so every synthesized location spans a whole line.
 */
function wholeLine(line: number): Range {
  return {
    start: { line, column: 0 },
    end: { line, column: END_OF_LINE_COLUMN },
  };
} // fn: wholeLine

/**
 * Returns a lookup key for `arc`, so that arcs can be compared by value.
 */
function arcKey(arc: Arc): string {
  return `${arc[0]},${arc[1]}`;
} // fn: arcKey

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
    if (this._runner === undefined) {
      throw new Error("Coverage measure not connected to runner");
    }

    // Translate the runner's line/arc coverage into an istanbul
    // CoverageMapData so we can reuse istanbul's merge and summary machinery
    // and stay compatible with the CoverageMeasurement shape.
    const currentCoverageData = this._runner.coverageInfo ? this._toCoverageMapData(
      this._runner.coverageInfo
    ) : {};

    // Total coverage in a map, summing statements, branches, and functions --
    // matching CoverageMeasure, so that newly-covered branches and functions
    // register as progress just as newly-covered lines do.
    const covered = (m: CoverageMap): number => {
      const summary = m.getCoverageSummary();
      return (
        summary.statements.covered +
        summary.branches.covered +
        summary.functions.covered
      );
    };

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
        AbstractCoverageMeasure.better_merge(nextPred.meas.coverageMeasure.accum, currentCoverageData);
        accumAfter = covered(nextPred.meas.coverageMeasure.accum);
      }
      nextPred = nextPred.pred;
    }

    // Merge the current coverage into the global coverage map
    const globalBefore = covered(this._globalCoverageMap);
    AbstractCoverageMeasure.better_merge(this._globalCoverageMap, currentCoverageData);

    // Build the measurement object
    const meas = {
      ...measure,
      name: this.name,
      coverageMeasure: {
        current: createCoverageMap(currentCoverageData),
        globalDelta: covered(this._globalCoverageMap) - globalBefore,
        accum: AbstractCoverageMeasure.better_merge(createCoverageMap({}), currentCoverageData),
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
   * Translates the runner's coverage into istanbul's CoverageMapData.
   *
   * coverage.py measures by line and by arc (line-to-line transition), so
   * every location is synthesized as a whole-line span: `column: 0` to
   * `END_OF_LINE_COLUMN`. Hit counts are 0 or 1 rather than true counts,
   * because coverage.py records which lines and arcs were reached, not how
   * many times.
   *
   * @param `info` coverage reported by the runner
   * @returns equivalent istanbul coverage data
   */
  protected _toCoverageMapData(covinfo: FullCoverage): CoverageMapData {
    const ret: CoverageMapData = {};
    for (const [filename, fileCov] of Object.entries(covinfo)) {
      const coveredLines = new Set(fileCov.lines ?? []);
      // Arcs are matched by value, so key them for lookup
      const takenArcs = new Set((fileCov.arcs ?? []).map(arcKey));

      // Statements: one per executable line
      const statementMap: FileCoverageData["statementMap"] = {};
      const s: FileCoverageData["s"] = {};
      fileCov.executable.forEach((line, i) => {
        statementMap[i] = wholeLine(line);
        s[i] = coveredLines.has(line) ? 1 : 0;
      });

      // Functions: covered when any of their own lines executed
      const fnMap: FileCoverageData["fnMap"] = {};
      const f: FileCoverageData["f"] = {};
      fileCov.functions.forEach((fn, i) => {
        fnMap[i] = {
          name: fn.name,
          decl: wholeLine(fn.declLine),
          loc: {
            start: { line: fn.startLine, column: 0 },
            end: { line: fn.endLine, column: END_OF_LINE_COLUMN },
          },
          line: fn.declLine,
        };
        f[i] = fn.lines.some((line) => coveredLines.has(line)) ? 1 : 0;
      });

      // Branches: one hit counter per exit, set when that exit's arc was taken
      const branchMap: FileCoverageData["branchMap"] = {};
      const b: FileCoverageData["b"] = {};
      fileCov.branches.forEach((branch, i) => {
        branchMap[i] = {
          loc: wholeLine(branch.line),
          // Deliberately not "if": the coverage heatmap skips branches of that
          // type to work around a bug in istanbul's if-branch locations, which
          // does not apply to locations we compute ourselves from arcs.
          type: "branch",
          locations: branch.exits.map((exit) => wholeLine(exit.line)),
          line: branch.line,
        };
        b[i] = branch.exits.map((exit) =>
          takenArcs.has(arcKey([branch.line, exit.dest])) ? 1 : 0
        );
      });
      

      ret[filename] = {
          path: filename,
          statementMap,
          fnMap,
          branchMap,
          s,
          f,
          b,
      }
    }
    return ret;
  } // fn: _toCoverageMapData

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
    throw new Error(`No coverage data for "${tick}"`);
  }
}
