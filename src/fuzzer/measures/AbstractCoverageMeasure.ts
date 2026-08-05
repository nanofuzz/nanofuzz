import {
  CoverageMap,
  CoverageMapData,
  FileCoverage,
} from "istanbul-lib-coverage";
import { InputAndSource } from "../Types";
import { AbstractMeasure, BaseMeasurement } from "./AbstractMeasure";

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
  public abstract hasCoverage(tick: number) : boolean;

  /**
   * Returns the coverage measurement for `tick`
   *
   * @param `tick` input tick
   * @returns the coverage measure for `tick`
   */
  public abstract getCoverage(tick: number): CoverageMeasurement;
}


/**
 * Ensures `map` owns a coverage entry for every file in `data`.
 *
 * `CoverageMap.merge` adopts the caller's data object by reference the first
 * time it sees a path, and only stops aliasing it on the *next* merge for that
 * path. A measurement whose data was adopted this way shares its counters with
 * `map`: merging a descendant's coverage into that measurement's `accum` then
 * silently adds coverage to `map` as well, and the `globalDelta` computed
 * against `map` under-reports -- a child of the first measured input reports
 * no progress no matter what it covered. Seeding an empty entry first keeps
 * every merge on the non-adopting path.
 *
 * Empty entries contribute nothing to any summary, so seeding does not change
 * what `map` reports.
 *
 * @param `map` the map about to be merged into
 * @param `data` the coverage data that will be merged
 */
export function ownCoverageEntries(
  map: CoverageMap,
  data: CoverageMapData
): void {
  const owned = new Set(map.files());
  for (const path of Object.keys(data)) {
    if (!owned.has(path)) {
      map.addFileCoverage(path);
    }
  }
} // fn: ownCoverageEntries

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