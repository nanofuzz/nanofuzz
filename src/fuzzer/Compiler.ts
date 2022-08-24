/**
 * This module intercepts require() calls for *.ts modules and transpiles
 * them to js for execution.
 */
import typescript from "typescript";
import * as pirates from "pirates"; // !!!!

/**
 * Default compilation options
 */
let compilerOptions: typescript.CompilerOptions = {
  target: typescript.ScriptTarget.ES2020, // default to ES2020
  module: typescript.ModuleKind.CommonJS,
  noEmitOnError: true,
  lib: ["DOM", "ScriptHost", "ES2020"], // default to ES2020
};

/**
 * Function that removes the *.ts transpilation hook.
 * Maintained by activate() and deactivate().
 */
let hookRevert: any | undefined = undefined;

/**
 * Set the compiler options
 *
 * @param opts CompilerOptions to set
 */
export function setOptions(opts: typescript.CompilerOptions): void {
  compilerOptions = { ...opts };
}

/**
 * Gets the current compiler options
 *
 * @returns current set of compiler options
 */
export function getOptions(): typescript.CompilerOptions {
  return { ...compilerOptions };
}

/**
 * Activate the TypeScript compiler hook & save the revert function
 * !!!!
 */
export function activate(): void {
  if (hookRevert === undefined) {
    hookRevert = pirates.addHook(
      (code, filename) => {
        console.log(`Transpiling: ${filename}`);
        return transpileTS(code);
      },
      {
        exts: [".ts"],
      }
    );
  }
}

/**
 * De-activate the TypeScript compiler hook by calling the rever function
 * !!!!
 */
export function deactivate(): void {
  if (hookRevert !== undefined) {
    hookRevert();
    hookRevert = undefined;
  }
}

/**
 * Transpiles TypeScript source to js source
 *
 * @param tsModuleSource TS Source code
 * @returns transpiled js source
 */
export function transpileTS(tsModuleSource: string): string {
  try {
    // Transpile the module and return the transpile result
    return typescript.transpileModule(tsModuleSource.toString(), {
      compilerOptions,
    }).outputText;
  } catch (e: any) {
    throw new Error(`Unable to compile TypeScript module. ${e.message}`);
  }
}
