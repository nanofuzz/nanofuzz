import { FuzzTestResult } from "../Types";
import { FuzzTestResults } from "fuzzer/Fuzzer";
import { CoverageMeasure, CoverageMeasurement } from "./CoverageMeasure";

// !!!!!!
export class FailedTestMeasure extends CoverageMeasure {
  private _pseudoBugsData: Record<number, Record<string, number>> = {};
  private _pseudoBugsFound = 0;

  /**
   * Don't generate any additional instrumentation for this measure.
   */
  public onAfterCompile(jsSrc: string, jsFileName: string): string {
    jsFileName;
    return jsSrc;
  }

  // !!!!!!
  // No ground truth for bugs so we approximate by coverage & validator
  public measure(result: FuzzTestResult): FailedTestMeasurement {
    const coverageMeasure = super.measure(result);
    let pseudoBugsFound = 0;
    const newlyFailingValidators: number[] = [];

    // Make an array of all validator results
    const validators = [result.passedImplicit, result.passedHuman];
    if (result.passedValidators !== undefined) {
      validators.push(...result.passedValidators);
    }

    // Init bugs data
    if (!Object.keys(this._pseudoBugsData).length) {
      validators.forEach((value, v) => {
        this._pseudoBugsData[v] = {};
      });
    }

    // Find validators and coverage combinations exhibiting failures
    const incrementMap = JSON.stringify(
      coverageMeasure.coverageMeasure.current.map
    );
    let v: keyof typeof validators;
    for (v in validators) {
      if (validators[v] === false) {
        if (!(incrementMap in this._pseudoBugsData[v])) {
          this._pseudoBugsData[v][incrementMap] = 1;
          newlyFailingValidators.push(Number(v));
          pseudoBugsFound++;
        } else {
          this._pseudoBugsData[v][incrementMap]++;
        }
      }
    }

    // If we found a new one, incremement the counter
    if (pseudoBugsFound) {
      this._pseudoBugsFound += pseudoBugsFound;
    }

    /* !!!!!!!
    if (this._tick < 11) {
      console.debug(
        `[${this.name}][${this._tick}] Incremental ${
          pseudoBugFound ? 1 : 0
        } ${JSON.stringify(newlyFailingValidators)}`
      ); // !!!!!!!
      console.debug(
        `[${this.name}][${this._tick}] Total ${
          this._pseudoBugsFound
        } ${JSON.stringify(validators)}`
      ); // !!!!!!!
    }
    */

    // Return the measurement
    return {
      ...coverageMeasure,
      name: this.name,
      total: this._pseudoBugsFound,
      increment: pseudoBugsFound,
      failedTestMeasure: {
        increment: {
          validators: newlyFailingValidators,
        },
      },
    };
  }

  // !!!!!!
  public onShutdown(results: FuzzTestResults): void {
    results;
  }
}

// !!!!!!
type FailedTestMeasurement = CoverageMeasurement & {
  failedTestMeasure: {
    increment: {
      validators: number[];
    };
  };
};
