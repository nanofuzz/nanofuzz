import { ArgDef } from "../analysis/typescript/ArgDef";
import { ArgType, ArgValueType } from "../analysis/typescript/Types";
import { ArgDefGenerator } from "../analysis/typescript/ArgDefGenerator";
import { AbstractInputGenerator } from "./AbstractInputGenerator";

// !!!!!!
export class RandomInputGenerator extends AbstractInputGenerator {
  private _gen: ArgDefGenerator; // !!!!!!

  // !!!!!!
  public constructor(specs: ArgDef<ArgType>[], rngSeed: string) {
    super(specs, rngSeed);
    this._gen = new ArgDefGenerator(this._specs, this._prng);
  } // !!!!!!

  // !!!!!!
  public next(): { input: ArgValueType[]; source: string } {
    return { input: this._gen.next(), source: this.name };
  } // !!!!!!
} // !!!!!!
