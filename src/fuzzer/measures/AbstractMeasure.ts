import { FuzzTestResults } from "../Fuzzer";
import { FuzzTestResult, VmGlobals } from "../Types";
import { BaseMeasurement } from "./Types";

// !!!!!!
export abstract class AbstractMeasure {
  protected _tick = 0;
  protected _weight = 1;

  /**
   * Returns the measure's name
   */
  public get name(): string {
    return this.constructor.name;
  }

  /**
   * Returns the measure's weight
   */
  public get weight(): number {
    return this._weight;
  }

  /**
   * Set the measure's weight
   */
  public set weight(inWeight: number) {
    this._weight = inWeight;
  }

  // !!!!!!
  // Called after compilation but before load; useful for instrumenting code
  public onAfterCompile(jsSrc: string, jsFileName: string): string {
    jsFileName;
    this._tick = 0;
    return jsSrc;
  }

  // !!!!!!
  // Called after load; useful for retrieving the context needed to
  // extract instrumentation
  public onAfterLoad(globals: VmGlobals): void {
    globals;
  }

  // !!!!!!
  // Called before executing the next test. Useful for updating internal
  // per-run variables.
  public onBeforeNextTestExecution(): void {
    this._tick++;
  }

  // !!!!!!
  // Takes a measurement after execution of a test
  public measure(result: FuzzTestResult): BaseMeasurement {
    result;
    return {
      type: "measure",
      name: this.name,
      tick: this._tick,
      total: 0,
      increment: 0,
    };
  }

  // !!!!!
  // Called after testing has ended
  public onTestingEnd(results: FuzzTestResults): void {
    results;
  }

  // !!!!!!
  public delta(first: BaseMeasurement, second: BaseMeasurement): number {
    first;
    second;
    return 0;
  }
}
