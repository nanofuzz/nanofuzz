// Adapted from npm module 'typescript-require,' which has not been maintained
// for a long time and lacked support for ES6+.
import vm from "vm";
import fs from "fs";
import path from "path";

const tsc = path.join(path.dirname(require.resolve("typescript")), "tsc.js");
const tscScript = new vm.Script(fs.readFileSync(tsc, "utf8"));

let options: CompilerOptions = {
  nodeLib: false,
  target: "ES2020", // default to ES2020
  moduleKind: "commonjs",
  emitOnError: false,
  exitOnError: true,
  tmpDir: path.join(process.cwd(), "tmp"),
  lib: ["DOM", "ScriptHost", "ES5", "ES6", "ES7", "esnext"],
};

export type CompilerOptions = {
  nodeLib: boolean;
  target: string;
  moduleKind: string;
  emitOnError: boolean;
  exitOnError: boolean;
  tmpDir: string;
  lib: string[];
};

export function setOptions(opts: CompilerOptions): void {
  options = opts;
}
export function getOptions(): CompilerOptions {
  return options;
}

export function activate(): void {
  require.extensions[".ts"] = function (module) {
    const jsname = compileTS(module);
    runJS(jsname, module);
  };
}

export function deactivate(): void {
  require.extensions[".ts"] = undefined;
}

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
 * Compiles TypeScript file, returns js file path
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

  if (!isModified(module.filename, jsname)) {
    return jsname;
  }

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

  const sandbox = {
    process: proc,
    require: require,
    module: module,
    Buffer: Buffer,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    __filename: tsc,
  };

  tscScript.runInNewContext(sandbox);
  if (exitCode !== 0) {
    throw new Error(
      "Unable to compile TypeScript file." + " " + module.filaname
    );
    //throw new Error("Unable to compile TypeScript file." + " " + module.filaname + " " + JSON.stringify(sandbox));
  }

  return jsname;
}

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
