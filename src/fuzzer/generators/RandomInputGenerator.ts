import { ArgDef } from "../analysis/typescript/ArgDef";
import { ArgType } from "../analysis/typescript/Types";
import { ArgDefGenerator } from "../analysis/typescript/ArgDefGenerator";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { InputAndSource } from "../Types";

/**
 * Generates new inputs pseudo-randomly
 */
export class RandomInputGenerator extends AbstractInputGenerator {
  private _gen?: ArgDefGenerator; // underlying random generator

  /**
   * Creates a new random input generator
   *
   * @param `specs` ArgDef specs that describe the input to generate
   * @param `rngSeed` seed for pseudo random number generator
   */
  public constructor(specs: ArgDef<ArgType>[], rngSeed: string | undefined) {
    super(specs, rngSeed);
  } // fn: constructor

  /**
   * Returns the next generated input
   *
   * @returns next randomly-generated input
   */
  public next(): InputAndSource {
    if (!this._gen) {
      this._gen = new ArgDefGenerator(this._specs, this._prng);
    }
    return {
      tick: 0,
      value: this._gen.next(),
      source: { type: "generator", generator: "RandomInputGenerator" },
    };
  } // fn: next

  // !!!!!!
  public onRunEnd(): void {
    this._gen = undefined;
  }
} // class: RandomInputGenerator
