import * as fs from "node:fs";
import * as JSONN from "../Jsonn";
import * as Config from "../Config";
import { getIoKey } from "./Util";
import {
  removeTickFromOrigin,
  isKeyedObject,
  decodeEscapeSequences,
} from "../Util";
import {
  FuzzArgOverride,
  FuzzOptions,
  FuzzPinnedTest,
  FuzzTests,
  FuzzTestsFunction,
} from "./Types";
import * as TestAdapterFactory from "./adapters/TestAdapterFactory";
import { ArgDef } from "./analysis/ArgDef";
import { FunctionDef } from "./analysis/FunctionDef";
import { ArgOptions, ArgTag, Interval } from "./analysis/Types";

/**
 * Centralized store for reading, migrating, upgrading, updating, and saving
 * .nano.json5 configuration and pinned test files.
 */
export class FuzzConfigStore {
  public static readonly CURR_FILE_FMT_VER: string = "0.4.0";

  /**
   * Returns the companion .nano.json5 filename for a source module.
   *
   * @param sourcePath Path to the source file (e.g. src/math.ts)
   * @returns Path to the .nano.json5 file
   */
  public static getNanoFilename(sourcePath: string): string {
    if (sourcePath.endsWith(".nano.json5")) {
      return sourcePath;
    }
    return `${sourcePath}.nano.json5`;
  } // fn: getNanoFilename

  /**
   * Returns the legacy v0.1-0.3 filename (.nano.test.json) for a source module.
   *
   * @param sourcePath Path to the source file
   * @returns Path to the legacy .nano.test.json file
   */
  public static getLegacyNanoFilename(sourcePath: string): string {
    const base = sourcePath.split(".").slice(0, -1).join(".") || sourcePath;
    return `${base}.nano.test.json`;
  } // fn: getLegacyNanoFilename

  /**
   * Migrates legacy .nano.test.json file to .nano.json5 if it exists.
   *
   * @param sourcePath Path to the source file
   * @returns true if migration occurred, false otherwise
   */
  public static migrateLegacyNanoFile(sourcePath: string): boolean {
    const oldFile = FuzzConfigStore.getLegacyNanoFilename(sourcePath);
    const newFile = FuzzConfigStore.getNanoFilename(sourcePath);

    if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
      fs.renameSync(oldFile, newFile);
      console.info(`Moved test set in file ${oldFile} to ${newFile}`);
      return true;
    }
    return false;
  } // fn: migrateLegacyNanoFile

  /**
   * Checks whether a .nano.json5 file (or legacy file) exists for the given source file.
   *
   * @param sourcePath Path to the source file
   * @returns true if configuration file exists
   */
  public static exists(sourcePath: string): boolean {
    const newFile = FuzzConfigStore.getNanoFilename(sourcePath);
    if (fs.existsSync(newFile)) {
      return true;
    }
    const oldFile = FuzzConfigStore.getLegacyNanoFilename(sourcePath);
    return fs.existsSync(oldFile);
  } // fn: exists

  /**
   * Returns a default set of fuzzer options with values loaded from configuration.
   *
   * @returns complete default FuzzOptions
   */
  public static getDefaultFuzzOptions(): FuzzOptions {
    return {
      outputResults: "all",
      argDefaults: ArgDef.getDefaultOptions(),
      maxTests: Config.get("nanofuzz.fuzzer.maxTests", 1000),
      fnTimeout: Config.get("nanofuzz.fuzzer.fnTimeout", 100),
      suiteTimeout: Config.get("nanofuzz.fuzzer.suiteTimeout", 3000),
      maxDupeInputs: Config.get("nanofuzz.fuzzer.maxDupeInputs", 500),
      maxFailures: Config.get("nanofuzz.fuzzer.maxFailures", 0),
      useTransformer: true,
      useHuman: true,
      useImplicit: true,
      useProperty: false,
      measures: {
        FailedTestMeasure: {
          enabled: true,
          weight: 1,
        },
        CoverageMeasure: {
          enabled: true,
          weight: 1,
        },
      },
      generators: {
        RandomInputGenerator: {
          enabled: true,
        },
        MutationInputGenerator: {
          enabled: true,
        },
        AiInputGenerator: {
          enabled: false,
        },
        UserInputGenerator: {
          enabled: true,
        },
      },
    };
  } // fn: getDefaultFuzzOptions

  /**
   * Normalizes a FuzzOptions object by deeply populating missing fields with default options.
   *
   * @param options partial fuzzer options
   * @returns a complete, normalized FuzzOptions object
   */
  public static normalizeFuzzOptions(
    options?: Partial<FuzzOptions>
  ): FuzzOptions {
    const dft = FuzzConfigStore.getDefaultFuzzOptions();
    if (!options) return dft;
    return {
      ...dft,
      ...options,
      outputResults: options.outputResults ?? "all",
      argDefaults: ArgDef.normalizeOptions(options.argDefaults),
      generators: options.generators
        ? { ...dft.generators, ...options.generators }
        : dft.generators,
      measures: options.measures
        ? { ...dft.measures, ...options.measures }
        : dft.measures,
    };
  } // fn: normalizeFuzzOptions

  /**
   * Creates an empty FuzzTests structure initialized with current format version.
   *
   * @param version Format version string (default: CURR_FILE_FMT_VER)
   * @returns empty FuzzTests structure
   */
  public static createEmptyFuzzTests(
    version: string = CURR_FILE_FMT_VER
  ): FuzzTests {
    return {
      version,
      functions: {},
    };
  } // fn: createEmptyFuzzTests

  /**
   * Creates a default FuzzTestsFunction structure for a given function.
   *
   * @param fnName Name of the function
   * @param overrides Optional field overrides
   * @returns FuzzTestsFunction structure
   */
  public static createDefaultFunctionConfig(
    fnName: string,
    overrides?: Partial<FuzzTestsFunction>
  ): FuzzTestsFunction {
    return {
      options: FuzzConfigStore.getDefaultFuzzOptions(),
      argOverrides: [],
      validators: [],
      userGenerators: [],
      tests: {},
      isVoid: false,
      ...overrides,
    };
  } // fn: createDefaultFunctionConfig

  /**
   * Removes tests from a test set that are neither pinned nor have an expected output.
   *
   * @param testSet unpruned test set
   * @returns pruned copy of test set
   */
  public static prune(testSet: FuzzTests): FuzzTests {
    const prunedTestSet = structuredClone(testSet);
    for (const fn in prunedTestSet.functions) {
      for (const test in prunedTestSet.functions[fn].tests) {
        const thisTest = prunedTestSet.functions[fn].tests[test];
        if (!thisTest.pinned && thisTest.expectedOutput === undefined) {
          delete prunedTestSet.functions[fn].tests[test];
        }
      }
    }
    return prunedTestSet;
  } // fn: prune

  /**
   * Upgrades a parsed raw JSON object from an older schema version to current format.
   *
   * @param inputTests Raw parsed JSON data
   * @param jsonFile Path to the JSON file (for error reporting)
   * @returns Migrated and upgraded FuzzTests structure
   */
  public static upgrade(inputTests: unknown, jsonFile: string): FuzzTests {
    const toolName = Config.get("nanofuzz.name", "NaNofuzz");
    let currentData = inputTests;
    let testSet: FuzzTests;

    if (
      !currentData ||
      typeof currentData !== "object" ||
      !isKeyedObject(currentData)
    ) {
      return FuzzConfigStore.createEmptyFuzzTests();
    }

    while (
      typeof currentData === "object" &&
      isKeyedObject(currentData) &&
      currentData.version !== CURR_FILE_FMT_VER
    ) {
      if (!("version" in currentData)) {
        // v0.1.0 format -- convert to current format
        testSet = FuzzConfigStore.createEmptyFuzzTests();
        for (const [fnName, tests] of Object.entries(currentData)) {
          if (isKeyedObject(tests)) {
            const fnConfig =
              FuzzConfigStore.createDefaultFunctionConfig(fnName);
            for (const [k, v] of Object.entries(tests)) {
              if (isKeyedObject(v)) {
                fnConfig.tests[k] = toPinnedTest(v);
              }
            }
            testSet.functions[fnName] = fnConfig;
          }
        }
        console.info(
          `Upgraded test set in file ${jsonFile} from v0.1.0 to current version`
        );
        currentData = testSet;
      } else {
        const ver = currentData.version;
        switch (ver) {
          case "0.2.0": {
            // v0.2.0 format -- add maxFailures and onlyFailure options
            const functions = isKeyedObject(currentData.functions)
              ? currentData.functions
              : {};
            for (const fn in functions) {
              const fnObj = functions[fn];
              if (isKeyedObject(fnObj)) {
                const options = isKeyedObject(fnObj.options)
                  ? fnObj.options
                  : {};
                options.maxFailures = 0;
                options.useHuman = true;
                options.useImplicit = true;
                fnObj.options = options;
              }
            }
            currentData = {
              ...currentData,
              version: "0.2.1",
              functions,
            };
            console.info(
              `Upgraded test set in file ${jsonFile} from 0.2.0 to 0.2.1`
            );
            break;
          }
          case "0.2.1": {
            // v0.2.1 format -- infer useProperty option & turn on useHuman
            const functions = isKeyedObject(currentData.functions)
              ? currentData.functions
              : {};
            for (const fn in functions) {
              const fnObj = functions[fn];
              if (isKeyedObject(fnObj)) {
                const options = isKeyedObject(fnObj.options)
                  ? fnObj.options
                  : {};
                options.useProperty = "validator" in fnObj;
                options.useHuman = true;
                fnObj.options = options;
              }
            }
            currentData = {
              ...currentData,
              version: "0.3.0",
              functions,
            };
            console.info(
              `Upgraded test set in file ${jsonFile} from 0.2.1 to 0.3.0`
            );
            break;
          }
          case "0.3.0": {
            // v0.3.0 format -- infer arg strCharset override from function default
            const functions = isKeyedObject(currentData.functions)
              ? currentData.functions
              : {};
            for (const fn in functions) {
              const thisFn = functions[fn];
              if (isKeyedObject(thisFn)) {
                const argOverrides = thisFn.argOverrides;
                const options = thisFn.options;
                if (
                  isKeyedObject(argOverrides) &&
                  isKeyedObject(options) &&
                  isKeyedObject(options.argDefaults) &&
                  typeof options.argDefaults.strCharset === "string"
                ) {
                  const dftCharset = options.argDefaults.strCharset;
                  for (const i in argOverrides) {
                    const arg = argOverrides[i];
                    if (
                      isKeyedObject(arg) &&
                      isKeyedObject(arg.string) &&
                      !arg.string.strCharset
                    ) {
                      arg.string.strCharset = dftCharset;
                    }
                  }
                }
              }
            }
            currentData = {
              ...currentData,
              version: "0.3.3",
              functions,
            };
            console.info(
              `Upgraded test set in file ${jsonFile} from 0.3.0 to 0.3.3`
            );
            break;
          }
          case "0.3.3": {
            // v0.3.3 format -- additions like isVoid, literal types; maxDupeInputs check
            const functions = isKeyedObject(currentData.functions)
              ? currentData.functions
              : {};
            for (const fn in functions) {
              const fnObj = functions[fn];
              if (isKeyedObject(fnObj)) {
                const thisOpt = isKeyedObject(fnObj.options)
                  ? fnObj.options
                  : {};
                if (
                  !("maxDupeInputs" in thisOpt) ||
                  thisOpt.maxDupeInputs === undefined ||
                  typeof thisOpt.maxDupeInputs !== "number" ||
                  isNaN(thisOpt.maxDupeInputs)
                ) {
                  thisOpt.maxDupeInputs = Config.get(
                    "nanofuzz.fuzzer.maxDupeInputs",
                    500
                  );
                }
                fnObj.options = thisOpt;
              }
            }
            currentData = {
              ...currentData,
              version: "0.3.6",
              functions,
            };
            console.info(
              `Upgraded test set in file ${jsonFile} from 0.3.3 to 0.3.6`
            );
            break;
          }
          case "0.3.6": {
            // v0.3.6 format -- add measures and generators, re-key saved inputs
            const functions = isKeyedObject(currentData.functions)
              ? currentData.functions
              : {};
            for (const fn in functions) {
              const thisFn = functions[fn];
              if (isKeyedObject(thisFn)) {
                const existingOpt = isKeyedObject(thisFn.options)
                  ? thisFn.options
                  : {};
                thisFn.options = {
                  ...FuzzConfigStore.getDefaultFuzzOptions(),
                  ...existingOpt,
                  measures: FuzzConfigStore.getDefaultFuzzOptions().measures,
                  generators:
                    FuzzConfigStore.getDefaultFuzzOptions().generators,
                  useTransformer: true,
                };

                const oldTestSet = isKeyedObject(thisFn.tests)
                  ? thisFn.tests
                  : {};
                const newTestSet: Record<string, FuzzPinnedTest> = {};
                for (const oldKey in oldTestSet) {
                  const oldTestRaw = oldTestSet[oldKey];
                  if (isKeyedObject(oldTestRaw)) {
                    const oldTest = toPinnedTest(oldTestRaw);
                    const newKey = getIoKey(oldTest.input);
                    newTestSet[newKey] = {
                      ...oldTest,
                      input: oldTest.input.map((input) => ({
                        ...input,
                        origin: {
                          type: "generator",
                          generator: "RandomInputGenerator",
                        },
                      })),
                      output: oldTest.output.map((output) => ({
                        ...output,
                        origin: { type: "put" },
                      })),
                      ...(oldTest.expectedOutput !== undefined
                        ? {
                            expectedOutput: oldTest.expectedOutput.map(
                              (eo) => ({
                                ...eo,
                                origin: { type: "user" },
                              })
                            ),
                          }
                        : {}),
                    };
                  }
                }
                thisFn.tests = newTestSet;
              }
            }
            currentData = {
              ...currentData,
              version: "0.4.0",
              functions,
            };
            console.info(
              `Upgraded test set in file ${jsonFile} from 0.3.6 to 0.4.0`
            );
            break;
          }
          case "0.3.9": {
            // Test version; alias for 0.4.0
            currentData = {
              ...currentData,
              version: "0.4.0",
            };
            break;
          }
          default: {
            throw new Error(
              `Unknown version ${String(ver)} in test file ${jsonFile}. Update your ${toolName} extension or delete/rename the file to continue.`
            );
          }
        }
      }
    }

    return FuzzConfigStore.prune(cast<FuzzTests>(currentData));
  } // fn: upgrade

  /**
   * Loads and upgrades the FuzzTests configuration for an entire source module.
   *
   * @param sourcePath Path to the source file
   * @returns FuzzTests structure
   */
  public static loadForModule(sourcePath: string): FuzzTests {
    FuzzConfigStore.migrateLegacyNanoFile(sourcePath);
    const jsonFile = FuzzConfigStore.getNanoFilename(sourcePath);

    if (!fs.existsSync(jsonFile)) {
      return FuzzConfigStore.createEmptyFuzzTests();
    }

    try {
      const raw = fs.readFileSync(jsonFile, "utf8");
      const parsed = JSONN.parse<unknown>(raw);
      return FuzzConfigStore.upgrade(parsed, jsonFile);
    } catch (_e: unknown) {
      return FuzzConfigStore.createEmptyFuzzTests();
    }
  } // fn: loadForModule

  /**
   * Loads the configuration and pinned tests for a specific function within a module.
   *
   * @param sourcePath Path to the source file
   * @param fnName Name of the function
   * @param defaultOptions Optional default options to use if function is not yet configured
   * @returns FuzzTestsFunction configuration
   */
  public static loadForFunction(
    sourcePath: string,
    fnName: string,
    defaultOptions?: Partial<FuzzOptions>
  ): FuzzTestsFunction {
    const moduleSet = FuzzConfigStore.loadForModule(sourcePath);

    if (fnName in moduleSet.functions) {
      const fnSet = moduleSet.functions[fnName];
      if (fnSet.options) {
        fnSet.options = FuzzConfigStore.normalizeFuzzOptions(fnSet.options);
      }
      return fnSet;
    }

    return FuzzConfigStore.createDefaultFunctionConfig(fnName, {
      options: defaultOptions
        ? FuzzConfigStore.normalizeFuzzOptions(defaultOptions)
        : FuzzConfigStore.getDefaultFuzzOptions(),
    });
  } // fn: loadForFunction

  /**
   * Persists a FuzzTests structure to disk and syncs the associated CI test file (Jest/Pytest).
   *
   * @param sourcePath Path to the source file
   * @param testSet Complete FuzzTests structure
   * @param options Save options (syncTestAdapter, onError)
   */
  public static saveForModule(
    sourcePath: string,
    testSet: FuzzTests,
    options?: SaveFuzzConfigOptions
  ): void {
    const jsonFile = FuzzConfigStore.getNanoFilename(sourcePath);
    const prunedTestSet = FuzzConfigStore.prune(testSet);

    try {
      fs.writeFileSync(jsonFile, JSONN.stringify(prunedTestSet));
    } catch (e: unknown) {
      if (options?.onError) {
        options.onError(e);
      } else {
        throw e;
      }
    }

    if (options?.syncTestAdapter !== false) {
      let pinnedCount = 0;
      Object.values(prunedTestSet.functions).forEach((fn) => {
        pinnedCount += Object.values(fn.tests).filter((t) => t.pinned).length;
      });

      try {
        const testAdapter = TestAdapterFactory.fromSourceFilename(
          sourcePath,
          prunedTestSet
        );

        if (pinnedCount > 0) {
          const generatedTests = testAdapter.toString();
          fs.writeFileSync(testAdapter.filename, generatedTests);
        } else if (fs.existsSync(testAdapter.filename)) {
          fs.rmSync(testAdapter.filename);
        }
      } catch (e: unknown) {
        if (options?.onError) {
          options.onError(e);
        } else {
          console.error(`Failed to sync test adapter for ${sourcePath}:`, e);
        }
      }
    }
  } // fn: saveForModule

  /**
   * Persists configuration for a specific function within a module.
   *
   * @param sourcePath Path to the source file
   * @param fnName Name of the function
   * @param fnSet Function configuration and tests
   * @param options Save options
   */
  public static saveForFunction(
    sourcePath: string,
    fnName: string,
    fnSet: FuzzTestsFunction,
    options?: SaveFuzzConfigOptions
  ): void {
    const moduleSet = FuzzConfigStore.loadForModule(sourcePath);
    moduleSet.functions[fnName] = fnSet;
    FuzzConfigStore.saveForModule(sourcePath, moduleSet, options);
  } // fn: saveForFunction

  /**
   * Updates (adds, modifies, or deletes) a pinned test for a function and persists changes.
   *
   * @param sourcePath Path to the source file
   * @param fnName Name of the function
   * @param test Pinned test to update
   * @param options Save options
   */
  public static updatePinnedTest(
    sourcePath: string,
    fnName: string,
    test: FuzzPinnedTest,
    options?: SaveFuzzConfigOptions
  ): void {
    const fnSet = FuzzConfigStore.loadForFunction(sourcePath, fnName);
    const currInputsJson = getIoKey(test.input);

    if (
      currInputsJson in fnSet.tests &&
      !test.pinned &&
      test.expectedOutput === undefined
    ) {
      delete fnSet.tests[currInputsJson];
    } else {
      fnSet.tests[currInputsJson] = {
        ...test,
        output: [],
        input: test.input.map((i) => ({
          ...i,
          origin: removeTickFromOrigin(i.origin),
        })),
      };
    }

    return FuzzConfigStore.saveForFunction(sourcePath, fnName, fnSet, options);
  } // fn: updatePinnedTest

  /**
   * Applies a set of argument overrides (e.g., from .nano.json5 or UI) to a
   * function's argument definitions.
   *
   * @param fn Function under test
   * @param argOverrides Overrides for default argument options
   * @param argDefaults Default argument generation options
   */
  public static applyArgOverrides(
    fn: FunctionDef,
    argOverrides: FuzzArgOverride[] = [],
    argDefaults: ArgOptions = ArgDef.getDefaultOptions()
  ): void {
    const argsFlat = fn.getArgDefsFlat();

    for (const i in argOverrides) {
      if (Number(i) >= argsFlat.length) {
        break;
      }
      const thisOverride = argOverrides[i];
      const thisArg: ArgDef = argsFlat[i];

      switch (thisArg.getType()) {
        case ArgTag.NUMBER:
          if (thisOverride.number) {
            thisArg.setIntervals([
              {
                min: Number(thisOverride.number.min),
                max: Number(thisOverride.number.max),
              },
            ]);
            thisArg.setOptions({
              numInteger: Boolean(thisOverride.number.numInteger),
            });
          }
          break;

        case ArgTag.BIGINT:
          if (thisOverride.bigInt) {
            thisArg.setIntervals([
              {
                min: thisOverride.bigInt.min,
                max: thisOverride.bigInt.max,
              },
            ]);
          }
          break;

        case ArgTag.BOOLEAN:
          if (thisOverride.boolean) {
            thisArg.setIntervals([
              {
                min: Boolean(thisOverride.boolean.min),
                max: Boolean(thisOverride.boolean.max),
              },
            ]);
          }
          break;

        case ArgTag.STRING:
          if (thisOverride.string) {
            thisArg.setOptions({
              strLength: {
                min: Number(thisOverride.string.minStrLen),
                max: Number(thisOverride.string.maxStrLen),
              },
              strCharset:
                thisOverride.string.strCharset === ""
                  ? argDefaults.strCharset
                  : decodeEscapeSequences(thisOverride.string.strCharset),
              strRegex: thisOverride.string.strRegex,
            });
          }
          break;

        case ArgTag.BYTES:
          if (thisOverride.bytes) {
            thisArg.setOptions({
              byteLength: {
                min: Number(thisOverride.bytes.minByteLen),
                max: Number(thisOverride.bytes.maxByteLen),
              },
            });
          }
          break;

        case ArgTag.DICTIONARY:
          if (thisOverride.dictionary) {
            thisArg.setOptions({
              dictLength: {
                min: Number(thisOverride.dictionary.minDictLen),
                max: Number(thisOverride.dictionary.maxDictLen),
              },
            });
          }
          break;

        case ArgTag.SET:
          if (thisOverride.set) {
            thisArg.setOptions({
              setLength: {
                min: Number(thisOverride.set.minSetLen),
                max: Number(thisOverride.set.maxSetLen),
              },
            });
          }
          break;

        case ArgTag.OBJECT:
        case ArgTag.LITERAL:
        case ArgTag.UNION:
        case ArgTag.TUPLE:
        case ArgTag.UNRESOLVED:
          break;
      }

      thisArg.setOptions({
        isNoInput: thisOverride.isNoInput ?? false,
      });

      if (thisOverride.array) {
        thisOverride.array.dimLength.forEach((e: Interval<number>) => {
          if (!(typeof e === "object" && "min" in e && "max" in e)) {
            throw new Error(
              `Invalid interval for array dimensions: ${JSONN.stringify(e)}`
            );
          }
        });
        thisArg.setOptions({
          dimLength: thisOverride.array.dimLength,
          dimsUnique: Boolean(thisOverride.array.dimsUnique),
        });
      }
    }
  } // fn: applyArgOverrides
} // class: FuzzConfigStore

// -------------------------------------------------------------------------- //
// Constants, Type Definitions & Helper Functions
// -------------------------------------------------------------------------- //

/**
 * Current file format version for persisting test sets / pinned test cases
 */
export const CURR_FILE_FMT_VER = FuzzConfigStore.CURR_FILE_FMT_VER;

/**
 * Options when saving fuzz configurations
 */
export type SaveFuzzConfigOptions = {
  syncTestAdapter?: boolean;
  onError?: (error: unknown) => void;
};

function cast<T>(val: unknown): T;
function cast(val: unknown): unknown {
  return val;
} // fn: cast()

/**
 * Converts a raw object to a FuzzPinnedTest structure safely.
 *
 * @param obj raw input object
 * @returns FuzzPinnedTest structure
 */
function toPinnedTest(obj: Record<string, unknown>): FuzzPinnedTest {
  const input = Array.isArray(obj.input)
    ? cast<FuzzPinnedTest["input"]>(obj.input)
    : [];
  const output = Array.isArray(obj.output)
    ? cast<FuzzPinnedTest["output"]>(obj.output)
    : [];
  const pinned = typeof obj.pinned === "boolean" ? obj.pinned : true;
  const expectedOutput = Array.isArray(obj.expectedOutput)
    ? cast<FuzzPinnedTest["expectedOutput"]>(obj.expectedOutput)
    : undefined;

  return {
    input,
    output,
    pinned,
    ...(expectedOutput !== undefined ? { expectedOutput } : {}),
  };
} // fn: toPinnedTest()
