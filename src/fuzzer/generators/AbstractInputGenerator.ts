import seedrandom from "seedrandom";
import { ArgType } from "../analysis/typescript/Types";
import { ArgDef } from "../analysis/typescript/ArgDef";
import { InputAndSource } from "./../Types";

/**
 * Abstract class of an input generator
 */
export abstract class AbstractInputGenerator {
  protected _specs; // ArgDef specs that describe inputs.
  protected _prng; // pseudo random number generator

  /**
   * Create a new input generator
   *
   * @param `specs` ArgDef specs that describe the inputs to generate
   * @param `rngSeed` seed for pseudo random nunber generator
   */
  protected constructor(specs: ArgDef<ArgType>[], rngSeed: string | undefined) {
    this._specs = specs;
    this._prng = seedrandom(rngSeed);
  } // fn: constructor

  /**
   * Returns the input generator's name
   */
  public get name(): string {
    return this.constructor.name;
  } // property: get name

  /**
   * Produce the next test-case inputs if isAvailable();
   */
  public abstract next(): InputAndSource;

  /**
   * Returns true If the generator is presently available for use
   * and false otherwise.
   */
  public isAvailable(): boolean {
    return true;
  } // fn: isAvailable

  /**
   * Executes any tasks when the test run ends
   */
  public onRunEnd(): void {
    return;
  } // fn: onRunEnd
}
