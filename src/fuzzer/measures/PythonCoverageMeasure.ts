import {
  CoverageMap,
  CoverageMapData,
  createCoverageMap,
  createFileCoverage,
  FileCoverage,
  FileCoverageData,
  Range,
} from "istanbul-lib-coverage";
import { FuzzTestResult, FuzzTestResults, InputAndSource } from "../Fuzzer";
import { FullCoverage, PythonRunner } from "../runners/python/PythonRunner";
import { AbstractRunner, Arc } from "../runners/AbstractRunner";
import { normalizePathForKey } from "../Util";
import {
  AbstractCoverageMeasure,
  CodeCoverageFileStats,
  CodeCoverageMeasureStats,
  CoverageMeasurement,
  CoverageMeasurementNode,
} from "./AbstractCoverageMeasure";

/**
 * A coverage measure implementation that collects and
 * processes coverage.py code coverage for Python
 * and translates it into istanbul format for NaNofuzz.
 */
export class PythonCoverageMeasure extends AbstractCoverageMeasure {
  protected _runners: PythonRunner[] = [];
  protected _coverageData: CoverageMap = createCoverageMap({});
  protected _globalCoverageMap = createCoverageMap({});
  protected _history = new Map<number, CoverageMeasurementNode>(); // measurement history
  protected _lastNode: CoverageMeasurementNode | undefined = undefined;
  protected _fileIndices = new Map<string, FileIndex>();
  protected _executedFilesThisTest = new Set<string>();

  /**
   * Connects this measure to the run's Python runners, which are the source of
   * the coverage data reported by the host processes.
   *
   * @param `runners` test runners for this run
   */
  public override onRunStart(runners: AbstractRunner[] | AbstractRunner): void {
    const runnerList = Array.isArray(runners) ? runners : [runners];
    this._runners = [];
    this._coverageData = createCoverageMap({});
    this._fileIndices.clear();
    this._executedFilesThisTest.clear();

    runnerList.forEach((r) => {
      if (r instanceof PythonRunner) {
        this._runners.push(r);
        if (r.coverageInfo) {
          this.recordHits(r.coverageInfo);
        }
        r.onCoverage((covInfo) => {
          if (isFullCoverage(covInfo)) {
            this.recordHits(covInfo);
          }
        });
      }
    });

    // Reset per-run state so a re-run does not accumulate coverage from the
    // previous run.
    this._globalCoverageMap = createCoverageMap({});
    if (this._coverageData.files().length > 0) {
      AbstractCoverageMeasure.merge(
        this._globalCoverageMap,
        this._coverageData
      );
      this._coverageData = createCoverageMap(this._snapshotZero());
    }
    this._history.clear();
    this._lastNode = undefined;
  } // fn: onRunStart

  /**
   * Records code coverage hits for the given Python coverage information.
   *
   * @param covinfo Python coverage info
   */
  public recordHits(covinfo: FullCoverage): void {
    for (const [filename, fileCov] of Object.entries(covinfo)) {
      let index = this._fileIndices.get(filename);
      if (!index) {
        index = buildFileIndex(filename, fileCov);
        this._fileIndices.set(filename, index);
      }

      let fileCoverage: FileCoverage;
      try {
        fileCoverage = this._coverageData.fileCoverageFor(filename);
      } catch {
        fileCoverage = createFileCoverage(
          AbstractCoverageMeasure.file_snapshot(index.templateData)
        );
        this._coverageData.addFileCoverage(fileCoverage);
      }

      const lines = fileCov.lines;
      const arcs = fileCov.arcs;
      if ((lines && lines.length > 0) || (arcs && arcs.length > 0)) {
        applyHitsToFileCoverage(
          fileCoverage.data,
          index,
          lines ?? [],
          arcs ?? []
        );
        this._executedFilesThisTest.add(filename);
      }
    }
  } // fn: recordHits

  /**
   * Zeroes out the code coverage data prior to each test execution so that
   * we record incremental code coverage for each test execution.
   */
  public override onBeforeNextTestExecution(): void {
    if (this._coverageData) {
      for (const fileKey of this._executedFilesThisTest) {
        try {
          const fileCoverage = this._coverageData.fileCoverageFor(fileKey);
          if (fileCoverage) {
            if (fileCoverage.s) {
              for (const k of Object.keys(fileCoverage.s)) {
                fileCoverage.s[k] = 0;
              }
            }
            if (fileCoverage.f) {
              for (const k of Object.keys(fileCoverage.f)) {
                fileCoverage.f[k] = 0;
              }
            }
            if (fileCoverage.b) {
              for (const k of Object.keys(fileCoverage.b)) {
                const arr = fileCoverage.b[k];
                if (arr) {
                  for (let i = 0; i < arr.length; i++) {
                    arr[i] = 0;
                  }
                }
              }
            }
          }
        } catch {
          // File not in coverage map, ignore
        }
      }
      this._executedFilesThisTest.clear();
    }
  } // fn: onBeforeNextTestExecution

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
    if (this._runners.length === 0) {
      throw new Error("Coverage measure not connected to runner");
    }

    // Translate the runner's line/arc coverage into an istanbul
    // CoverageMapData so we can reuse istanbul's merge and summary machinery
    // and stay compatible with the CoverageMeasurement shape.
    if (this._coverageData.files().length === 0) {
      for (const r of this._runners) {
        if (r.coverageInfo) {
          this.recordHits(r.coverageInfo);
        }
      }
    }

    const currentCoverageData: CoverageMapData = {};
    for (const [fileKey, index] of this._fileIndices.entries()) {
      if (this._executedFilesThisTest.has(fileKey)) {
        try {
          const fc = this._coverageData.fileCoverageFor(fileKey);
          if (fc) {
            currentCoverageData[fileKey] =
              AbstractCoverageMeasure.file_snapshot(fc);
          } else {
            currentCoverageData[fileKey] = index.templateData;
          }
        } catch {
          currentCoverageData[fileKey] = index.templateData;
        }
      } else {
        currentCoverageData[fileKey] = index.templateData;
      }
    }

    // Merge the current coverage into root predecessor
    const pred =
      "tick" in input.source && input.source.tick !== undefined
        ? this._history.get(input.source.tick)
        : undefined;
    if (pred) {
      pred.refCount++;
    }

    let accumDelta = 0;
    let nextPred = pred;
    while (nextPred) {
      if (!nextPred.pred) {
        accumDelta = AbstractCoverageMeasure.merge(
          nextPred.meas.coverageMeasure.accum,
          currentCoverageData,
          this._executedFilesThisTest
        );
      }
      nextPred = nextPred.pred;
    }

    // Merge the current coverage into the global coverage map

    // Build the measurement object
    const meas = {
      ...measure,
      name: this.name,
      coverageMeasure: {
        current: createCoverageMap(currentCoverageData),
        globalDelta: AbstractCoverageMeasure.merge(
          this._globalCoverageMap,
          currentCoverageData,
          this._executedFilesThisTest
        ),
        accum: createCoverageMap(currentCoverageData),
        accumDelta,
      },
    };

    // Update measure history
    const node: CoverageMeasurementNode = {
      input,
      pred,
      meas,
      refCount: 0,
    };

    // Prune previous node if it was unreferenced and produced no coverage progress
    if (this._lastNode) {
      if (
        this._lastNode.refCount === 0 &&
        this._lastNode.meas.coverageMeasure.globalDelta === 0 &&
        this._lastNode.meas.coverageMeasure.accumDelta === 0
      ) {
        if (this._lastNode.pred) {
          this._lastNode.pred.refCount--;
        }
        this._history.delete(this._lastNode.input.tick);
      }
    }

    this._history.set(input.tick, node);
    this._lastNode = node;

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
      let index = this._fileIndices.get(filename);
      if (!index) {
        index = buildFileIndex(filename, fileCov);
        this._fileIndices.set(filename, index);
      }
      const fileData = AbstractCoverageMeasure.file_snapshot(
        index.templateData
      );
      const lines = fileCov.lines ?? [];
      const arcs = fileCov.arcs ?? [];
      applyHitsToFileCoverage(fileData, index, lines, arcs);
      ret[filename] = fileData;
    }
    return ret;
  } // fn: _toCoverageMapData

  /**
   * Called when the test run ends.
   *
   * @param results The results of the test run.
   */
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
            const fileMap = createFileCoverage(
              structuredClone(pyCoverageMap.fileCoverageFor(filePath).data)
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
   * Calculates a numeric value representing the test execution's progress
   *
   * @param `a` code coverage measurement
   * @returns a numeric value representing the progress of the test execution
   */
  public delta(a: CoverageMeasurement): number {
    return Math.max(
      0,
      a.coverageMeasure.globalDelta * 100 + a.coverageMeasure.accumDelta
    );
  } // fn: delta

  /**
   * Checks if coverage data exists for the given tick.
   *
   * @param tick The tick to check for coverage data.
   * @returns True if coverage data exists for the specified tick, false otherwise.
   */
  public hasCoverage(tick: number): boolean {
    return this._history.has(tick);
  } // fn: hasCoverage

  /**
   * Retrieves the coverage measurement for the given tick.
   *
   * @param tick The tick for which to retrieve coverage data.
   * @returns The coverage measurement for the specified tick.
   */
  public getCoverage(tick: number): CoverageMeasurement {
    const node = this._history.get(tick);
    if (node) {
      return node.meas; // rep leak !!!!!!!
    }
    throw new Error(`No coverahe data for "${tick}"`);
  } // fn: getCoverage

  /**
   * Returns a private copy of the current coverage data.
   */
  protected _snapshot(): CoverageMapData {
    const snapshot: CoverageMapData = {};
    for (const fileKey of this._coverageData.files()) {
      snapshot[fileKey] = AbstractCoverageMeasure.file_snapshot(
        this._coverageData.fileCoverageFor(fileKey)
      );
    }
    return snapshot;
  } // fn: _snapshot

  /**
   * Returns a copy of the current coverage data with all counters zeroed.
   *
   * @returns a zeroed copy of the current coverage structure
   */
  protected _snapshotZero(): CoverageMapData {
    const snapshot: CoverageMapData = {};
    for (const fileKey of this._coverageData.files()) {
      const fc = AbstractCoverageMeasure.file_snapshot(
        this._coverageData.fileCoverageFor(fileKey)
      );
      for (const sKey of Object.keys(fc.s)) {
        fc.s[sKey] = 0;
      }
      for (const fKey of Object.keys(fc.f)) {
        fc.f[fKey] = 0;
      }
      for (const bKey of Object.keys(fc.b)) {
        fc.b[bKey] = Array.isArray(fc.b[bKey])
          ? Array(fc.b[bKey].length).fill(0)
          : [];
      }
      snapshot[fileKey] = fc;
    }
    return snapshot;
  } // fn: _snapshotZero
} // class: PythonCoverageMeasure

/**
 * Checks if the given value is a FullCoverage object.
 *
 * @param val The value to check.
 * @returns True if the value is a FullCoverage object, false otherwise.
 */
function isFullCoverage(val: unknown): val is FullCoverage {
  return typeof val === "object" && val !== null;
} // fn: isFullCoverage

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
 * Builds a pre-indexed static file coverage index for `filename` from its
 * static coverage information (`fileCov`).
 *
 * @param filename source file path
 * @param fileCov static coverage info for the file
 * @returns pre-indexed FileIndex structure
 */
function buildFileIndex(
  filename: string,
  fileCov: import("../runners/AbstractRunner").CoverageInfo
): FileIndex {
  const statementMap: FileCoverageData["statementMap"] = {};
  const s: FileCoverageData["s"] = {};
  const lineStmtMap = new Map<number, number>();

  (fileCov.executable ?? []).forEach((line, i) => {
    statementMap[i] = wholeLine(line);
    s[i] = 0;
    lineStmtMap.set(line, i);
  });

  const fnMap: FileCoverageData["fnMap"] = {};
  const f: FileCoverageData["f"] = {};
  const fnLinesMap: { fnIdx: number; lines: Set<number> }[] = [];

  (fileCov.functions ?? []).forEach((fn, i) => {
    fnMap[i] = {
      name: fn.name,
      decl: wholeLine(fn.declLine),
      loc: {
        start: { line: fn.startLine, column: 0 },
        end: { line: fn.endLine, column: END_OF_LINE_COLUMN },
      },
      line: fn.declLine,
    };
    f[i] = 0;
    fnLinesMap.push({ fnIdx: i, lines: new Set(fn.lines) });
  });

  const branchMap: FileCoverageData["branchMap"] = {};
  const b: FileCoverageData["b"] = {};
  const arcBranchMap = new Map<string, { bIdx: number; eIdx: number }>();

  (fileCov.branches ?? []).forEach((branch, i) => {
    branchMap[i] = {
      loc: wholeLine(branch.line),
      type: "branch",
      locations: branch.exits.map((exit) => wholeLine(exit.line)),
      line: branch.line,
    };
    b[i] = Array(branch.exits.length).fill(0);
    branch.exits.forEach((exit, j) => {
      arcBranchMap.set(`${branch.line},${exit.dest}`, { bIdx: i, eIdx: j });
    });
  });

  const templateData: FileCoverageData = {
    path: filename,
    statementMap,
    fnMap,
    branchMap,
    s,
    f,
    b,
  };

  return {
    filename,
    lineStmtMap,
    fnLinesMap,
    arcBranchMap,
    templateData,
  };
} // fn: buildFileIndex

/**
 * Applies executed line numbers and arc transitions directly into `fileCoverage`
 * using the pre-indexed `FileIndex`.
 *
 * @param fileCoverage file coverage target object
 * @param index pre-indexed static structure for the file
 * @param lines list of executed line numbers
 * @param arcs list of taken branch arcs
 */
function applyHitsToFileCoverage(
  fileCoverage: FileCoverageData,
  index: FileIndex,
  lines: number[],
  arcs: Arc[]
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sIdx = index.lineStmtMap.get(line);
    if (sIdx !== undefined) {
      fileCoverage.s[sIdx] = 1;
    }
  }

  if (lines.length > 0) {
    for (let i = 0; i < index.fnLinesMap.length; i++) {
      const fnInfo = index.fnLinesMap[i];
      for (let j = 0; j < lines.length; j++) {
        if (fnInfo.lines.has(lines[j])) {
          fileCoverage.f[fnInfo.fnIdx] = 1;
          break;
        }
      }
    }
  }

  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i];
    const key = `${arc[0]},${arc[1]}`;
    const target = index.arcBranchMap.get(key);
    if (target !== undefined) {
      fileCoverage.b[target.bIdx][target.eIdx] = 1;
    }
  }
} // fn: applyHitsToFileCoverage

/**
 * Pre-indexed static coverage structure for a file, allowing fast O(1)
 * mapping from line numbers and arc transitions to statement, function, and branch indices.
 */
type FileIndex = {
  filename: string;
  lineStmtMap: Map<number, number>;
  fnLinesMap: { fnIdx: number; lines: Set<number> }[];
  arcBranchMap: Map<string, { bIdx: number; eIdx: number }>;
  templateData: FileCoverageData;
}; // type: FileIndex
