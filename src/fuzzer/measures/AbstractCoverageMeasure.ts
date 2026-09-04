import {
  CoverageMap,
  CoverageMapData,
  createCoverageMap,
  createFileCoverage,
  FileCoverage,
  FileCoverageData,
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
  public abstract hasCoverage(tick: number): boolean;

  /**
   * Returns the coverage measurement for `tick`
   *
   * @param `tick` input tick
   * @returns the coverage measure for `tick`
   */
  public abstract getCoverage(tick: number): CoverageMeasurement;

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
  }

  protected static better_merge(
    accum: CoverageMap,
    new_cov: CoverageMap | CoverageMapData
  ): CoverageMap {
    const other = createCoverageMap(new_cov);
    const existed = new Set(accum.files());
    Object.values(other.data).forEach((fc) => {
      if (existed.has(fc.path)) {
        accum.addFileCoverage(fc);
      } else {
        accum.addFileCoverage(AbstractCoverageMeasure.file_snapshot(fc));
      }
    });
    return accum;
  }
}

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
