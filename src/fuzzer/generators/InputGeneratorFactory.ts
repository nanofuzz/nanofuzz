import { FunctionDef } from "../Fuzzer";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { Leaderboard } from "./Leaderboard";
import { MutationInputGenerator } from "./MutationInputGenerator";
import { RandomInputGenerator } from "./RandomInputGenerator";
import { AiInputGenerator } from "./AiInputGenerator";
import { FuzzOptions, InputAndSource } from "../Types";

/**
 * Produces a set of concrete input generators appropriate for
 * a given fuzzer environment
 *
 * @param `env` Fuzzer environment with configuration details
 * @param `leaderboard` running list of "interesting" inputs
 * @returns array of concrete input generators
 */
export function InputGeneratorFactory(
  options: FuzzOptions["generators"],
  fn: FunctionDef,
  rngSeed: string | undefined,
  leaderboard: Leaderboard<InputAndSource>
): AbstractInputGenerator[] {
  return [
    new RandomInputGenerator(fn.getArgDefs(), rngSeed),
    new MutationInputGenerator(fn.getArgDefs(), rngSeed, leaderboard),
    new AiInputGenerator(fn, rngSeed),
  ];
} // fn: InputGeneratorFactory
