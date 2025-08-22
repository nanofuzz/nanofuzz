import { FuzzEnv } from "../Fuzzer";
import { AbstractRunner } from "./AbstractRunner";
import { JSRunner } from "./JSRunner";

// !!!!!!
export function RunnerFactory(
  env: FuzzEnv,
  module: NodeJS.Module,
  jsFn: string
): AbstractRunner {
  env;
  return new JSRunner(module, jsFn);
}
