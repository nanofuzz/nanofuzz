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
import { InputAndSource } from "fuzzer/generators/Types";

// !!!!!!
export class CoverageMeasure extends AbstractMeasure {
  private _coverageData?: CoverageMapData; // coverage data maintained by instrumented code
  private _globalCoverageMap = createCoverageMap({}); // Global code coverage map
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

    // Shwllow clone the raw current coverage data
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
        accumBefore = this.toNumber(nextPred.meas.coverageMeasure.accum);
        nextPred.meas.coverageMeasure.accum.merge(currentCoverageData);
        accumAfter = this.toNumber(nextPred.meas.coverageMeasure.accum);
      }
      nextPred = nextPred.pred;
    }

    // Merge the current coverage into the global coverage map
    const globalBefore = this.toNumber(this._globalCoverageMap);
    this._globalCoverageMap.merge(currentCoverageData);

    // Build the measurement object
    const meas = {
      ...measure,
      name: this.name,
      coverageMeasure: {
        current: createCoverageMap(currentCoverageData),
        globalDelta: this.toNumber(this._globalCoverageMap) - globalBefore,
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
    current: CoverageMap; // current coverage of this input
    accum: CoverageMap; // accumulated coverage of this plus successors
    accumDelta: number; // !!!!!!
    globalDelta: number; // !!!!!!
  };
};

// !!!!!!
type CoverageMeasurementNode = {
  input: InputAndSource;
  pred: CoverageMeasurementNode | undefined;
  meas: CoverageMeasurement;
}; // !!!!!!
