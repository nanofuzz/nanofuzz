/**
 * Originally adapted from https://github.com/theblacksmith/typescript-require
 * with many, many modifications and updates.
 *
 * The original npm module has not been maintained for a long time and lacked
 * support for ES6+ modules. This adaptation supports ES2020, can use the
 * project's tsc or the one included in the extension, can infer settings from
 * the project's tsconfig.json, and provides the ability to instrument
 * compiled code.
 *
 * Note: Because it hooks require, this module is not compatible with Jest.
 */
import vm from "vm";
import fs from "fs";
import path from "path";
import os from "os";
import JSON5 from "json5";
import { AbstractMeasure } from "./measures/AbstractMeasure";
import { FuzzBusyStatusMessage, TscCompilerError, VmGlobals } from "./Types";

// Global list of transpiled modules
const _globalCompiledModules: {
  [k: string]: CompilationRecord;
} = {};
type CompilationRecord = {
  srcPath: string;
  srcDateTime: Date;
  jsname: string;
  tsconfigPath?: string;
  tsconfigDatetime?: Date;
  tscPath: string;
  tscDatetime: Date;
};

/**
 * A TypeScript compiler wrapper for tsc.
 */
export class TypeScriptCompiler {
  protected _tscPath: string; // Path to tsc
  protected _modulePath: string; // Path to a module within a project
  protected _tsconfigPath?: string; // Fully-qualified tsconfig.json path
  protected _projectPath?: string; // Directory of tsconfig.json
  protected _options: CompilerOptions = defaultOptions; // !!!!!!
  protected _compilations: CompilationRecord[] = []; // list of compiled modules

  constructor(fqModulePath: string) {
    this._modulePath = fqModulePath;

    // Make sure the source file exists
    if (!fs.existsSync(fqModulePath)) {
      throw new Error(`Cannot find module to compile: ${fqModulePath}`);
    }

    // Determine tsc location
    this._tscPath = this._findTsc();
  } // constructor

  /**
   * Gets the current compiler options
   * @returns current set of compiler options
   */
  get options(): CompilerOptions {
    return JSON.parse(JSON.stringify(this._options));
  } // get: options

  /**
   * Compile the TypeScript file !!!!!!
   */
  public compile(
    measures: AbstractMeasure[],
    updateFn: (msg: FuzzBusyStatusMessage) => void
  ): ReturnType<NodeJS.Require> {
    // Determine options using the module path
    this._options = JSON5.parse(JSON5.stringify(defaultOptions));
    this._determineOptions();

    // Clear any previously-cached transpiled modules so that
    // we have a consistent global context for compiled modules.
    delete require.cache[require.resolve(this._modulePath)];
    Object.keys(_globalCompiledModules).forEach((m) => {
      delete require.cache[m];
    });

    // Build a new context for this activation
    const moduleVmGlobals: { [k: string]: unknown } = {};
    let k: keyof typeof global;
    for (k in global) {
      moduleVmGlobals[k] = global[k];
    }

    // Save any previous require hooks
    const previousRequireExtensions: NodeJS.Dict<
      ((m: NodeJS.Module, filename: string) => unknown)[]
    > = {};
    if (require.extensions[hookType] !== undefined) {
      if (previousRequireExtensions[hookType] === undefined) {
        previousRequireExtensions[hookType] = [];
      }
      previousRequireExtensions[hookType].push(require.extensions[hookType]);
    }

    // Hook require to compile ts files
    require.extensions[hookType] = (module) => {
      // Compile the Typescript file if the compiled output is stale
      const jsname = !this.isStale(module.filename)
        ? _globalCompiledModules[module.filename].jsname
        : this.tsc(module, updateFn);

      // Apply measurement instrumentation
      let src = fs.readFileSync(jsname, "utf8"); // TODO: encoding
      for (const measure of measures) {
        src = measure.onAfterCompile(src, jsname);
      }

      // Load the module & collect measurements from the initial load
      const context: VmGlobals = this.run(jsname, module, src, moduleVmGlobals);
      for (const measure of measures) {
        measure.onAfterLoad(context);
      }

      // Update this module's compilation record
      const compilation: CompilationRecord = {
        srcPath: module.filename,
        srcDateTime: fs.statSync(module.filename).mtime,
        jsname: jsname,
        tsconfigPath: this._tsconfigPath,
        tsconfigDatetime: this._tsconfigPath
          ? fs.statSync(this._tsconfigPath).mtime
          : undefined,
        tscPath: this._tscPath,
        tscDatetime: fs.statSync(this._tscPath).mtime,
      };
      _globalCompiledModules[module.filename] = compilation;
      this._compilations.push({ ...compilation });
    }; // end: require hook

    // Require the modules requested
    /* eslint eslint-comments/no-use: off */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(this._modulePath);

    // Unhook require
    require.extensions[hookType] =
      previousRequireExtensions[hookType] === undefined ||
      !previousRequireExtensions[hookType].length
        ? undefined
        : previousRequireExtensions[hookType].pop();

    return mod;
  } // fn: compile

  /**
   * Returns true if any of the compiled TypeScript files have been modified
   * since the most-recent compilation to Javascript or if the configuration
   * from which compiler options were inferred have changed.
   *
   * @returns a reason code if re-compilation is needed and `false` otherwise.
   */
  public isStale(
    inSrcFile?: string
  ):
    | false
    | "notcompiled"
    | "sourcechanged"
    | "compilerchanged"
    | "configchanged" {
    // Stale: no compilations for this module have yet taken place in this session
    if (!(this._modulePath in _globalCompiledModules)) {
      return "notcompiled";
    }

    // If no source file was provided, check all the compiled modules for changes
    const sourceFiles =
      inSrcFile === undefined
        ? [...this._compilations.map((e) => e.srcPath)]
        : [inSrcFile];

    for (const sourceFile of sourceFiles) {
      // Retrieve detals of the prior compilation
      const priorCompilation: CompilationRecord | undefined =
        (this._compilations.find((e) => e.srcPath === sourceFile) ??
        sourceFile in _globalCompiledModules)
          ? _globalCompiledModules[sourceFile]
          : undefined;

      // Stale: Not yet compiled
      if (priorCompilation === undefined) {
        return "notcompiled";
      }

      // Stale: Compiled file does not exist
      if (!fs.existsSync(priorCompilation.jsname)) {
        return "notcompiled";
      }

      // Stale: Source file changed since prior compilation
      if (
        priorCompilation.srcDateTime.toISOString() !==
        fs.statSync(sourceFile).mtime.toISOString()
      ) {
        return "sourcechanged";
      }

      // Stale: tsconfig changed since prior compilation
      if (
        priorCompilation.tsconfigPath !== this._tsconfigPath ||
        (this._tsconfigPath &&
          (priorCompilation.tsconfigDatetime ?? new Date(0)).toISOString() !==
            fs.statSync(this._tsconfigPath).mtime.toISOString())
      ) {
        return "configchanged";
      }

      // Stale: tsc changed since prior compilation
      if (
        priorCompilation.tscPath !== this._tscPath ||
        priorCompilation.tscDatetime.toISOString() !==
          fs.statSync(this._tscPath).mtime.toISOString()
      ) {
        return "compilerchanged";
      }
    }

    // Not stale
    return false;
  } // fn: isStale

  /**
   * Compiles TypeScript file and returns js file path
   *
   * @return {string} js file path
   */
  protected tsc(
    module: NodeJS.Module,
    updateFn: (msg: FuzzBusyStatusMessage) => void
  ): string {
    let exitCode = 0;

    // Determine the compiled name of the module
    const moduleDirName = path.dirname(module.filename);
    const relativeFolder =
      "." +
      (moduleDirName.charAt(1) === ":"
        ? moduleDirName.substring(2)
        : moduleDirName);
    const jsname = path.resolve(
      path.join(
        this._options.tmpDir,
        relativeFolder,
        path.basename(module.filename, ".ts") + ".js"
      )
    );
    const options = this._options;

    // Provide feedback that we are compiling
    updateFn({
      msg: `Compiling: ${module.filename}`,
      milestone: true,
      pct: 0.01,
    });

    // Construct tsc args
    const argv = [
      "node",
      this._tscPath,

      options.emitOnError ? "" : "--noEmitOnError",

      //"--rootDir",
      //process.cwd(),

      "--target",
      options.target ? options.target : "ES2020",

      options.moduleKind ? "--module" : "",
      options.moduleKind ? options.moduleKind : "",

      "--outDir",
      path.resolve(path.join(options.tmpDir, relativeFolder)),

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
    const tscCall = compact(argv).join(" ");

    /*
    console.debug(`outfile: ${path.join(options.tmpDir, relativeFolder)}`);
    console.debug(`cwd: ${process.cwd()}`);
    console.debug(`tsc call: ${tscCall}`);
    */

    const logData: string[] = []; // Record compiler output
    const proc = merge(merge({}, process), {
      argv: compact(argv),
      exit: function (code: number) {
        if (code !== 0) {
          console.error("Fatal Error. Unable to compile TypeScript file.");
        }
        exitCode = code;
      },
      // Wrap stdout.write()---only for this context
      stdout: {
        ...process.stdout,
        write: function () {
          logData.push(String(arguments[0]));
          process.stdout.write.apply(process.stdout, arguments as any);
        },
      },
      // Wrap stderr.write()---only for this context
      stderr: {
        ...process.stderr,
        write: function () {
          logData.push(String(arguments[0]));
          process.stderr.write.apply(process.stderr, arguments as any);
        },
      },
    });

    // Create the context for the compiler and run it // TODO: encoding
    vm.runInNewContext(fs.readFileSync(this._tscPath, "utf8"), {
      process: proc,
      require: require,
      module: module,
      Buffer: Buffer,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
      __filename: this._tscPath,
      __dirname: path.dirname(this._tscPath),
    });

    if (exitCode !== 0) {
      const e = new TscCompilerError(
        `Unable to compile TypeScript file. Please check it for errors.`,
        {
          inputFile: module.filename,
          outputFile: jsname,
          tscCli: tscCall,
        }
      );
      if (logData.length) {
        e.details.output = [logData.join("")];
      }
      if (options.tscConfigFilename) {
        e.details.tscConfigFilename = options.tscConfigFilename;
      }
      throw e;
    }

    return jsname;
  } // fn: compile

  /**
   * Run the Javascript module
   *
   * @param jsname name of the Javascript file
   * @param module Javqscript module
   * @returns The script result, if any
   */
  protected run(
    jsname: string,
    module: NodeJS.Module,
    src: string,
    globals: VmGlobals
  ): { [k: string]: unknown } {
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

  /**
   * Finds a copy of tsc
   *
   * @returns path to tsc
   */
  protected _findTsc(): string {
    // Try to use the project's tsc if it exists
    const tscPriority = this._projectPath
      ? [
          path.resolve(
            path.join(
              path.dirname(
                require.resolve("typescript", { paths: [this._projectPath] })
              ),
              "_tsc.js"
            )
          ),
          path.resolve(
            path.join(
              path.dirname(
                require.resolve("typescript", { paths: [this._projectPath] })
              ),
              "tsc.js"
            )
          ),
        ]
      : [];

    // Fallback: use NaNofuzz' included tsc
    tscPriority.push(
      path.resolve(
        path.join(path.dirname(require.resolve("typescript")), "_tsc.js")
      )
    );

    for (const tsc of tscPriority) {
      if (fs.existsSync(tsc)) {
        return tsc;
      }
    }

    throw new Error(
      `No copy of tsc found. Checked: ${JSON5.stringify(tscPriority, null, 2)}`
    );
  } // fn: _findTsc

  /**
   * Determine compiler options for the module's project
   */
  protected _determineOptions(): void {
    // Determine project's tsconfig.json
    this._tsconfigPath = findInAncestor(
      path.dirname(this._modulePath),
      tsconfigFilename
    );

    // Determine compiler options, tsconfig timestamp, and tsc using tsconfig.json
    if (this._tsconfigPath) {
      this._inferOptions(this._tsconfigPath);
      try {
        this._projectPath = path.resolve(path.dirname(this._tsconfigPath));
      } catch (e: unknown) {
        // it's fine: fallback to our extension's tsc
      }
    }
  } // fn: _determineOptions

  /**
   * Infer compiler settings from a tsconfig.json
   *
   * @param `tsConfigFilename` path to tsconfig.json
   */
  protected _inferOptions(tsConfigFilename: string): void {
    let tsConfigData: string;
    try {
      tsConfigData = fs.readFileSync(tsConfigFilename, { encoding: "utf8" }); // TODO: encoding
    } catch (e: unknown) {
      console.debug(`Unable to read: ${tsConfigFilename}`);
      return;
    }

    try {
      const tsConfig = JSON5.parse(tsConfigData);
      this._options.tscConfigFilename = tsConfigFilename;
      try {
        const projectDir = path.dirname(tsConfigFilename);

        if ("compilerOptions" in tsConfig) {
          // typeRoots
          if ("typeRoots" in tsConfig.compilerOptions) {
            this._options.typeRoots = tsConfig.compilerOptions.typeRoots.map(
              (e: string) =>
                // Replace relative paths because our cwd is not the project
                path.isAbsolute(e) ? e : path.resolve(path.join(projectDir, e))
            );
          } else {
            this._options.typeRoots = [
              path.resolve(path.join(projectDir, "node_modules", "@types")),
            ];
          }

          // types -- ignore types that do not exist in any root
          if ("types" in tsConfig.compilerOptions) {
            this._options.types = tsConfig.compilerOptions.types.filter(
              (t: string) =>
                this._options.typeRoots.some((tr) =>
                  fs.existsSync(path.resolve(path.join(tr, t)))
                )
            );
          }
          if (this._options.types.length === 0) {
            this._options.types = [""];
          }

          if ("lib" in tsConfig.compilerOptions) {
            this._options.lib = tsConfig.compilerOptions.lib;
          }

          if ("target" in tsConfig.compilerOptions) {
            this._options.target = String(tsConfig.compilerOptions.target);
          }

          if ("moduleResolution" in tsConfig.compilerOptions) {
            this._options.moduleResolution = String(
              tsConfig.compilerOptions.moduleResolution
            );
          }

          if ("baseUrl" in tsConfig.compilerOptions) {
            this._options.baseUrl = path.resolve(
              path.join(projectDir, String(tsConfig.compilerOptions.baseUrl))
            );
          } else {
            this._options.baseUrl = projectDir;
          }

          // TODO: there is more that we could infer here
        }
      } catch (e: unknown) {
        console.debug(
          `Unable to interpret settings from: ${tsConfigFilename}. Using default compilation options.`
        );
      }
    } catch (e: unknown) {
      console.debug(
        `Unable to parse: ${tsConfigFilename}. Using default compilation options.`
      );
    }
  } // fn: _inferOptions
} // class: TypeScriptCompiler

/**
 * Merge two objects
 */
function merge(a: any, b: any) {
  if (a && b) {
    for (const key in b) {
      a[key] = b[key];
    }
  }
  return a;
} // fn: merge

/**
 * Removes falsy items from array
 *
 * @param `arr` array
 * @returns new array with falsy items removed
 */
function compact<T>(arr: T[]) {
  const narr: T[] = [];
  arr.forEach(function (data) {
    if (data) narr.push(data);
  });
  return narr;
} // fn: compact

/**
 * Returns `dir`'s nearest item by traversing ancestor paths or `undefined` if not found.
 *
 * Adapted from: https://github.com/joshrtay/find-mod/blob/master/lib/index.js
 *
 * @param dir path
 * @param item file to find
 * @returns path to closest item (or exception if not found)
 */
function findInAncestor(dir: string, item: string): string | undefined {
  while (!fs.existsSync(path.resolve(path.join(dir, item)))) {
    dir = path.resolve(path.join(dir, "..")); // ascend to parent
    if (dir === path.dirname(dir)) {
      return undefined;
    }
  }
  return path.resolve(path.join(dir, item));
} // fn: findInAncestor

/**
 * Type of modulles to hook for compilation
 */
const hookType = ".ts";

/**
 * TypeScript config file
 */
const tsconfigFilename = "tsconfig.json";

/**
 * Default compilation options
 */
const defaultOptions: CompilerOptions = {
  nodeLib: false,
  target: "ES2020", // default to ES2020
  moduleKind: "commonjs", // required for running inside express
  emitOnError: false, // fail compilation in case of errors
  tmpDir: path.join(os.tmpdir(), "tsreq"), // path for compiled files
  lib: ["DOM", "ScriptHost", "ES2020"], // default to ES2020
  types: [""], // do not automatically import types
  typeRoots: [], // do not automatically import types
  baseUrl: "./",
  skipLibCheck: true,
  moduleResolution: "node",
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  allowJs: true,
  resolveJsonModule: true,
  traceResolution: false,
};

/**
 * Compiler Options
 */
export type CompilerOptions = {
  tscConfigFilename?: string;
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
