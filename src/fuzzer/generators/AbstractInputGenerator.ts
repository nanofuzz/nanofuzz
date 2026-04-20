import seedrandom from "seedrandom";
import { ArgType } from "../analysis/typescript/Types";
import { ArgDef } from "../analysis/typescript/ArgDef";
import { InputAndSource } from "./../Types";
import { InputGeneratorStats } from "./Types";

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
   * Returns true If the generator has inputs available for use
   * and false otherwise.
   */
  public nextable(): boolean {
    return true;
  } // fn: isAvailable

  /**
   * Executes any tasks when the test run begins
   */
  public onRunStart(_active: boolean): void {
    return;
  } // fn: onRunStart

  /**
   * Executes any tasks when the test run ends
   */
  public onRunEnd(): void {
    return;
  } // fn: onRunEnd
}
