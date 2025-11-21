import { FunctionDef } from "../Fuzzer";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { Leaderboard } from "./Leaderboard";
import { MutationInputGenerator } from "./MutationInputGenerator";
import { RandomInputGenerator } from "./RandomInputGenerator";
import { AiInputGenerator } from "./AiInputGenerator";
import { FuzzOptions, InputAndSource } from "../Types";
import { ProgramModelFactory } from "../../models/ProgramModelFactory";

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
  const generators: AbstractInputGenerator[] = [];

  if (options.RandomInputGenerator.enabled) {
    generators.push(new RandomInputGenerator(fn.getArgDefs(), rngSeed));
  }

  if (options.MutationInputGenerator.enabled) {
    generators.push(
      new MutationInputGenerator(fn.getArgDefs(), rngSeed, leaderboard)
    );
  }

  if (options.AiInputGenerator.enabled) {
    if (ProgramModelFactory.isConfigured()) {
      generators.push(
        new AiInputGenerator(
          fn.getArgDefs(),
          rngSeed,
          ProgramModelFactory.create(fn)
        )
      );
    }
  }

  return generators;
} // fn: InputGeneratorFactory
