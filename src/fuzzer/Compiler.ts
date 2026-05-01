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
import { Worker } from "worker_threads";
import path from "path";
import os from "os";
import JSON5 from "json5";
import { AbstractMeasure } from "./measures/AbstractMeasure";
import {
  FuzzBusyStatusMessage,
  TscCompilerError,
  TscCompilerErrorDetails,
  VmGlobals,
} from "./Types";
import * as ts from "typescript";

// Global list of compilations by entrypoint module
const _compilationsByModule: {
  [k: string]: string[];
} = {};

// Background worker
let compilerWorker: Worker | undefined = undefined;
let compileId = 0;

// Pending Worker Tasks
type TscFinishedCallback<T> = (value: T | PromiseLike<T>) => void;
const _pendingCompilations: {
  [k: number]: {
    resolve: TscFinishedCallback<void>;
    reject: TscFinishedCallback<void>;
  };
} = {};

/**
 * A TypeScript compiler wrapper for tsc.
 */
export class TypeScriptCompiler {
  protected _tscPath: string; // Path to tsc
  protected _tscVersion: string; // tsc version
  protected _moduleFile: string; // Path to a module within a project
  protected _tsconfigPath?: string; // Fully-qualified tsconfig.json path
  protected _projectPath?: string; // Directory of tsconfig.json
  protected _options: CompilerOptions = defaultOptions; // Compiler options

  constructor(fqModulePath: string) {
    this._moduleFile = fqModulePath;

    // Make sure the source file exists
    if (!fs.existsSync(fqModulePath)) {
      throw new Error(`Cannot find module to compile: ${fqModulePath}`);
    }

    // Determine tsc location & version
    this._tscPath = this._findTsc();
    this._tscVersion = this._findTscVersion(this._tscPath) ?? "unknown";
  } // constructor

  /**
   * Gets the current compiler options
   * @returns current set of compiler options
   */
  get options(): CompilerOptions {
    return JSON.parse(JSON.stringify(this._options));
  } // get: options

  /**
   * Compile a Typescript file in the background
   */
  public static async compileAsync(fqModulePath: string): Promise<void> {
    // If there's no compiler worker, create one
    if (!compilerWorker) {
      // Start compiler worker
      const workerPath = path.resolve(
        path.join(
          path.dirname(module.filename),
          "..",
          "..",
          "build",
          "workers",
          "CompilerWorker.js"
        )
      );
      compilerWorker = new Worker(workerPath, { name: "CompilerWorker" });

      // Handle messages from the worker
      compilerWorker.on(
        "message",
        (message: TypeScriptCompilerMessageFromWorker) => {
          switch (message.command) {
            case "compile.result":
              if (message.id in _pendingCompilations) {
                _pendingCompilations[message.id][
                  message.success ? "resolve" : "reject"
                ]();
                console.info(
                  `Background compilation# ${message.id} ${message.success ? "succeeded" : "failed"}`
                );
                delete _pendingCompilations[message.id];
              } else {
                throw new Error(
                  `No background compilation pending for ${message.id}`
                );
              }
          }
        }
      );
      compilerWorker.on("exit", (code) => {
        console.log(`CompilerWorker exited with code ${code}`);
        compilerWorker = undefined;
        Object.keys(_pendingCompilations).forEach((k) => {
          console.debug(`Auto-rejecting pending background compilation ${k}.`);
          _pendingCompilations[Number(k)].reject();
          delete _pendingCompilations[Number(k)];
        });
      });
    } // if: no compiler worker

    return new Promise<void>((resolve, reject) => {
      const message: TypeScriptCompilerMessageToWorker = {
        command: "compile",
        id: compileId++,
        module: fqModulePath,
      };
      _pendingCompilations[message.id] = { resolve, reject };
      if (compilerWorker) {
        compilerWorker.postMessage(message);
      } else {
        reject();
      }
    });
  } // fn: compileAsync

  /**
   * Compile the TypeScript file
   */
  public compileSync(
    measures: AbstractMeasure[],
    updateFn: (msg: FuzzBusyStatusMessage) => void
  ): ReturnType<NodeJS.Require> {
    // Determine options using the module path
    this._options = JSON5.parse<typeof defaultOptions>(
      JSON5.stringify(defaultOptions)
    );
    this._determineOptions();

    // Track local compilations
    const localCompilations: string[] = [];

    // Invalidate previously-cached project modules so that
    // we have a consistent global context for compiled modules.
    delete require.cache[require.resolve(this._moduleFile)];
    if (this._moduleFile in _compilationsByModule) {
      // We know which modules to invalidate
      Object.values(_compilationsByModule[this._moduleFile]).forEach((m) => {
        delete require.cache[m];
      });
    } else {
      // We don't know which modules to invalidate, so invalidate all
      // cache entries for the project
      for (const m in require.cache) {
        if (
          (m.endsWith(".ts") || m.endsWith(".js")) &&
          (this._projectPath === undefined || m.startsWith(this._projectPath))
        ) {
          delete require.cache[m];
        }
      }
    }

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

    // Save hook exceptions for re-throw outside the hook
    let hookException: unknown | undefined = undefined;

    // Hook require to compile ts files
    require.extensions[hookType] = async (module) => {
      const jsname = this._getJsFilename(module.filename);

      // Log the compile attempt
      localCompilations.push(module.filename);

      // If we throw a compiler exception in the hook within a
      // Worker, it kills the Worker. Save any exception thrown
      // and re-throw it outside the hook.
      if (hookException === undefined) {
        try {
          // Compile the Typescript file if the compiled output is stale
          const staleReason = this.isStale(module.filename);
          if (staleReason) {
            this._tsc(module, updateFn);
          }

          // Apply measurement instrumentation
          let src = fs.readFileSync(jsname, "utf8"); // TODO: encoding
          for (const measure of measures) {
            src = measure.onAfterCompile(src, jsname);
          }

          // Load the module & collect measurements from the initial load
          const context: VmGlobals = this.run(
            jsname,
            module,
            src,
            moduleVmGlobals
          );
          for (const measure of measures) {
            measure.onAfterLoad(context);
          }
        } catch (e: unknown) {
          // Save the exception and throw it outside the hook
          hookException = e;
        }
      }
    }; // end: require hook

    // Require the modules requested
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(this._moduleFile);

    // Unhook require
    require.extensions[hookType] =
      previousRequireExtensions[hookType] === undefined ||
      !previousRequireExtensions[hookType].length
        ? undefined
        : previousRequireExtensions[hookType].pop();

    // Finally, invalidate the cache and re-throw the hook exception
    if (hookException) {
      localCompilations.forEach((m) => delete require.cache[m]);
      throw hookException;
    }

    // Update the list of compilations
    if (!(this._moduleFile in _compilationsByModule) && !hookException) {
      _compilationsByModule[this._moduleFile] = localCompilations;
    }

    return mod;
  } // fn: compileSync

  /**
   * Creates a new record for the current compilation
   *
   * @param `moduleFile` module to compile
   * @returns compilation record
   */
  protected _newCompilationRecord(moduleFile: string): CompilationRecord {
    const jsFile = this._getJsFilename(moduleFile);
    return {
      fileVersion: CURR_COMPILATION_FILE_VER,
      details: {
        srcFile: moduleFile,
        srcDatetime: fs.statSync(moduleFile).mtime.toISOString(),
        jsFile: jsFile,
        jsDatetime: fs.statSync(jsFile).mtime.toISOString(),
        tsconfigFile: this._tsconfigPath,
        tsconfigDatetime: this._tsconfigPath
          ? fs.statSync(this._tsconfigPath).mtime.toISOString()
          : undefined,
        tscFile: this._tscPath,
        tscVersion: this._tscVersion,
        tscDatetime: fs.statSync(this._tscPath).mtime.toISOString(),
      },
    };
  } // fn: _newCompilationRecord

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
    // Stale: no compilations for this module have yet taken place
    if (
      !fs.existsSync(this._getJsFilename(this._moduleFile)) ||
      !fs.existsSync(this._getCompilationRecordFilename(this._moduleFile))
    ) {
      return "notcompiled";
    }

    // If no source file was provided, check all the compiled modules for changes
    const sourceFiles =
      inSrcFile === undefined
        ? [
            ...(this._moduleFile in _compilationsByModule
              ? _compilationsByModule[this._moduleFile]
              : [this._moduleFile]),
          ]
        : [inSrcFile];

    for (const sourceFile of sourceFiles) {
      // Retrieve detals of the prior compilation
      const compRec = this._getCompilationRecord(sourceFile);

      // Stale: No compilation record found
      if (compRec === undefined) {
        return "notcompiled";
      }

      // Stale: Compiled file does not exist
      if (!fs.existsSync(this._getJsFilename(sourceFile))) {
        return "notcompiled";
      }

      // Stale: Source file changed since prior compilation
      if (
        compRec.details.srcDatetime !==
        fs.statSync(sourceFile).mtime.toISOString()
      ) {
        return "sourcechanged";
      }

      // Stale: tsconfig changed since prior compilation
      if (
        compRec.details.tsconfigFile !== this._tsconfigPath ||
        (this._tsconfigPath &&
          (compRec.details.tsconfigDatetime ?? new Date(0).toISOString()) !==
            fs.statSync(this._tsconfigPath).mtime.toISOString())
      ) {
        return "configchanged";
      }

      // Stale: tsc changed since prior compilation
      if (
        compRec.details.tscFile !== this._tscPath ||
        compRec.details.tscDatetime !==
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
   * @param `module` node module
   * @param `updateFn` function for client status updates
   */
  protected _tsc(
    module: NodeJS.Module,
    updateFn: (msg: FuzzBusyStatusMessage) => void
  ): void {
    let exitCode = 0;

    // Determine the compiled name of the module
    const jsname = this._getJsFilename(module.filename);
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
      path.dirname(jsname),

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

      // We need these two options to map the compiled JS line
      // numbers back to the original TS line numbers.
      "--sourceMap",
      "--inlineSources",

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
      // Wrap stdout.write() for this context
      stdout: {
        ...process.stdout,
        write: function () {
          logData.push(String(arguments[0]));
          process.stdout.write.apply(process.stdout, arguments as any);
        },
      },
      // Wrap stderr.write() for this context
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

    // Write compilation record
    fs.writeFileSync(
      this._getCompilationRecordFilename(module.filename),
      JSON.stringify(this._newCompilationRecord(module.filename))
    );
  } // fn: _tsc

  /**
   * Returns the name of the compiled output file
   *
   * @param `moduleFile` module to compile
   * @returns filename of the compiled output file
   */
  protected _getJsFilename(moduleFile: string): string {
    const moduleDirName = path.dirname(moduleFile);
    const relativeFolder =
      "." +
      (moduleDirName.charAt(1) === ":"
        ? moduleDirName.substring(2)
        : moduleDirName);
    return path.resolve(
      path.join(
        this._options.tmpDir,
        relativeFolder,
        path.basename(moduleFile, ".ts") + ".js"
      )
    );
  } // fn: _getJsFilename

  /**
   * Returns the filename where compilation details are stored.
   *
   * @param `moduleFile` module to compile
   * @returns filename of compilation details
   */
  protected _getCompilationRecordFilename(moduleFile: string): string {
    return `${this._getJsFilename(moduleFile)}.comp.json`;
  } // fn: _getCompilationRecordFilename

  /**
   *
   * @param `moduleFile` module with the compilation record
   * @returns `undefined` if no record exists, otherwise the record.
   */
  protected _getCompilationRecord(
    moduleFile: string
  ): CompilationRecord | undefined {
    const compRecFile = this._getCompilationRecordFilename(moduleFile);
    try {
      const compRecRaw = JSON5.parse(fs.readFileSync(compRecFile).toString());
      if (
        typeof compRecRaw === "object" &&
        !Array.isArray(compRecRaw) &&
        compRecRaw !== null &&
        "fileVersion" in compRecRaw &&
        compRecRaw.fileVersion === CURR_COMPILATION_FILE_VER &&
        "details" in compRecRaw &&
        typeof compRecRaw.details === "object" &&
        !Array.isArray(compRecRaw.details) &&
        compRecRaw.details !== null &&
        "srcFile" in compRecRaw.details &&
        typeof compRecRaw.details.srcFile === "string" &&
        "srcDatetime" in compRecRaw.details &&
        typeof compRecRaw.details.srcDatetime === "string" &&
        "jsFile" in compRecRaw.details &&
        typeof compRecRaw.details.jsFile === "string" &&
        "jsDatetime" in compRecRaw.details &&
        typeof compRecRaw.details.jsDatetime === "string" &&
        "tscFile" in compRecRaw.details &&
        typeof compRecRaw.details.tscFile === "string" &&
        "tscVersion" in compRecRaw.details &&
        typeof compRecRaw.details.tscVersion === "string" &&
        "tscDatetime" in compRecRaw.details &&
        typeof compRecRaw.details.tscDatetime === "string" &&
        (!("tsconfigFile" in compRecRaw.details) ||
          typeof compRecRaw.details.tsconfigFile === "string") &&
        (!("tsconfigDatetime" in compRecRaw.details) ||
          typeof compRecRaw.details.tsconfigDatetime === "string")
      ) {
        return compRecRaw;
      }
    } catch (_e: unknown) {
      // it's fine if we can't load the file
    }
    return undefined;
  } // fn: _getCompilationRecord

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
   * Returns the tsc version number
   *
   * @param `tscPath` path and filename of tsc script
   * @returns tsc version number as a string if found; otherwise, `undefined`
   */
  protected _findTscVersion(tscPath: string): string | undefined {
    const packageJson = findInAncestor(path.dirname(tscPath), "package.json");
    if (packageJson) {
      try {
        const packageJsonData: unknown = JSON5.parse<unknown>(
          fs.readFileSync(packageJson).toString()
        );
        return packageJsonData !== null &&
          typeof packageJsonData === "object" &&
          !Array.isArray(packageJsonData) &&
          "version" in packageJsonData &&
          typeof packageJsonData.version === "string"
          ? packageJsonData.version // return version string
          : undefined; // unknown version
      } catch {
        console.info(
          `Unable to read tsc version from its package.json: ${packageJson}`
        );
        return undefined;
      }
    } else {
      console.info(`Unable to find package.json for tsc at: ${packageJson}`);
      return undefined;
    }
  } // fn: _findTscVersion

  /**
   * Determine compiler options for the module's project
   */
  protected _determineOptions(): void {
    // Determine project's tsconfig.json
    this._tsconfigPath = findInAncestor(
      path.dirname(this._moduleFile),
      tsconfigFilename
    );

    // Determine compiler options, tsconfig timestamp, and tsc using tsconfig.json
    if (this._tsconfigPath) {
      this._inferOptions(this._tsconfigPath);
      try {
        this._projectPath = path.resolve(path.dirname(this._tsconfigPath));
      } catch (_e: unknown) {
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
    } catch (_e: unknown) {
      console.debug(`Unable to read: ${tsConfigFilename}`);
      return;
    }

    try {
      const tsConfig: unknown = JSON5.parse(tsConfigData);
      this._options.tscConfigFilename = tsConfigFilename;
      try {
        const projectDir = path.dirname(tsConfigFilename);

        if (
          tsConfig !== null &&
          typeof tsConfig === "object" &&
          !Array.isArray(tsConfig) &&
          "compilerOptions" in tsConfig &&
          tsConfig.compilerOptions !== null &&
          typeof tsConfig.compilerOptions === "object" &&
          !Array.isArray(tsConfig.compilerOptions)
        ) {
          // typeRoots
          if (
            "typeRoots" in tsConfig.compilerOptions &&
            tsConfig.compilerOptions.typeRoots !== null &&
            typeof tsConfig.compilerOptions.typeRoots === "object" &&
            Array.isArray(tsConfig.compilerOptions.typeRoots)
          ) {
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
          if (
            "types" in tsConfig.compilerOptions &&
            tsConfig.compilerOptions.types !== null &&
            typeof tsConfig.compilerOptions.types === "object" &&
            Array.isArray(tsConfig.compilerOptions.types)
          ) {
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

          if (
            "lib" in tsConfig.compilerOptions &&
            tsConfig.compilerOptions.lib !== null &&
            typeof tsConfig.compilerOptions.lib === "object" &&
            Array.isArray(tsConfig.compilerOptions.lib)
          ) {
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
      } catch (_e: unknown) {
        console.debug(
          `Unable to interpret settings from: ${tsConfigFilename}. Using default compilation options.`
        );
      }
    } catch (_e: unknown) {
      console.debug(
        `Unable to parse: ${tsConfigFilename}. Using default compilation options.`
      );
    }
  } // fn: _inferOptions

  /**
   * Clears compilation temp files
   */
  public clean(): void {
    if (fs.existsSync(this.options.tmpDir)) {
      console.info(`Removing temp files: ${this.options.tmpDir}`);
      fs.rmSync(this.options.tmpDir, { recursive: true });
    }
  } // fn: clean

  /**
   * Transpiles TypeScript source to Javascript in memory
   * without requiring objects on the file system.
   *
   * @param `tsSrc` TypeScript source to compile
   * @param `userOpts` tsc options
   * @param `filename` optional filename
   * @returns Javascript source
   */
  public static compileInMemory(
    tsSrc: string,
    userOpts: ts.TranspileOptions = {},
    filename?: string
  ): string {
    const defaultCompilerOptions: ts.CompilerOptions = {
      ...defaultOptions,
      target: ts.ScriptTarget.ES2020,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const opts = {
      compilerOptions: {
        ...defaultCompilerOptions,
        ...userOpts.compilerOptions,
      },
      filename,
      ...userOpts,
    };
    const result = ts.transpileModule(tsSrc, opts);
    if (result.diagnostics && result.diagnostics.length) {
      throw new Error(
        `Compilation failed for ts source. Diagnostics: ${JSON5.stringify(result.diagnostics, null, 2)}`
      );
    }
    return result.outputText;
  } // fn: compileInMemory
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
  moduleKind: "nodenext", // cjs is required for running inside express
  emitOnError: false, // fail compilation in case of errors
  tmpDir: path.join(os.tmpdir(), "nanofuzz", "tsc"), // path for compiled files
  lib: ["DOM", "ScriptHost", "ES2020"], // default to ES2020
  types: [""], // do not automatically import types
  typeRoots: [], // do not automatically import types
  baseUrl: "./",
  skipLibCheck: true,
  moduleResolution: "nodenext",
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

/**
 * Record of compilation, including tsc
 */
type CompilationRecord = {
  fileVersion: string;
  details: {
    srcFile: string;
    srcDatetime: string; // ISODateString
    jsFile: string;
    jsDatetime: string; // ISODateString
    tsconfigFile?: string;
    tsconfigDatetime?: string; // ISODateString
    tscFile: string;
    tscVersion: string;
    tscDatetime: string; // ISODateString
  };
};

/**
 * Messages from the Compiler to its worker
 */
export type TypeScriptCompilerMessageToWorker =
  | {
      command: "compile";
      id: number;
      module: string;
    }
  | {
      command: "exit";
    };

/**
 * Messages from the worker to the Compiler
 */
export type TypeScriptCompilerMessageFromWorker = {
  command: "compile.result";
  id: number;
} & (
  | { success: true }
  | ({ success: false } & Partial<TscCompilerErrorDetails>)
);

// Version of the compilation record file
const CURR_COMPILATION_FILE_VER = "0.3.9"; // !!!
