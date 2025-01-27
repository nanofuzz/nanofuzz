import { ProgramDef } from "fuzzer/analysis/typescript/ProgramDef";
import { FunctionRef } from "fuzzer/analysis/typescript/Types";
import { AbstractProgramModel } from "./AbstractProgramModel";
import { GeminiProgramModel } from "./GeminiProgramModel";

/** !!!!!! TODO !!!!!!
 *
 * - Retrieve spec from program code if present
 * - Query caching w/bypass capability
 * - Pipeline & sequence queries by concrete implementation
 *
 */
export abstract class ProgramModelFactory {
  public static create(
    pgm: ProgramDef,
    fnRef: FunctionRef
  ): AbstractProgramModel {
    // !!!!!!
    return new GeminiProgramModel(pgm, fnRef);
  }
}
