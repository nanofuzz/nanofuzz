import {
  CoverageMap,
  CoverageMapData,
  createCoverageMap,
  createFileCoverage,
  FileCoverage,
  FileCoverageData,
} from "istanbul-lib-coverage";
import { InputAndSource } from "../Types";
import { normalizePathForKey } from "../Util";
import { AbstractMeasure, BaseMeasurement } from "./AbstractMeasure";

/**
 * Abstract base class for code coverage measures
 */
export abstract class AbstractCoverageMeasure extends AbstractMeasure {
  /**
   * Returns the measure's name.
   *
   * All coverage measures report the same name because they are mutually
   * exclusive: `MeasureFactory` selects one based on the target language, so
   * at most one is active per run. Sharing a name lets them share a single
   * options key and UI toggle, rather than requiring the options schema and
   * every UI control to enumerate one entry per language.
   *
   * Note that this deliberately does not derive from `constructor.name`: the
   * name is a persisted options key, so it must not change when a concrete
   * measure class is renamed.
   */
  public get name(): string {
    return "CoverageMeasure";
  } // property: get name

  /**
   * Returns whether coverage data exists for a particular tick
   *
   * @param `tick` input tick
   * @returns true if coverage data exists for `tick`, false otherwise
   */
  public abstract hasCoverage(tick: number): boolean;

  /**
   * Returns the coverage measurement for `tick`
   *
   * @param `tick` input tick
   * @returns the coverage measure for `tick`
   */
  public abstract getCoverage(tick: number): CoverageMeasurement;

  /**
   * Records raw coverage hits produced by a runner.
   *
   * @param coverageData raw coverage data produced by the runner
   */
  public abstract recordHits(coverageData: unknown): void;

  /**
   * Generates CodeCoverageMeasureStats representing coverage accumulated across the run so far.
   */
  public abstract getCoverageStats(): Promise<CodeCoverageMeasureStats>;

  /**
   * Returns uncovered and partially covered line numbers grouped by normalized file path.
   */
  public async getUncoveredLines(): Promise<UncoveredCoverageInfo> {
    const stats = await this.getCoverageStats();
    return extractUncoveredLines(stats);
  } // fn: getUncoveredLines()

  protected static file_snapshot(data: FileCoverageData): FileCoverageData {
    // A `FileCoverage` instance is assignable to `FileCoverageData`, and
    // `CoverageMap.data` holds instances, so this is routinely called with
    // one. It keeps `path` and the location maps behind prototype getters --
    // its only own property is `data` -- so spreading the instance directly
    // would produce `{ data, s, f, b }` and `addFileCoverage` would reject it.
    // `createFileCoverage` returns the plain object either shape wraps.
    const fileData = createFileCoverage(data).data;

    const b: FileCoverageData["b"] = {};
    for (const bKey of Object.keys(fileData.b)) {
      b[bKey] = [...fileData.b[bKey]];
    }
    return { ...fileData, s: { ...fileData.s }, f: { ...fileData.f }, b };
  } // fn: file_snapshot

  /**
   * Performs an in-place merge of statement, function, and branch coverage
   * from `new_cov` into `accum` and calculates the number of newly covered elements (delta).
   *
   * @param accum target coverage map to merge into
   * @param new_cov incoming coverage map or coverage map data
   * @param activeFiles optional set or array of file paths to limit merging to
   * @returns count of newly covered statements, functions, and branches (delta)
   */
  protected static merge(
    accum: CoverageMap,
    new_cov: CoverageMap | CoverageMapData,
    activeFiles?: Set<string> | string[]
  ): number {
    const other = isCoverageMap(new_cov) ? new_cov : createCoverageMap(new_cov);
    let delta = 0;

    const existingNormPaths = new Map<string, string>();
    for (const file of accum.files()) {
      existingNormPaths.set(normalizePathForKey(file), file);
    }

    const filesToMerge = activeFiles ? Array.from(activeFiles) : other.files();

    for (const filePath of filesToMerge) {
      let fc: FileCoverage;
      try {
        fc = other.fileCoverageFor(filePath);
      } catch {
        continue;
      }

      const normPath = normalizePathForKey(fc.path);
      const existingPath = existingNormPaths.get(normPath);

      if (existingPath) {
        const targetFc = accum.fileCoverageFor(existingPath);
        // Merge statements
        if (fc.s && targetFc.s) {
          for (const k of Object.keys(fc.s)) {
            const val = fc.s[k];
            if (val > 0) {
              if (!targetFc.s[k]) {
                targetFc.s[k] = val;
                delta++;
              } else {
                targetFc.s[k] += val;
              }
            }
          }
        }
        // Merge functions
        if (fc.f && targetFc.f) {
          for (const k of Object.keys(fc.f)) {
            const val = fc.f[k];
            if (val > 0) {
              if (!targetFc.f[k]) {
                targetFc.f[k] = val;
                delta++;
              } else {
                targetFc.f[k] += val;
              }
            }
          }
        }
        // Merge branches
        if (fc.b && targetFc.b) {
          for (const k of Object.keys(fc.b)) {
            const srcArr = fc.b[k];
            const targetArr = targetFc.b[k];
            if (srcArr && targetArr) {
              for (let j = 0; j < srcArr.length; j++) {
                const val = srcArr[j];
                if (val > 0) {
                  if (!targetArr[j]) {
                    targetArr[j] = val;
                    delta++;
                  } else {
                    targetArr[j] += val;
                  }
                }
              }
            }
          }
        }
      } else {
        // New file not yet in accum
        const snapshot = AbstractCoverageMeasure.file_snapshot(fc);
        accum.addFileCoverage(snapshot);
        existingNormPaths.set(normPath, fc.path);

        if (fc.s) {
          for (const k of Object.keys(fc.s)) {
            if (fc.s[k] > 0) delta++;
          }
        }
        if (fc.f) {
          for (const k of Object.keys(fc.f)) {
            if (fc.f[k] > 0) delta++;
          }
        }
        if (fc.b) {
          for (const k of Object.keys(fc.b)) {
            if (fc.b[k]) {
              for (let j = 0; j < fc.b[k].length; j++) {
                if (fc.b[k][j] > 0) delta++;
              }
            }
          }
        }
      }
    }

    return delta;
  } // fn: mergeCoverageIntoAccum
} // class: AbstractCoverageMeasure

/**
 * Type guard function that returns true if `obj` is a CoverageMap object.
 *
 * @param obj object or coverage data to test
 * @returns true if `obj` is a CoverageMap instance
 */
function isCoverageMap(obj: CoverageMap | CoverageMapData): obj is CoverageMap {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "files" in obj &&
    typeof obj.files === "function" &&
    "fileCoverageFor" in obj &&
    typeof obj.fileCoverageFor === "function"
  );
} // fn: isCoverageMap

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
export type CoverageMeasurementNode = {
  input: InputAndSource;
  pred: CoverageMeasurementNode | undefined;
  meas: CoverageMeasurement;
  refCount: number;
};

type CodeCoverageCounters = {
  functionsTotal: number;
  functionsCovered: number;
  statementsTotal: number;
  statementsCovered: number;
  branchesTotal: number;
  branchesCovered: number;
};

/**
 * Per-file Code Coverage Statistics. Includes line-level hit counts, which necessitates
 * per-file stats since line numbers are file-specific.
 */
export type CodeCoverageFileStats = {
  path: string;
  counters: CodeCoverageCounters;
  fileMap: FileCoverage;
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

export { FileCoverage } from "istanbul-lib-coverage";

/**
 * Summary of uncovered and partially covered lines across files.
 */
export type UncoveredCoverageInfo = {
  uncoveredLinesByFile: Record<string, number[]>;
  partiallyCoveredLinesByFile: Record<string, number[]>;
};

/**
 * Extracts uncovered and partially covered lines from CodeCoverageMeasureStats.
 */
export function extractUncoveredLines(
  covStats: CodeCoverageMeasureStats
): UncoveredCoverageInfo {
  const uncoveredLinesByFile: Record<string, number[]> = {};
  const partiallyCoveredLinesByFile: Record<string, number[]> = {};

  if (covStats.files) {
    for (const file of covStats.files) {
      const fileMap = file.fileMap;
      if (fileMap) {
        const lineStats: Record<
          number,
          { hitCount: number; zeroCount: number }
        > = {};

        if (fileMap.s && fileMap.statementMap) {
          for (const [key, hits] of Object.entries(fileMap.s)) {
            if (fileMap.statementMap[key]) {
              const startLine = fileMap.statementMap[key].start.line;
              if (!lineStats[startLine]) {
                lineStats[startLine] = { hitCount: 0, zeroCount: 0 };
              }
              if (hits > 0) {
                lineStats[startLine].hitCount++;
              } else {
                lineStats[startLine].zeroCount++;
              }
            }
          }
        }

        if (fileMap.b && fileMap.branchMap) {
          for (const [bKey, hitsArr] of Object.entries(fileMap.b)) {
            const bDef = fileMap.branchMap[bKey];
            if (bDef && bDef.locations && Array.isArray(hitsArr)) {
              for (let i = 0; i < bDef.locations.length; i++) {
                const loc = bDef.locations[i];
                if (loc && loc.start && typeof loc.start.line === "number") {
                  const startLine = loc.start.line;
                  if (!lineStats[startLine]) {
                    lineStats[startLine] = { hitCount: 0, zeroCount: 0 };
                  }
                  const armHits = hitsArr[i];
                  if (typeof armHits === "number" && armHits > 0) {
                    lineStats[startLine].hitCount++;
                  } else if (armHits === 0) {
                    lineStats[startLine].zeroCount++;
                  }
                }
              }
            }
          }
        }

        const uncoveredLines: number[] = [];
        const partiallyCoveredLines: number[] = [];

        for (const [lineStr, stats] of Object.entries(lineStats)) {
          const line = Number(lineStr);
          if (stats.zeroCount > 0) {
            if (stats.hitCount === 0) {
              uncoveredLines.push(line);
            } else {
              partiallyCoveredLines.push(line);
            }
          }
        }

        uncoveredLines.sort((a, b) => a - b);
        partiallyCoveredLines.sort((a, b) => a - b);

        const fileKey = normalizePathForKey(file.path);
        if (uncoveredLines.length > 0) {
          uncoveredLinesByFile[fileKey] = uncoveredLines;
        }
        if (partiallyCoveredLines.length > 0) {
          partiallyCoveredLinesByFile[fileKey] = partiallyCoveredLines;
        }
      }
    }
  }

  return { uncoveredLinesByFile, partiallyCoveredLinesByFile };
} // fn: extractUncoveredLines()

/**
 * Formats an array of line numbers into concise range strings (e.g. "1-3, 5, 8-10").
 */
export function formatLineRanges(lines: number[]): string {
  if (!lines || lines.length === 0) return "";
  const sorted = Array.from(new Set(lines)).sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    if (curr === prev + 1) {
      prev = curr;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = curr;
      prev = curr;
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(", ");
} // fn: formatLineRanges()
