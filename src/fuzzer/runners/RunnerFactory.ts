import { PythonProgram } from "../analysis/python/PythonProgram";
import { RustProgram } from "../analysis/rust/RustProgram";
import { FuzzEnv } from "../Types";
import { AbstractRunner, RunnerOverrides } from "./AbstractRunner";
import { JavascriptRunner } from "./javascript/JavascriptRunner";
import { PythonRunner } from "./python/PythonRunner";
import { RustRunner } from "./rust/RustRunner";

/**
 * Returns an AbstractRunner appropriate to the input environment, module,
 * and function.
 *
 * @param `env` fuzzer environment with configuration details
 * @param `module` loaded module
 * @param `fn` function to run
 * @param `overrides` optional runner configuration overrides
 * @returns an appropriate AbstractRunner instance
 */
export function RunnerFactory(
  env: FuzzEnv,
  module: string,
  fn: string,
  overrides: RunnerOverrides = {}
): AbstractRunner {
  if (
    module.endsWith(".js") ||
    module.endsWith(".mjs") ||
    module.endsWith(".cjs")
  ) {
    return new JavascriptRunner(module, fn, env, overrides);
  }

  if (PythonProgram.understands({ filename: module })) {
    return new PythonRunner(module, fn, env, overrides);
  }

  if (RustProgram.understands({ filename: module })) {
    return new RustRunner(module, fn, env, overrides);
  }

  throw new Error(`Support not yet implemented for program in: ${module}`);
} // fn: RunnerFactory
