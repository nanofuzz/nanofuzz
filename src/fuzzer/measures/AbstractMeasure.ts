import { FuzzTestResults } from "../Fuzzer";
import { VmGlobals } from "../Types";

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
  public onAfterCompile(jsSrc: string, jsFileName: string): string {
    jsFileName;
    this._tick = 0;
    return jsSrc;
  }

  // !!!!!!
  public onAfterExecute(globals: VmGlobals): Measurement {
    globals;
    return { type: "measure", tick: this._tick, value: 0 };
  }

  // !!!!!!
  public onBeforeNextTestExecution(): void {
    this._tick++;
  }

  // !!!!!!! Narrow to individual FuzzTestResult
  public onAfterValidation(results: FuzzTestResults): Measurement {
    results;
    return { type: "measure", tick: this._tick, value: 0 };
  }

  // !!!!!
  public onAfterTesting(results: FuzzTestResults): void {
    results;
  }

  // !!!!!!
  public delta(first: Measurement, second: Measurement): number {
    first;
    second;
    return 0;
  }
}

// !!!!!!
export type Measurement = {
  type: "measure";
  tick: number;
  value: number;
};
