import { FuzzEnv } from "../Fuzzer";
import { AbstractRunner } from "./AbstractRunner";
import { JSRunner } from "./JSRunner";

/**
 * Returns an AbstractRunner appropriate to the input environment, module,
 * and function.
 *
 * @param `env` fuzzer environment with configuration details
 * @param `module` loaded module
 * @param `jsFn` function to run
 * @returns an appropriate AbstractRunner instance
 */
export function RunnerFactory(
  env: FuzzEnv,
  module: NodeJS.Module,
  jsFn: string
): AbstractRunner {
  env;
  return new JSRunner(module, jsFn);
} // fn: RunnerFactory
