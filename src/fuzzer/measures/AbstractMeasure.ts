import { InputAndSource } from "fuzzer/generators/Types";
import { FuzzTestResults } from "../Fuzzer";
import { FuzzTestResult, VmGlobals } from "../Types";

/**
 * Abstract class of a measure
 */
export abstract class AbstractMeasure {
  protected _weight = 1;

  /**
   * Returns the measure's name
   */
  public get name(): string {
    return this.constructor.name;
  } // property: get name

  /**
   * Returns the measure's weight
   */
  public get weight(): number {
    return this._weight;
  } // property: get weight

  /**
   * Set the measure's weight
   */
  public set weight(inWeight: number) {
    this._weight = inWeight;
  } // property: set weight

  /**
   * Hook for instrumenting code after compilation but prior to load.
   *
   * @param `jsSrc` source code
   * @param `jsFileName` location of source coe
   * @returns modified source code
   */
  public abstract onAfterCompile(jsSrc: string, jsFileName: string): string;

  /**
   * Hook for extracting data from the context of the program after load.
   * For example, to extract instrumentation data.
   *
   * @param `globals` context of the loaded program
   */
  public abstract onAfterLoad(globals: VmGlobals): void;

  /**
   * Hook for setting up the measure prior to executing each test.
   * Useful for updating internal per-run variables.
   */
  public abstract onBeforeNextTestExecution(): void;

  /**
   * Takes a measurement after each test execution
   *
   * @param `input` test input that was executed
   * @param `result` results of the test
   * @returns measurement data
   */
  public measure(
    input: InputAndSource,
    result: FuzzTestResult
  ): BaseMeasurement {
    result;
    return {
      type: "measure",
      name: this.name,
    };
  } // fn: measure

  /**
   * Hook to perform cleanup activities when the fuzzer is shutting
   * down and after testing has ended
   *
   * @param `results` all test results
   */
  public abstract onShutdown(results: FuzzTestResults): void;

  /**
   * Returns the progress measured for `a`
   *
   * @param `a` measurement
   * @returns progress value
   */
  public abstract delta(a: BaseMeasurement): number;
} // class: AbstractMeasure

/**
 * Base measurement data
 */
export type BaseMeasurement = {
  type: "measure";
  name: string;
};
