import seedrandom from "seedrandom";
import { ArgDef } from "../analysis/ArgDef";
import { InputAndSource } from "./../Types";
import { FuzzTestResults } from "../Fuzzer";
import { InputGeneratorStats, NextableStatus } from "./Types";

/**
 * Abstract class of an input generator
 */
export abstract class AbstractInputGenerator {
  protected _specs; // ArgDef specs that describe inputs.
  protected _prng; // pseudo random number generator
  protected _pendingPromise?: Promise<boolean>; // Pending promise for async input generation

  /**
   * Create a new input generator
   *
   * @param `specs` ArgDef specs that describe the inputs to generate
   * @param `rngSeed` seed for pseudo random nunber generator
   */
  protected constructor(specs: ArgDef[], rngSeed: string | undefined) {
    this._specs = specs;
    this._prng =
      rngSeed && rngSeed.length > 0 ? seedrandom(rngSeed) : seedrandom();
  } // fn: constructor

  /**
   * Returns the input generator's name
   */
  public get name(): string {
    return this.constructor.name;
  } // property: get name

  /**
   * Returns generator stats
   */
  public get stats(): InputGeneratorStats {
    return {};
  } // property: get stats

  /**
   * Produce the next test-case inputs if isAvailable();
   */
  public abstract next(): InputAndSource;

  /**
   * Asynchronously produce the next test-case inputs when `nextable()` returns "soon".
   * Awaits the pending promise managed by asynchronous generation tasks, then returns `next()`.
   */
  public async nextSoon(): Promise<InputAndSource> {
    while (this.nextable() === "soon") {
      if (this._pendingPromise) {
        await this._pendingPromise;
      } else {
        break;
      }
    }
    if (this.nextable() === "now") {
      return this.next();
    }
    throw new Error(
      `nextSoon() failed: generator '${this.name}' is no longer pending and produced no inputs.`
    );
  } // fn: nextSoon

  /**
   * Returns `now` if the generator has inputs available for use,
   * `soon` if input generation is pending asynchronously,
   * and `false` otherwise.
   */
  public abstract nextable(): NextableStatus;

  /**
   * Executes any tasks when the test run begins
   */
  public onRunStart(_active: boolean): void {
    return;
  } // fn: onRunStart

  /**
   * Executes any tasks when the test run ends
   */
  public async onRunEnd(_results?: FuzzTestResults): Promise<void> {
    return;
  } // fn: onRunEnd

  /**
   * Returns diagnostic messages when the generator is unable to produce inputs
   * or encounters configuration/execution errors.
   */
  public getDiagnostics(): string[] {
    return [];
  } // fn: getDiagnostics
}
