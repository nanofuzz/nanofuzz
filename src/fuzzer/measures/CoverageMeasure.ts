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
  private _globalCoverageMap = new ImmutableCoverageMapData({}); // Global code coverage
  private _history: CoverageMeasurementNode[] = []; // !!!!!!

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

    // Sanity check that we have coverage data to ingest
    if (this._coverageData === undefined) {
      throw new Error("No current coverage data found");
    }

    // Make the current coverage data immutable
    const currentCoverageData = new ImmutableCoverageMapData(
      this._coverageData
    );

    // Merge the current coverage into all predecessors
    const pred =
      input.source.tick === undefined
        ? undefined
        : this._history[input.source.tick];
    let accumBefore = 0;
    let accumAfter = 0;
    let nextPred = pred;
    while (nextPred) {
      const accum = createCoverageMap(nextPred.meas.coverageMeasure.accum.data);
      if (!nextPred.pred) accumBefore = this.toNumber(accum);
      accum.merge(currentCoverageData.data);
      if (!nextPred.pred) accumAfter = this.toNumber(accum);
      nextPred.meas.coverageMeasure.accum = new ImmutableCoverageMapData(
        accum.data
      );
      nextPred = nextPred.pred;
    }

    // Merge the current coverage into the global coverage map
    const globalCoverageMap = createCoverageMap(this._globalCoverageMap.data);
    const globalBefore = this.toNumber(globalCoverageMap);
    globalCoverageMap.merge(currentCoverageData.data);
    this._globalCoverageMap = new ImmutableCoverageMapData(
      globalCoverageMap.data
    );

    // Build the measurement object
    const meas = {
      ...measure,
      name: this.name,
      coverageMeasure: {
        current: new ImmutableCoverageMapData(currentCoverageData.data),
        globalDelta: this.toNumber(globalCoverageMap) - globalBefore,
        accum: new ImmutableCoverageMapData(currentCoverageData.data),
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
  } // !!!!!!

  // !!!!!!
  public delta(a: CoverageMeasurement): number {
    return a.coverageMeasure.globalDelta * 100 + a.coverageMeasure.accumDelta; // !!!!!!!
  } // !!!!!!

  // !!!!!!
  public onBeforeNextTestExecution(): void {
    super.onBeforeNextTestExecution();

    // Zero out the coverage data so that we know the incremental
    // coverage for just the present execution
    if (this._coverageData) {
      let fileKey: keyof typeof this._coverageData;
      for (fileKey in this._coverageData) {
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
    results.aggregateCoverageSummary = createCoverageMap(
      this._globalCoverageMap.data
    ).getCoverageSummary(); // !!!!!!
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
} // !!!!!!

// !!!!!!
export type CoverageMeasurement = BaseMeasurement & {
  name: string;
  coverageMeasure: {
    current: ImmutableCoverageMapData; // current coverage of this input
    accum: ImmutableCoverageMapData; // accumulated coverage of this plus successors
    accumDelta: number; // !!!!!!
    globalDelta: number; // !!!!!!
  };
};

// !!!!!!
class ImmutableCoverageMapData {
  private _data: string; // !!!!!!

  constructor(data: CoverageMapData) {
    this._data = JSON5.stringify(data);
  } // !!!!!!

  public get data(): CoverageMapData {
    return JSON5.parse(this._data);
  } // !!!!!!
} // !!!!!!

// !!!!!!
type CoverageMeasurementNode = {
  input: InputAndSource;
  pred: CoverageMeasurementNode | undefined;
  meas: CoverageMeasurement;
}; // !!!!!!
