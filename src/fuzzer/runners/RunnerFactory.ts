import { AbstractRunner } from "./AbstractRunner";
import { JSRunner } from "./JSRunner";
import req from "require-from-string";
import { TypeScriptCompiler } from "../Compiler";

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
  cfg:
    | {
        type: "NodeJS.Module";
        module: NodeJS.Module;
        fnName: string;
      }
    | {
        type: "typescript.src" | "javascript.src";
        src: string;
        fnName: string;
        fileName?: string;
      }
): AbstractRunner {
  switch (cfg.type) {
    case "NodeJS.Module":
      return new JSRunner(cfg.module, cfg.fnName);
    case "javascript.src":
      return jsSrcToRunner(cfg.src, cfg.fnName, cfg.fnName);
    case "typescript.src":
      return tsSrcToRunner(cfg.src, cfg.fnName, cfg.fnName);
  }
} // fn: RunnerFactory

/**
 * Creates a JSRunner from TypeScript source
 */
function tsSrcToRunner(
  tsSrc: string,
  fnName: string,
  fileName?: string
): JSRunner {
  return jsSrcToRunner(
    TypeScriptCompiler.compileInMemory(tsSrc),
    fnName,
    fileName
  );
} // fn: tsSrcToRunner

/**
 * Creates a JSRunning from Javascript source
 */
function jsSrcToRunner(
  jsSrc: string,
  fnName: string,
  fileName?: string
): JSRunner {
  // !!!!!!!!!! invalidate the module cache
  return new JSRunner(req(jsSrc, fileName), fnName);
} // fn: jsSrcToRunner
