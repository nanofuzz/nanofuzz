import { PythonProgram } from "../analysis/python/PythonProgram";
import { FuzzEnv } from "../Fuzzer";
import { AbstractRunner } from "./AbstractRunner";
import { JavascriptRunner } from "./JavascriptRunner";
import { PythonRunner } from "./PythonRunner";

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
  _env: FuzzEnv,
  module: NodeJS.Module | string,
  fn: string
): AbstractRunner {
  if (typeof module === "string") {
    if (PythonProgram.understands({ filename: module })) {
      return new PythonRunner(module, fn);
    } else {
      throw new Error("Not yet implemented");
    }
  } else {
    return new JavascriptRunner(module, fn);
  }
} // fn: RunnerFactory
