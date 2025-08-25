import seedrandom from "seedrandom";
import { ArgType, ArgValueType } from "../analysis/typescript/Types";
import { ArgDef } from "../analysis/typescript/ArgDef";

// !!!!!!
export abstract class AbstractInputGenerator {
  protected _argDefs;
  protected _rngSeed;
  protected _prng;

  // !!!!!!
  protected constructor(argDef: ArgDef<ArgType>[], rngSeed: string) {
    this._argDefs = argDef;
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
  public abstract next(): { input: ArgValueType[]; source: string };

  /**
   * Returns true If the generator is presently available for use
   * and false otherwise.
   */
  public isAvailable(): boolean {
    return true;
  }
}
