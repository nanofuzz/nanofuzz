import { FuzzEnv } from "../Fuzzer";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { Leaderboard } from "./Leaderboard";
import { MutationInputGenerator } from "./MutationInputGenerator";
import { RandomInputGenerator } from "./RandomInputGenerator";
import { ScoredInput } from "./Types";

// !!!!!!
export function InputGeneratorFactory(
  env: FuzzEnv,
  leaderboard: Leaderboard<ScoredInput>
): AbstractInputGenerator[] {
  env; // !!!!!!! Base list of generators on FuzzEnv
  leaderboard;
  return [
    new RandomInputGenerator(env.function.getArgDefs(), env.options.seed ?? ""),
    new MutationInputGenerator(
      env.function.getArgDefs(),
      env.options.seed ?? "",
      leaderboard
    ),
  ];
}
