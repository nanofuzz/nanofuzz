import seedrandom from "seedrandom";
import { ArgDef } from "../analysis/ArgDef";
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
  protected constructor(specs: ArgDef[], rngSeed: string | undefined) {
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
   * and false otherwise. If it returns true, the next `next()` call
   * should not fail.
   *
   * Note: since generators can have asynchronous behavior, `next()` could
   * still succeed even when `nextable()` is false. E.g., AiInputGenerator
   * could receive a response between `nextable()` and `next()`.
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
