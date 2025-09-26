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

// !!!!!!
export class CoverageMeasure extends AbstractMeasure {
  private _coverageData?: CoverageMapData; // coverage data written to by instrumented code
  private _totalCoverage: CoverageMap = createCoverageMap({}); // Aggregate coverage

  // !!!!!!
  public onAfterCompile(jsSrc: string, jsFileName: string): string {
    return createInstrumenter({
      produceSourceMap: true,
      coverageGlobalScope: "global",
    }).instrumentSync(jsSrc, jsFileName);
  }

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
  }

  // !!!!!!
  public measure(result: FuzzTestResult): CoverageMeasurement {
    const measure = super.measure(result);

    if (this._coverageData === undefined) {
      throw new Error(
        "Unable to retrieve global.__coverage__ code coverage object"
      );
    }

    // Build a coverage map from a cloned copy of the
    // coverage data
    const incrementCoverageMap = createCoverageMap(
      JSON.parse(JSON.stringify(this._coverageData))
    );
    this._totalCoverage.merge(incrementCoverageMap);
    /*
    if (this._tick < 11) {
      console.debug(
        `[CoverageMeasure][${this._tick}] Incremental `,
        coverageMap.getCoverageSummary()
      ); // !!!!!!!
      console.debug(
        `[CoverageMeasure][${this._tick}] Total `,
        this._totalCoverage.getCoverageSummary()
      ); // !!!!!!!
    }
    */

    // Summarize the coverage and return the progress measure,
    // which is total branches + statements + functions covered.
    const total = this._totalCoverage.getCoverageSummary();
    const increment = incrementCoverageMap.getCoverageSummary();
    return {
      ...measure,
      name: this.name,
      total:
        total.branches.covered +
        total.statements.covered +
        total.functions.covered,
      increment:
        increment.branches.covered +
        increment.statements.covered +
        increment.functions.covered,
      coverageMeasure: {
        increment: {
          lines: {
            total: increment.data.lines.total,
            covered: increment.data.lines.covered,
          },
          branches: {
            total: increment.data.branches.total,
            covered: increment.data.branches.covered,
          },
          functions: {
            total: increment.data.functions.total,
            covered: increment.data.functions.covered,
          },
          map: JSON.parse(JSON.stringify(incrementCoverageMap)),
        },
        total: {
          lines: {
            total: total.data.lines.total,
            covered: total.data.lines.covered,
          },
          branches: {
            total: total.data.branches.total,
            covered: total.data.branches.covered,
          },
          functions: {
            total: total.data.functions.total,
            covered: total.data.functions.covered,
          },
          map: JSON.parse(JSON.stringify(this._totalCoverage)),
        },
      },
    };
  }

  // !!!!!!
  public onBeforeNextTestExecution(): void {
    super.onBeforeNextTestExecution();

    // Zero out the coverage data so that we know the incremental
    // coverage for just the present execution cycle.
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
  }

  // !!!!!!
  public onTestingEnd(results: FuzzTestResults): void {
    results.aggregateCoverageSummary = this._totalCoverage.getCoverageSummary(); // !!!!!!
    console.debug(
      `[CoverageMeasure][${this._tick}] `,
      results.aggregateCoverageSummary
    ); // !!!!!!!
  }
}

// !!!!!!
export type CoverageMeasurement = BaseMeasurement & {
  name: string;
  coverageMeasure: {
    increment: CoverageMeasurementData;
    total: CoverageMeasurementData;
  };
};

// !!!!!!
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
