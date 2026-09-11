import { PythonProgram } from "../analysis/python/PythonProgram";
import { FuzzEnv } from "../Fuzzer";
import { AbstractRunner } from "./AbstractRunner";
import { JavascriptRunner } from "./javascript/JavascriptRunner";
import { PythonRunner } from "./python/PythonRunner";

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
  module: string,
  fn: string
): AbstractRunner {
  if (
    module.endsWith(".js") ||
    module.endsWith(".mjs") ||
    module.endsWith(".cjs")
  ) {
    return new JavascriptRunner(module, fn, env);
  }

  if (PythonProgram.understands({ filename: module })) {
    return new PythonRunner(module, fn, env);
  }

  throw new Error(`Support not yet implemented for program in: ${module}`);
} // fn: RunnerFactory
