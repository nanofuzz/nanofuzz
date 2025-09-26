import { FuzzEnv } from "../Fuzzer";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { Leaderboard } from "./Leaderboard";
import { MutationInputGenerator } from "./MutationInputGenerator";
import { RandomInputGenerator } from "./RandomInputGenerator";
import { InputAndSource } from "./Types";

// !!!!!!
export function InputGeneratorFactory(
  env: FuzzEnv,
  leaderboard: Leaderboard<InputAndSource>
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
