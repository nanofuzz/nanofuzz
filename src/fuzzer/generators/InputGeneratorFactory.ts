import { FunctionDef } from "../analysis/FunctionDef";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { HumanInputGenerator } from "./HumanInputGenerator";
import { Leaderboard } from "./Leaderboard";
import { MutationInputGenerator } from "./MutationInputGenerator";
import { RandomInputGenerator } from "./RandomInputGenerator";
import { AiInputGenerator } from "./AiInputGenerator";
import { UserInputGenerator } from "./UserInputGenerator";
import { AbstractMeasure } from "../measures/AbstractMeasure";
import { AbstractCoverageMeasure } from "../measures/AbstractCoverageMeasure";
import {
  FuzzOptions,
  FuzzTestStats,
  GetFuzzerFocusFn,
  InputAndSource,
} from "../Types";

/**
 * Produces a set of concrete input generators appropriate for
 * a given fuzzer environment
 *
 * @param `options` generator options
 * @param `fn` function definition
 * @param `rngSeed` pseudo random number generator seed
 * @param `leaderboard` running list of "interesting" inputs
 * @param `genStats` generator statistics
 * @param `allInputs` running list of dupe-checked inputs
 * @param `moduleSrc` enclosing module source code
 * @param `getFuzzerFocus` focus getter function
 * @param `measures` active measurement components
 * @returns array of concrete input generators
 */
export function InputGeneratorFactory(
  options: FuzzOptions["generators"],
  fn: FunctionDef,
  rngSeed: string | undefined,
  leaderboard: Leaderboard<InputAndSource>,
  genStats: FuzzTestStats["generators"],
  allInputs: Map<string, unknown>,
  moduleSrc: string,
  getFuzzerFocus?: GetFuzzerFocusFn,
  measures?: AbstractMeasure[]
): AbstractInputGenerator[] {
  const covMeasure = measures?.find(
    (m): m is AbstractCoverageMeasure => m.name === "CoverageMeasure"
  );
  return [
    new HumanInputGenerator(fn.getArgDefs(), rngSeed),
    new RandomInputGenerator(fn.getArgDefs(), rngSeed),
    new MutationInputGenerator(
      fn.getArgDefs(),
      rngSeed,
      leaderboard,
      getFuzzerFocus,
      genStats?.MutationInputGenerator
    ),
    new AiInputGenerator(fn, rngSeed, allInputs, moduleSrc, covMeasure),
    new UserInputGenerator(fn, rngSeed),
  ];
} // fn: InputGeneratorFactory
