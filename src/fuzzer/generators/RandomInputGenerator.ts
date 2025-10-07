import { ArgDef } from "../analysis/typescript/ArgDef";
import { ArgType } from "../analysis/typescript/Types";
import { ArgDefGenerator } from "../analysis/typescript/ArgDefGenerator";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { InputAndSource } from "./Types";

// !!!!!!
export class RandomInputGenerator extends AbstractInputGenerator {
  private _gen: ArgDefGenerator; // !!!!!!

  // !!!!!!
  public constructor(specs: ArgDef<ArgType>[], rngSeed: string) {
    super(specs, rngSeed);
    this._gen = new ArgDefGenerator(this._specs, this._prng);
  } // !!!!!!

  // !!!!!!
  public next(): InputAndSource {
    return { tick: 0, value: this._gen.next(), source: { subgen: this.name } };
  } // !!!!!!
} // !!!!!!
