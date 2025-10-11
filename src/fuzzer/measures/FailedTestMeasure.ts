import { FuzzTestResult } from "../Types";
import { InputAndSource } from "fuzzer/generators/Types";
import { AbstractMeasure, BaseMeasurement } from "./AbstractMeasure";
import { CoverageMeasure } from "./CoverageMeasure";

/**
 * Measures the number of newly-failing tests. Because there is no ground truth for bugs,
 * we use code coverage, if available, to approximate distinct bugs.
 */
export class FailedTestMeasure extends AbstractMeasure {
  protected _covMeasure?: CoverageMeasure; // Code Coverage Measure
  protected _pseudoBugsData: Record<number, Record<string, number>> = {}; // Number of pseudo bugs by validator# and coverage map
  protected _pseudoBugsFound = 0; // total number of pseudo bugs found

  /**
   * Creates a new FailedtestMeasure object
   *
   * @param `covMeasure` optional code coverage measurement object
   */
  constructor(covMeasure?: CoverageMeasure) {
    super();
    this._covMeasure = covMeasure;
  } // fn: constructor

  /**
   * Measure the test failures of the most recent test execution.
   *
   * @param `input` test input
   * @param `result` test result
   * @returns a test failure measurement for the test execution
   */
  public measure(
    input: InputAndSource,
    result: FuzzTestResult
  ): FailedTestMeasurement {
    const measure = super.measure(input, result);
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

    // Get the coverage map for this tick
    const coverageMapData =
      this._covMeasure && this._covMeasure.hasCoverage(input.tick)
        ? JSON.stringify(
            this._covMeasure.getCoverage(input.tick).coverageMeasure.current
              .data
          )
        : "";

    // Find new validator failures and coverage combinations exhibiting failures
    validators.forEach((v, i) => {
      if (v === false) {
        if (!(coverageMapData in this._pseudoBugsData[i])) {
          this._pseudoBugsData[i][coverageMapData] = 1;
          newlyFailingValidators.push(Number(i));
          pseudoBugsFound++;
        } else {
          this._pseudoBugsData[i][coverageMapData]++;
        }
      }
    });

    // If we found a new one, incremement the counter
    if (pseudoBugsFound) {
      this._pseudoBugsFound += pseudoBugsFound;
    }

    // Return the measurement
    return {
      ...measure,
      name: this.name,
      failedTestMeasure: {
        current: [...newlyFailingValidators],
        pseudoBugsDelta: pseudoBugsFound,
      },
    };
  } // fn: measure

  /**
   * Calculates a numeric value representing the test execution's progress
   *
   * @param `a` failed test measurement
   * @returns a numeric value representing the progress of the test execution
   */
  public delta(a: FailedTestMeasurement): number {
    return a.failedTestMeasure.pseudoBugsDelta;
  } // fn: delta
} // class: FailedTestMeasure

/**
 * Extends BaseMeasurement with test failure details
 */
type FailedTestMeasurement = BaseMeasurement & {
  failedTestMeasure: {
    current: number[]; // validation failures
    pseudoBugsDelta: number; // number of new pseudo bugs found
  };
};
