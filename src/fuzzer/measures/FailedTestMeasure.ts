import { FuzzTestResult, InputAndSource } from "../Types";
import { AbstractMeasure, BaseMeasurement } from "./AbstractMeasure";
import { AbstractCoverageMeasure } from "./AbstractCoverageMeasure";
import { AbstractRunner } from "../runners/AbstractRunner";

/**
 * Measures the number of newly-failing tests. Because there is no ground truth for bugs,
 * we use code coverage, if available, to approximate distinct bugs.
 */
export class FailedTestMeasure extends AbstractMeasure {
  protected _covMeasure?: AbstractCoverageMeasure; // Code Coverage Measure
  protected _pseudoBugsData: Record<number, Record<string, number>> = {}; // Number of pseudo bugs by validator# and coverage map
  protected _pseudoBugsFound = 0; // total number of pseudo bugs found

  /**
   * Creates a new FailedtestMeasure object
   *
   * @param `covMeasure` optional code coverage measurement object
   */
  constructor(covMeasure?: AbstractCoverageMeasure) {
    super();
    this._covMeasure = covMeasure;
  } // fn: constructor

  /**
   * Called at the start of a test run.
   *
   * @param runner the test runner instance
   */
  public override onRunStart(
    runners: AbstractRunner[] | AbstractRunner
  ): void {
    super.onRunStart(runners);
    this._pseudoBugsData = {};
    this._pseudoBugsFound = 0;
  } // fn: onRunStart

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

    // Make an array of all judgments
    const judgments = [
      result.passedImplicit,
      result.passedHuman,
      ...result.passedValidators,
    ];

    // Init bugs data
    judgments.forEach((_, v) => {
      this._pseudoBugsData[v] = this._pseudoBugsData[v] ?? {};
    });

    // Get the coverage map for this tick
    const coverageMapData =
      this._covMeasure && this._covMeasure.hasCoverage(input.tick)
        ? JSON.stringify(
            this._covMeasure.getCoverage(input.tick).coverageMeasure.current
              .data
          )
        : "";

    // Find new validator failures and coverage combinations exhibiting failures
    judgments.forEach((j, i) => {
      if (j === "fail") {
        this._pseudoBugsData[i] = this._pseudoBugsData[i] ?? {};
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
