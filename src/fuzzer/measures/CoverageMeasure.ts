import { AbstractMeasure, Measurement } from "./AbstractMeasure";
import { createInstrumenter } from "istanbul-lib-instrument";
import {
  CoverageMap,
  CoverageMapData,
  createCoverageMap,
} from "istanbul-lib-coverage";
import { VmGlobals } from "../Types";
import { FuzzTestResults } from "fuzzer/Fuzzer";

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
  // Note: also called on initial load
  public onAfterExecute(globals: VmGlobals): CoverageMeasurement {
    const measure = super.onAfterExecute(globals);

    // Save the global context of the original module load because
    // that is where the instrumented code writes coverage data
    if (this._coverageData === undefined) {
      this._coverageData = globals.__coverage__;
    }

    // Build a coverage map from a cloned copy of the
    // coverage data
    const coverageMap = createCoverageMap(
      JSON.parse(JSON.stringify(this._coverageData))
    );
    this._totalCoverage.merge(coverageMap);
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
    const coverageSummary = this._totalCoverage.getCoverageSummary();
    return {
      ...measure,
      value:
        coverageSummary.branches.covered +
        coverageSummary.statements.covered +
        coverageSummary.functions.covered,
      coverageMeasure: {
        progress: {
          lines: {
            total: coverageSummary.data.lines.total,
            covered: coverageSummary.data.lines.covered,
          },
          branches: {
            total: coverageSummary.data.branches.total,
            covered: coverageSummary.data.branches.covered,
          },
          functions: {
            total: coverageSummary.data.functions.total,
            covered: coverageSummary.data.functions.covered,
          },
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
  public onAfterTesting(results: FuzzTestResults): void {
    results.aggregateCoverageSummary = this._totalCoverage.getCoverageSummary(); // !!!!!!
    console.debug(
      `[CoverageMeasure][${this._tick}] `,
      results.aggregateCoverageSummary
    ); // !!!!!!!
  }
}

// !!!!!!
type CoverageMeasurement = Measurement & {
  coverageMeasure: {
    progress: {
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
    };
  };
};
