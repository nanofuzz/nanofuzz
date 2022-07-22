/**
 * Adapted from: https://github.com/theblacksmith/typescript-require
 *
 * This npm module has not been maintained for a long time and lacked
 * support for ES6+ modules. This adaptation adds ES2020 support,
 * allows better control over options, and adds basic type checking.
 */
import vm from "vm";
import fs from "fs";
import path from "path";

const tsc = path.join(path.dirname(require.resolve("typescript")), "tsc.js");
const tscScript = new vm.Script(fs.readFileSync(tsc, "utf8"));

/**
 * Default compilation options
 */
let options: CompilerOptions = {
  nodeLib: false,
  target: "ES2020", // default to ES2020
  moduleKind: "commonjs",
  emitOnError: false,
  exitOnError: true,
  tmpDir: path.join(process.cwd(), "tmp"),
  lib: ["DOM", "ScriptHost", "ES2020"], // default to ES2020
};

/**
 * Compiler Options
 */
export type CompilerOptions = {
  nodeLib: boolean;
  target: string;
  moduleKind: string;
  emitOnError: boolean;
  exitOnError: boolean;
  tmpDir: string;
  lib: string[];
};

/**
 * Set the compiler options
 *
 * @param opts CompilerOptions to set
 */
export function setOptions(opts: CompilerOptions): void {
  options = { ...opts };
}

/**
 * Gets the current compiler options
 *
 * @returns current set of compiler options
 */
export function getOptions(): CompilerOptions {
  return { ...options };
}

/**
 * Activate the TypeScript compiler hook
 */
export function activate(): void {
  require.extensions[".ts"] = function (module) {
    const jsname = compileTS(module);
    runJS(jsname, module);
  };
}

/**
 * De-activate the TypeScript compiler hook
 */
export function deactivate(): void {
  require.extensions[".ts"] = undefined;
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
function compileTS(module: any) {
  let exitCode = 0;
  const tmpDir = path.join(options.tmpDir, "tsreq");
  const relativeFolder = path.dirname(
    path.relative(process.cwd(), module.filename)
  );
  const jsname = path.join(
    tmpDir,
    relativeFolder,
    path.basename(module.filename, ".ts") + ".js"
  );

  // If the Javascript file is current, return it directly
  if (!isModified(module.filename, jsname)) {
    return jsname;
  }

  // Construct tsc args
  const argv = [
    "node",
    "tsc.js",
    options.emitOnError ? "" : "--noEmitOnError",
    "--rootDir",
    process.cwd(),
    "--target",
    options.target ? options.target : "ES2020",
    options.moduleKind ? "--module" : "",
    options.moduleKind ? options.moduleKind : "",
    "--outDir",
    tmpDir,
    "--lib",
    Array.isArray(options.lib) ? options.lib.join(",") : options.lib,
    module.filename,
  ];

  const proc = merge(merge({}, process), {
    argv: compact(argv),
    exit: function (code: number) {
      if (code !== 0 && options.exitOnError) {
        console.error(
          "Fatal Error. Unable to compile TypeScript file. Exiting."
        );
        process.exit(code);
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
  };

  // Execute the module script
  tscScript.runInNewContext(sandbox);
  if (exitCode !== 0) {
    throw new Error("Unable to compile TypeScript file.");
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
function runJS(jsname: string, module: any) {
  const content = fs.readFileSync(jsname, "utf8");

  const sandbox: { [k: string]: any } = {};
  for (const k in global) {
    sandbox[k] = global[k];
  }
  sandbox.require = module.require.bind(module);
  sandbox.exports = module.exports;
  sandbox.__filename = jsname;
  sandbox.__dirname = path.dirname(module.filename);
  sandbox.module = module;
  sandbox.global = sandbox;
  sandbox.root = global;

  return vm.runInNewContext(content, sandbox, { filename: jsname });
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
