import { FuzzEnv } from "../Fuzzer";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { RandomInputGenerator } from "./RandomInputGenerator";

// !!!!!!
export function InputGeneratorFactory(env: FuzzEnv): AbstractInputGenerator[] {
  env; // !!!!!!! Base list of generators on FuzzEnv
  return [
    new RandomInputGenerator(env.function.getArgDefs(), env.options.seed ?? ""),
  ];
}
