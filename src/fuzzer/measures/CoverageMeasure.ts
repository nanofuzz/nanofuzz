import { AbstractMeasure } from "./AbstractMeasure";
import { createInstrumenter } from "istanbul-lib-instrument";
import {
  CoverageMap,
  CoverageMapData,
  createCoverageMap,
} from "istanbul-lib-coverage";
import { FuzzTestResult, VmGlobals } from "../Types";
import { FuzzTestResults } from "fuzzer/Fuzzer";
import { BaseMeasurement } from "./Types";
import * as JSON5 from "json5";
import { InputAndSource } from "fuzzer/generators/Types";

// !!!!!!
export class CoverageMeasure extends AbstractMeasure {
  private _coverageData?: CoverageMapData; // coverage data written to by instrumented code
  private _globalCoverageMap: CoverageMap = createCoverageMap({}); // Aggregate coverage
  private _history: CoverageMeasurement[] = [];

  // !!!!!!
  public onAfterCompile(jsSrc: string, jsFileName: string): string {
    return createInstrumenter({
      produceSourceMap: true,
      coverageGlobalScope: "global",
    }).instrumentSync(jsSrc, jsFileName);
  } // !!!!!!

  // !!!!!!
  public onAfterLoad(globals: VmGlobals): void {
    // Save the global context of the original module load because
    // that is where the instrumented code writes coverage data
    if (
      globals.__coverage__ !== null &&
      typeof globals.__coverage__ === "object"
    ) {
      this._coverageData = globals.__coverage__ as CoverageMapData;
    } else {
      throw new Error(
        "Unable to retrieve global.__coverage__ code coverage object"
      );
    }
  } // !!!!!!

  // !!!!!!
  public measure(
    input: InputAndSource,
    result: FuzzTestResult
  ): CoverageMeasurement {
    const measure = super.measure(input, result);

    if (this._coverageData === undefined) {
      throw new Error(
        "Unable to retrieve global.__coverage__ code coverage object"
      );
    }
    const coverageData = new ImmutableCoverageMapData(this._coverageData);

    // Build a coverage map from the coverage data
    const currentCoverageMap = createCoverageMap(coverageData.data);
    const current = this.toNumber(currentCoverageMap);

    // Add the coverage from this run to its predecessor's accumulated
    // coverage (if present)
    console.debug(JSON5.stringify(input)); // !!!!!!!!
    const pred =
      input.source.tick === undefined
        ? {}
        : this._history[input.source.tick].coverageMeasure.accum.data;
    const accumCoverageMap = createCoverageMap(pred);
    const accumBefore = this.toNumber(accumCoverageMap);
    accumCoverageMap.merge(coverageData.data);

    // Merge the coverage from this run into the global coverage map
    const globalBefore = this.toNumber(this._globalCoverageMap);
    this._globalCoverageMap.merge(coverageData.data);
    console.debug(
      `[${
        this.name
      }] total before: ${globalBefore} total after: ${this.toNumber(
        this._globalCoverageMap
      )} current: ${current}`
    ); // !!!!!!!

    // Update measure history
    this._history[input.tick] = {
      ...measure,
      name: this.name,
      coverageMeasure: {
        current: new ImmutableCoverageMapData(currentCoverageMap.data),
        global: new ImmutableCoverageMapData(this._globalCoverageMap.data),
        globalDelta: this.toNumber(this._globalCoverageMap) - globalBefore,
        accum: new ImmutableCoverageMapData(accumCoverageMap.data),
        accumDelta: this.toNumber(this._globalCoverageMap) - accumBefore,
      },
    };

    // Return the measurement
    return JSON5.parse(JSON5.stringify(this._history[input.tick]));
  } // !!!!!!

  // !!!!!!
  public onBeforeNextTestExecution(): void {
    super.onBeforeNextTestExecution();

    // Zero out the coverage data so that we know the incremental
    // coverage for just the present execution
    if (this._coverageData) {
      let fileKey: keyof typeof this._coverageData;
      for (fileKey in this._coverageData) {
        //delete this._coverageData[fileKey]; !!!!!!!!!
        const fileCoverage = this._coverageData[fileKey];
        let bKey: keyof typeof fileCoverage.b;
        for (bKey in fileCoverage.b) {
          fileCoverage.b[bKey] = [0, 0];
        }
        let sKey: keyof typeof fileCoverage.s;
        for (sKey in fileCoverage.s) {
          fileCoverage.s[sKey] = 0;
        }
        let fKey: keyof typeof fileCoverage.f;
        for (fKey in fileCoverage.f) {
          fileCoverage.f[fKey] = 0;
        }
      }
    }
  } // !!!!!!

  // !!!!!!
  public onShutdown(results: FuzzTestResults): void {
    results.aggregateCoverageSummary =
      this._globalCoverageMap.getCoverageSummary(); // !!!!!!
    console.debug(
      `[${this.name}][${this._tick}] `,
      results.aggregateCoverageSummary
    ); // !!!!!!!
  } // !!!!!!

  // !!!!!!
  // return the progress measure,
  // which is total branches + statements + functions covered.
  private toNumber(m: CoverageMap): number {
    const summ = m.getCoverageSummary();
    return (
      summ.branches.covered + summ.statements.covered + summ.functions.covered
    );
  } // !!!!!!

  // !!!!!!
  public delta(a: CoverageMeasurement, b?: CoverageMeasurement): number {
    const globalDelta = a.coverageMeasure.globalDelta;

    // If there is no predecessor (b), return its global delta
    if (b === undefined) {
      return globalDelta;
    }

    // Accumulated coverage
    const bAccumMerge = createCoverageMap(b.coverageMeasure.accum.data);
    const bAccumBefore = this.toNumber(bAccumMerge);
    bAccumMerge.merge(a.coverageMeasure.accum.data);
    const bAccumAfter = this.toNumber(bAccumMerge);
    const accumDelta = bAccumAfter - bAccumBefore;

    console.debug(`[${this.name}] globalDelta: ${globalDelta}`); // !!!!!!!
    console.debug(
      `[${this.name}] accumDelta: ${accumDelta} bAccumBefore: ${bAccumBefore} bAccumAfter: ${bAccumAfter}`
    ); // !!!!!!!

    // Return abs(globalDelta) + abs(currentDelta / total)
    return a.coverageMeasure.globalDelta + accumDelta;
  } // !!!!!!
} // !!!!!!

// !!!!!!
export type CoverageMeasurement = BaseMeasurement & {
  name: string;
  coverageMeasure: {
    current: ImmutableCoverageMapData; // !!!!!!
    accum: ImmutableCoverageMapData; // !!!!!!
    accumDelta: number; // !!!!!!
    global: ImmutableCoverageMapData; // !!!!!!
    globalDelta: number; // !!!!!!
  };
};

// !!!!!!
class ImmutableCoverageMapData {
  private _data: CoverageMapData; // !!!!!!

  constructor(data: CoverageMapData) {
    this._data = JSON5.parse(JSON5.stringify(data));
  } // !!!!!!

  public get data(): CoverageMapData {
    return JSON5.parse(JSON5.stringify(this._data));
  } // !!!!!!
} // !!!!!!

// !!!!!!
/*!!!!!!!
type CoverageMeasurementData = {
  lines: {
    total: number;
    covered: number;
  };
  branches: {
    total: number;
    covered: number;
  };
  functions: {
    total: number;
    covered: number;
  };
  map: CoverageMap;
};
*/
