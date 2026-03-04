/**
 * Adapted from: https://github.com/theblacksmith/typescript-require
 *
 * This npm module has not been maintained for a long time and lacked
 * support for ES6+ modules. This adaptation adds ES2020 support,
 * allows better control over options, adds basic type checking, and
 * provides an ability to instrument compiled code.
 */
import vm from "vm";
import fs from "fs";
import path from "path";
import os from "os";
import { AbstractMeasure } from "./measures/AbstractMeasure";
import { VmGlobals } from "./Types";

// Load the TypeScript compiler script
// TODO: we should try to use the project's compiler, if it exists
const tsc = path.join(path.dirname(require.resolve("typescript")), "_tsc.js");
const tscScript = new vm.Script(fs.readFileSync(tsc, "utf8")); // TODO: encoding

// Place to store previous ts hooks
const previousRequireExtensions: NodeJS.Dict<
  ((m: NodeJS.Module, filename: string) => unknown)[]
> = {};
const hookType = ".ts";

// List of modules transpiled
let transpiledModules: string[] = [];

/**
 * Default compilation options
 */
const defaultOptions: CompilerOptions = {
  nodeLib: false,
  target: "ES2020", // default to ES2020
  moduleKind: "commonjs",
  emitOnError: false,
  tmpDir: path.join(os.tmpdir(), "tsreq"),
  lib: ["DOM", "ScriptHost", "ES2020"], // default to ES2020
  types: [""],
  typeRoots: [],
  baseUrl: "./",
  skipLibCheck: true,
  moduleResolution: "node",
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  allowJs: true,
  resolveJsonModule: true,
  traceResolution: false,
};
let options: CompilerOptions;
setOptions(defaultOptions);

/**
 * Compiler Options
 */
export type CompilerOptions = {
  nodeLib: boolean;
  target: string;
  baseUrl: string;
  moduleKind: string;
  emitOnError: boolean;
  tmpDir: string;
  lib: string[];
  types: string[];
  typeRoots: string[];
  skipLibCheck: boolean;
  moduleResolution: string;
  allowSyntheticDefaultImports: boolean;
  esModuleInterop: boolean;
  allowJs: boolean;
  resolveJsonModule: boolean;
  traceResolution: boolean;
};

/**
 * Set the compiler options
 *
 * @param opts CompilerOptions to set
 */
export function setOptions(opts: CompilerOptions): void {
  options = JSON.parse(JSON.stringify(opts));
}

/**
 * Gets the current compiler options
 *
 * @returns current set of compiler options
 */
export function getOptions(): CompilerOptions {
  return JSON.parse(JSON.stringify(options));
}

/**
 * Resets the compiler options to the default
 */
export function resetOptions(): void {
  setOptions(defaultOptions);
}

/**
 * Infers compiler settings for a module
 *
 * @param module fully-qualified module path from which to infer compiler settings
 */
export function inferOptionsFromModule(moduleFilename: string): void {
  resetOptions();
  try {
    const tsConfigFilename = findInAncestor(moduleFilename, "tsconfig.json");
    const tsConfig = JSON.parse(fs.readFileSync(tsConfigFilename, "utf8")); // TODO: encoding
    const projectDir = path.dirname(tsConfigFilename);

    if ("compilerOptions" in tsConfig) {
      // typeRoots
      if ("typeRoots" in tsConfig.compilerOptions) {
        options.typeRoots = tsConfig.compilerOptions.typeRoots.map(
          (e: string) =>
            // Replace relative paths because our cwd is not the project
            path.isAbsolute(e) ? e : path.resolve(path.join(projectDir, e)),
        );
      } else {
        options.typeRoots = [
          path.resolve(path.join(projectDir, "node_modules", "@types")),
        ];
      }

      // types -- ignore types that do not exist in any root
      if ("types" in tsConfig.compilerOptions) {
        options.types = tsConfig.compilerOptions.types.filter((t: string) =>
          options.typeRoots.some((tr) =>
            fs.existsSync(path.resolve(path.join(tr, t))),
          ),
        );
      }
      if (options.types.length === 0) {
        options.types = [""];
      }

      // libs
      if ("lib" in tsConfig.compilerOptions) {
        options.lib = tsConfig.compilerOptions.lib;
      }

      // target
      if ("target" in tsConfig.compilerOptions) {
        options.target = String(tsConfig.compilerOptions.target);
      }

      // moduleResolution
      if ("moduleResolution" in tsConfig.compilerOptions) {
        options.moduleResolution = String(
          tsConfig.compilerOptions.moduleResolution,
        );
      }

      // baseUrl
      if ("baseUrl" in tsConfig.compilerOptions) {
        options.baseUrl = path.resolve(
          path.join(projectDir, String(tsConfig.compilerOptions.baseUrl)),
        );
      } else {
        options.baseUrl = projectDir;
      }

      // TODO: there is more that we could infer here
    }
  } catch {
    // no tsconfig found; use defaults
    console.debug(`no tsconfig.json found for module: ${moduleFilename}`);
  }
}

/**
 * Activate the TypeScript compiler hook
 */
export function activate(measures: AbstractMeasure[]): void {
  // Clear any previously-transpiled modules from the cache
  // so that we have a consistent global context across all
  // modules transpiled and loaded.
  transpiledModules.forEach((m) => {
    delete require.cache[m];
  });
  transpiledModules = [];

  // Save the previous extension, if it exists
  if (require.extensions[hookType] !== undefined) {
    if (previousRequireExtensions[hookType] === undefined) {
      previousRequireExtensions[hookType] = [];
    }
    previousRequireExtensions[hookType].push(require.extensions[hookType]);
  }

  // Build a new global context for this activation
  const moduleVmGlobals: { [k: string]: unknown } = {};
  let k: keyof typeof global;
  for (k in global) {
    moduleVmGlobals[k] = global[k];
  }

  // Add our new extension
  require.extensions[hookType] = function (module) {
    // Transpile the Typescript file
    const jsname = compileTS(module);

    // Apply measurement instrumentation
    let src = fs.readFileSync(jsname, "utf8");
    for (const measure of measures) {
      src = measure.onAfterCompile(src, jsname);
    }

    // Load the module
    const context: VmGlobals = runJS(jsname, module, src, moduleVmGlobals);

    // Collect measurements from the initial load
    for (const measure of measures) {
      measure.onAfterLoad(context);
    }

    // Add this module to the list of transpiled modules
    transpiledModules.push(module.filename);
  };
}

/**
 * De-activate the TypeScript compiler hook & restore the previous hook
 */
export function deactivate(): void {
  require.extensions[".ts"] =
    previousRequireExtensions[hookType] === undefined
      ? undefined
      : previousRequireExtensions[hookType].pop();
}

/**
 * Returns true if the TypeScript file has been modified since it was
 * last compiled to Javascript.
 *
 * @param tsname TypeScript file name
 * @param jsname JavaScript file name
 * @returns true if the TypeScript file has been modified since the JavaScript file was last compiled
 */
function isModified(tsname: string, jsname: string) {
  const tsMTime = fs.statSync(tsname).mtime;
  let jsMTime: Date = new Date(0);

  try {
    jsMTime = fs.statSync(jsname).mtime;
  } catch (e) {
    //catch if file does not exists
  }

  return tsMTime > jsMTime;
}

/**
 * Compiles TypeScript file and returns js file path
 *
 * @return {string} js file path
 */
function compileTS(module: NodeJS.Module) {
  let exitCode = 0;

  // Determine the compiled name of the module we are about to compile
  const moduleDirName = path.dirname(module.filename);
  const relativeFolder =
    "." +
    (moduleDirName.charAt(1) === ":"
      ? moduleDirName.substring(2)
      : moduleDirName);
  const jsname = path.join(
    options.tmpDir,
    relativeFolder,
    path.basename(module.filename, ".ts") + ".js",
  );
  console.log(` - Transpiling: ${module.filename}`);
  console.log(`            to: ${jsname}`);

  // If the Javascript file is current, return it directly
  if (!isModified(module.filename, jsname)) {
    return jsname;
  }

  // Construct tsc args
  const argv = [
    "node",
    tsc,

    options.emitOnError ? "" : "--noEmitOnError",

    //"--rootDir",
    //process.cwd(),

    "--target",
    options.target ? options.target : "ES2020",

    options.moduleKind ? "--module" : "",
    options.moduleKind ? options.moduleKind : "",

    "--outDir",
    path.join(options.tmpDir, relativeFolder),

    "--baseUrl",
    options.baseUrl,

    "--lib",
    Array.isArray(options.lib) ? options.lib.join(",") : options.lib,

    options.types.length ? "--types" : "",
    options.types.length ? options.types.join(",") : "",

    "--skipLibCheck",
    options.skipLibCheck.toString(),

    "--moduleResolution",
    options.moduleResolution,

    "--allowSyntheticDefaultImports",
    options.allowSyntheticDefaultImports.toString(),

    "--esModuleInterop",
    options.esModuleInterop.toString(),

    "--allowJs",
    options.allowJs.toString(),

    "--resolveJsonModule",
    options.resolveJsonModule.toString(),

    options.typeRoots.length ? "--typeRoots" : "",
    options.typeRoots.length ? options.typeRoots.join(",") : "",

    module.filename,
  ];

  /*
  console.debug(`outfile: ${path.join(options.tmpDir, relativeFolder)}`);
  console.debug(`cwd: ${process.cwd()}`);
  console.debug(`tsc call: ${compact(argv).join(" ")}`);
  */

  const proc = merge(merge({}, process), {
    argv: compact(argv),
    exit: function (code: number) {
      if (code !== 0) {
        console.error("Fatal Error. Unable to compile TypeScript file.");
      }
      exitCode = code;
    },
  });

  // Create the context for the sandbox
  const sandbox = {
    process: proc,
    require: require,
    module: module,
    Buffer: Buffer,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    __filename: tsc,
    __dirname: path.dirname(tsc),
  };

  // Execute the module script
  tscScript.runInNewContext(sandbox);
  if (exitCode !== 0) {
    throw new Error(
      `Unable to compile TypeScript file. Please check it for errors.<br /><br />File: ${module.filename}`,
    );
  }

  return jsname;
}

/**
 * Execute the Javascript module
 *
 * @param jsname name of the Javascript file
 * @param module Javqscript module
 * @returns The script result, if any
 */
function runJS(
  jsname: string,
  module: NodeJS.Module,
  src: string,
  globals: VmGlobals,
) {
  const context: { [k: string]: unknown } = {
    require: module.require.bind(module),
    exports: module.exports,
    __filename: jsname,
    __dirname: path.dirname(module.filename),
    module: module,
    global: globals,
    root: globals,
  };
  vm.runInNewContext(src, context, {
    filename: jsname,
  });
  return context;
}

function merge(a: any, b: any) {
  if (a && b) {
    for (const key in b) {
      a[key] = b[key];
    }
  }
  return a;
}

function compact<T>(arr: T[]) {
  const narr: T[] = [];
  arr.forEach(function (data) {
    if (data) narr.push(data);
  });
  return narr;
}

/**
 * Returns `dir`'s nearest item by traversing ancestor paths. Throws exception if none found.
 *
 * Adapted from: https://github.com/joshrtay/find-mod/blob/master/lib/index.js
 *
 * @param dir path
 * @param item what to find
 * @returns path to closest item (or exception if not found)
 */
function findInAncestor(dir: string, item: string) {
  const firstDir = dir;
  while (!fs.existsSync(path.join(dir, item))) {
    dir = path.resolve(path.join(dir, "..")); // ascend to parent
    if (dir === path.dirname(dir)) {
      // reached root
      throw new Error(`"${item}" not found below: ${firstDir}`);
    }
  }
  return path.resolve(path.join(dir, item));
}
