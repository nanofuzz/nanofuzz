import { ArgDef } from "../analysis/typescript/ArgDef";
import { ArgType } from "../analysis/typescript/Types";
import { ArgDefGenerator } from "../analysis/typescript/ArgDefGenerator";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { InputAndSource } from "../Types";

/**
 * Generates new inputs pseudo-randomly
 */
export class RandomInputGenerator extends AbstractInputGenerator {
  private _gen: ArgDefGenerator; // underlying random generator

  /**
   * Creates a new random input generator
   *
   * @param `specs` ArgDef specs that describe the input to generate
   * @param `rngSeed` seed for pseudo random number generator
   */
  public constructor(specs: ArgDef<ArgType>[], rngSeed: string) {
    super(specs, rngSeed);
    this._gen = new ArgDefGenerator(this._specs, this._prng);
  } // fn: constructor

  /**
   * Returns the next generated input
   *
   * @returns next randomly-generated input
   */
  public next(): InputAndSource {
    return {
      tick: 0,
      value: this._gen.next(),
      source: { origin: "generator", generator: "RandomInputGenerator" },
    };
  } // fn: next
} // class: RandomInputGenerator
