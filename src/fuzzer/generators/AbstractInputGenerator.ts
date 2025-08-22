import seedrandom from "seedrandom";
import { ArgDef, ArgType } from "../Fuzzer";
import { FuzzIoElement } from "../Types";

// !!!!!!
export abstract class AbstractInputGenerator {
  protected _argType;
  protected _rngSeed;
  protected _prng;

  // !!!!!!
  protected constructor(argType: ArgDef<ArgType>[], rngSeed: string) {
    this._argType = argType;
    this._rngSeed = rngSeed;
    this._prng = seedrandom(rngSeed);
  }

  /**
   * Returns the input generator's name
   */
  public get name(): string {
    return this.constructor.name;
  }

  /**
   * Produce the next test-case inputs if isAvailable();
   */
  public abstract next(): FuzzIoElement[];

  /**
   * Returns true If the generator is presently available for use
   * and false otherwise.
   */
  public isAvailable(): boolean {
    return true;
  }
}
