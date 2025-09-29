import seedrandom from "seedrandom";
import { ArgType } from "../analysis/typescript/Types";
import { ArgDef } from "../analysis/typescript/ArgDef";
import { InputAndSource } from "./Types";

// !!!!!!
export abstract class AbstractInputGenerator {
  protected _specs;
  protected _rngSeed;
  protected _prng;

  // !!!!!!
  protected constructor(specs: ArgDef<ArgType>[], rngSeed: string) {
    this._specs = specs;
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
  public abstract next(): InputAndSource;

  /**
   * Returns true If the generator is presently available for use
   * and false otherwise.
   */
  public isAvailable(): boolean {
    return true;
  }

  // !!!!!!
  public onShutdown(): void {
    return;
  }
}
