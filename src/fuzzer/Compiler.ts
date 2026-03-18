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
let _transpiledModules: { tsFile: string; tsFileDatetime: Date }[] = [];

/**
 * !!!!!!!
 */
export class TypeScriptCompiler {
  protected _tscPath: string; // Path to tsc
  protected _tscDatetime: Date; // tsc timestamp
  protected _modulePath: string; // Path to a module within a project
  protected _tsconfigPath?: string; // !!!!!!
  protected _tsconfigDatetime?: Date; // !!!!!!
  protected _projectPath?: string; // !!!!!!
  protected _options: CompilerOptions = defaultOptions; // !!!!!!
  protected _userOptions?: CompilerOptions; // !!!!!!

  /**
   * !!!!!!
   * @param modulePath fully-qualified module path from which to infer compiler settings
   */
  constructor(modulePath: string) {
    this._modulePath = modulePath;

    // Determine options using the module path
    this._options = JSON5.parse(JSON5.stringify(defaultOptions));
    this._determineOptions();

    // Determine tsc
    this._tscPath = this._determineTsc();
    this._tscDatetime = fs.statSync(this._tscPath).mtime;
  } // constructor

  /**
   * !!!!!!
   */
  protected _determineOptions(): void {
    // Determine project's tsconfig.json
    this._tsconfigDatetime = new Date(0);
    this._tsconfigPath = findInAncestor(
      path.dirname(this._modulePath),
      tsconfigFilename
    );

    // Determine compiler options, tsconfig timestamp, and tsc using tsconfig.json
    if (this._tsconfigPath) {
      this._tsconfigDatetime = fs.statSync(this._tsconfigPath).mtime;
      this.inferOptions(this._tsconfigPath);
      try {
        this._projectPath = path.resolve(path.dirname(this._tsconfigPath));
        this._tscDatetime = fs.statSync(this._tscPath).mtime;
      } catch (e: unknown) {
        // it's fine: fallback to our extension's tsc
      }
    }
  } // fn: _determineOptions

  /**
   * !!!!!!
   */
  protected _determineTsc(): string {
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

    // Default: NaNofuzz' included tsc
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
  } // fn: determineTsc

  /**
   * Set the compiler options
   *
   * @param opts CompilerOptions to set
   */
  set options(opts: CompilerOptions) {
    const optionsJson = JSON.stringify(opts);
    this._userOptions = JSON.parse(optionsJson);
    this._options = JSON.parse(optionsJson);
  } // set: options

  /**
   * Gets the current compiler options
   * @returns current set of compiler options
   */
  get options(): CompilerOptions {
    return JSON.parse(JSON.stringify(this._options));
  } // get: options

  /**
   * Infer compiler settings from a tsconfig.json
   */
  protected inferOptions(tsConfigFilename: string): void {
    // Don't re-determine options if the user provided them
    if (this._userOptions) {
      return;
    }

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
  } // !!!!!!

  /**
   * Compile the TypeScript file !!!!!!
   */
  public compile(
    fqModulePath: string,
    measures: AbstractMeasure[],
    update: (msg: FuzzBusyStatusMessage) => void
  ): ReturnType<NodeJS.Require> {
    // Make sure the file exists
    if (!fs.existsSync(fqModulePath)) {
      throw new Error(`Cannot find module to compile: ${fqModulePath}`);
    }

    // Invalidate the cache to compile the latest copy and
    // instrument it in a single context.
    delete require.cache[require.resolve(fqModulePath)];

    // Clear any previously-cached transpiled modules so that
    // we have a consistent global context for these modules.
    _transpiledModules.forEach((m) => {
      delete require.cache[m.tsFile];
    });
    _transpiledModules = [];

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
      // Transpile the Typescript file
      const jsname = this.tsc(module, update);

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

      // Add this module to the list of transpiled modules
      _transpiledModules.push({
        tsFile: module.filename,
        tsFileDatetime: fs.statSync(module.filename).mtime,
      });
    }; // end: require hook

    // Require the modules requested
    /* eslint eslint-comments/no-use: off */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(fqModulePath);

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
   * @returns true if the compilation is stale; false otherwise.
   */
  public isStale(): boolean {
    // If the user did not provide the options....
    if (!this._userOptions) {
      // and tsconfig was used for compilation options and is now stale
      if (
        this._tsconfigPath &&
        this._tsconfigDatetime !== fs.statSync(this._tsconfigPath).mtime
      ) {
        return true;
      }
      // and tsconfig was NOT used but now it exists
      if (
        !this._tsconfigPath &&
        findInAncestor(path.dirname(this._modulePath), tsconfigFilename)
      ) {
        return true;
      }
    }

    // Any of the compiled modules changed
    return _transpiledModules.some(
      (e) => fs.statSync(e.tsFile).mtime !== e.tsFileDatetime
    );
  } // fn: isStale

  /**
   * Compiles TypeScript file and returns js file path
   *
   * @return {string} js file path
   */
  protected tsc(
    module: NodeJS.Module,
    update: (msg: FuzzBusyStatusMessage) => void
  ): string {
    let exitCode = 0;

    // Determine the compiled name of the module we are about to compile
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

    // If the Javascript file is current, return it directly
    if (!this.isStale() && fs.existsSync(jsname)) {
      return jsname;
    }
    const options = this.options;

    // Provide feedback that we are compiling
    update({
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
}

/**
 * !!!!!!
 *
 * @param a
 * @param b
 * @returns
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
 * !!!!!!
 *
 * @param arr
 * @returns
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
  const firstDir = dir;
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
