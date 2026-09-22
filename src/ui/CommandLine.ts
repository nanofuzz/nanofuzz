// Enable Node.js compile cache if supported by Node runtime (Node 22.8+)
import moduleApi from "node:module";
if (
  "enableCompileCache" in moduleApi &&
  typeof moduleApi.enableCompileCache === "function"
) {
  moduleApi.enableCompileCache();
}
import * as Commander from "commander";
import * as Config from "../Config";
import * as fs from "node:fs";
import { SingleBar, Presets } from "cli-progress";
import * as ParserAdapter from "../fuzzer/adapters/ParserAdapter";
import { ArgDef, FuzzBusyStatusMessage, Tester } from "../fuzzer/Fuzzer";
import * as CompilerFactory from "../fuzzer/compilers/CompilerFactory";
import * as ProgramFactory from "../fuzzer/analysis/ProgramFactory";
import { FuzzOptions } from "../fuzzer/Types";
import { parseCoverageScope } from "../fuzzer/measures/Util";
import path from "node:path";
import * as JSONN from "../Jsonn";
import { isError } from "../fuzzer/Util";
import { LlmAdapter } from "../fuzzer/adapters/LlmAdapter";
import { FuzzPinnedTest, FuzzTests } from "../fuzzer/Types";
import pkg from "../../package.json";

const nanofuzzVersion = process.env.NANOFUZZ_VERSION ?? pkg.version;

/**
 * Command line interface for NaNofuzz.
 *
 * Usage: yarn nanofuzz --help
 *
 * Uses mostly pytest-compatible exitcodes:
 *   - Exit code 0: Tests ran and all passed successfully
 *   - Exit code 1: Tests ran and some of the tests failed
 *   - Exit code 2: User cancelled testing
 *   - Exit code 3: Internal error happened while running tests
 *                  Includes cases where no tests were run
 *                  (e.g., all inputs generated were skipped)
 *   - Exit code 4: Command line usage error
 *   - Exit code 5: <not used>
 */
const EXIT_OK = 0;
const ERROR_TEST_FAILURE = 1;
const USER_CANCELLED = 2;
const ERROR_INTERNAL = 3;
const ERROR_USAGE = 4;

function createProgram(): Commander.Command {
  const program = new Commander.Command();
  program
    .name("nanofuzz")
    .version(`NaNofuzz ${nanofuzzVersion}`)
    .argument(`<filename>`, `The Python or Typescript module to test`)
    .argument(`<function>`, `The entrypoint function to test`)

    // -------------------------- Fuzzer Run Parameters -------------------------- //

    .option(
      `--output-file <filename>`,
      `Path and filename to output file for test results (in JSONN format)`
    )
    .option(
      `--max-runtime <integer>`,
      `Maximum time in ms NaNofuzz may run (0=no limit)`,
      parseIntArgGeZero,
      3000
    )
    .option(
      `--max-tests <integer>`,
      `Maximum number of tests NaNofuzz may run`,
      parseIntArgGeZero,
      1000
    )
    .option(
      `--max-dupe-inputs <integer>`,
      `Maximum number of sequential duplicate inputs`,
      parseIntArgGeZero,
      1000
    )
    .option(
      `--max-failures <integer>`,
      `Maximum number of test failures (0=no limit)`,
      parseIntArgGeZero,
      0
    )
    .option(
      `--fn-timeout <integer>`,
      `Maximum time in ms allowed for a tested function to run`,
      parseIntArgGeZero,
      200
    )
    .option(
      `--host-startup-timeout <integer>`,
      `Maximum time in ms allowed for test runner host startup`,
      parseIntArgGeOne,
      10000
    )
    .option(`--seed <string>`, `Seed for pseudo-random number generator`)
    .option(`--no-shrink`, `Disable shrinking failing test inputs`)
    .option(
      `--max-shrink-time <integer>`,
      `Maximum time in ms allowed for shrinking failing test inputs (0=no limit)`,
      parseIntArgGeZero,
      2000
    )

    // ------------------------------- Transformers ------------------------------ //

    .option(`--no-transformer`, `Disable input transformers`)

    // --------------------------------- Oracles --------------------------------- //

    .option(`--no-heuristic-oracle`, `Disable heuristic oracle`)
    .option(`--no-property-oracle`, `Disable property oracle`)
    .option(`--no-example-oracle`, `Disable example oracle`)

    // --------------------------------- Measures -------------------------------- //

    .option(`--no-coverage-measure`, `Disable code coverage measure`)
    .option(
      `--coverage-scope <scope>`,
      `Code coverage scope: 'project static' (default), 'project directimports static', etc.`,
      parseCoverageScopeOption,
      "project static"
    )
    .option(`--no-failed-test-measure`, `Disable failed test measure`)

    // ----------------------------- Input Generators ---------------------------- //

    .option(`--no-ai-input-generator`, `Disable AI input generator`)
    .option(`--no-mutation-input-generator`, `Disable mutation input generator`)
    .option(`--no-random-input-generator`, `Disable random input generator`)

    .option(`--model-provider <string>`, `AI model provider`)
    .option(`--model-name <string>`, `AI model name`)
    .option(`--model-key <string>`, `AI model API key`)
    .option(
      `--ai-cache-mode <mode>`,
      `LLM cache mode (passthrough, record, replay-record, replay-error, replay-passthrough)`,
      parseAiCacheMode
    )
    .option(`--ai-cache-file <path>`, `Path to LLM cache file`)

    // ------------------------ Composite Input Generator ------------------------ //

    .option(
      `--cig-input-lookback <integer>`,
      `Lookback window when choosing the next input generator`,
      parseIntArgGeOne,
      500
    )
    .option(
      `--cig-input-chunk-size <integer>`,
      `Inputs to generate before choosing the next input generator`,
      parseIntArgGeOne,
      20
    )
    .option(
      `--cig-randomness <float>`,
      `Chance of choosing the next input generator randomly`,
      parseFloatArgZeroToOne,
      0.1
    )
    .option(
      `--cig-input-focus <integer>`,
      `Extra focus for new interesting inputs`,
      parseIntArgGeOne,
      200
    )
    .option(
      `--cig-input-focus-decay <integer>`,
      `Focus decay as interesting inputs age`,
      parseIntArgGeZero,
      1
    )
    .option(
      `--cig-stats-checkpoints`,
      `Track composite generator subgen selection statistics`
    )

    // ------------------------------ System Cleanup ----------------------------- //

    .option(
      `--debug [scope]`,
      `Enable debug logging (scopes: * (default), runners, ai)`
    )
    .option(
      `--clear-compile-cache`,
      `Force clearing the compile cache prior to testing`
    );

  return program;
}

export async function runCliInProcess(
  args: string[] = process.argv.slice(2)
): Promise<number> {
  const program = createProgram();

  program.exitOverride((_err: Commander.CommanderError) => {
    throw _err;
  });

  try {
    program.parse(args, { from: "user" });
  } catch (_e: unknown) {
    // Commander throws a CommanderError with exitCode = 0 when handling --help or --version.
    // In exitOverride() mode, catch this and return EXIT_OK (0) instead of treating it as a usage error.
    if (_e instanceof Commander.CommanderError && _e.exitCode === 0) {
      return EXIT_OK;
    }
    return ERROR_USAGE; // command line usage error
  }

  console.info(`NaNofuzz v${nanofuzzVersion}`);

  if (program.args.length < 2) {
    console.error("Error: missing required arguments <filename> <function>");
    return ERROR_USAGE;
  }

  // Resolve the filename
  const filenameIn: string = program.args[0];
  let filename: string;
  try {
    filename = require.resolve(filenameIn);
  } catch (_e: unknown) {
    if (fs.existsSync(path.resolve(filenameIn))) {
      filename = path.resolve(filenameIn);
    } else {
      console.error(`Error: file not found: ${filenameIn}`);
      return ERROR_USAGE; // command line usage error
    }
  }

  const fnname = program.args[1];
  const options = program.opts();

  // Resolve the output file
  const outfile = options["outputFile"]
    ? path.resolve(options["outputFile"])
    : undefined;

  // Setup update message handler & the progress bar
  let isCancelled = false;
  let lastWasMilestone = true;
  const bar = new SingleBar(
    {
      format: " - Testing [{bar}] {percentage}%",
      clearOnComplete: true,
      linewrap: true,
    },
    Presets.shades_classic
  );

  const sigintListener = () => {
    if (isCancelled) {
      // ignore
    } else {
      isCancelled = true;
      if (!lastWasMilestone) {
        bar.stop();
        lastWasMilestone = true;
      }
      console.log("Cancellation requested. Stopping NaNofuzz...");
    }
  };

  process.on("SIGINT", sigintListener);

  const updateFn = (payload: FuzzBusyStatusMessage) => {
    if (!isCancelled) {
      switch (payload.channel) {
        case "summary":
        case "milestone": {
          if (!lastWasMilestone) {
            bar.stop();
          }
          console.log(payload.msg);
          break;
        }
        case "update": {
          if (lastWasMilestone) {
            bar.start(100, 0);
          }
          if (payload.pct) {
            bar.update(Math.max(0, Math.min(payload.pct, 100)));
          }
          break;
        }
      }
    }
    lastWasMilestone = payload.channel !== "update" || isCancelled;
  };

  // infrastructure options
  Config.override(
    "nanofuzz.fuzzer.hostStartupTimeout",
    options["hostStartupTimeout"]
  );

  if (options["shrink"] !== undefined) {
    Config.override("nanofuzz.fuzzer.shrinkFailures", options["shrink"]);
  }
  if (options["maxShrinkTime"] !== undefined) {
    Config.override("nanofuzz.fuzzer.maxShrinkTime", options["maxShrinkTime"]);
  }

  // measure options
  if (options["coverageScope"] !== undefined) {
    Config.override("nanofuzz.fuzzer.coverageScope", options["coverageScope"]);
  }

  // ai config options
  if (options["modelProvider"] !== undefined) {
    Config.override("nanofuzz.ai.provider", options["modelProvider"]);
  }
  if (options["modelName"] !== undefined) {
    Config.override("nanofuzz.ai.model", options["modelName"]);
  }
  if (options["modelKey"] !== undefined) {
    Config.override("nanofuzz.ai.apiKey", options["modelKey"]);
  }
  if (options["aiCacheMode"] !== undefined) {
    Config.override("nanofuzz.ai.cacheMode", options["aiCacheMode"]);
  }
  if (options["aiCacheFile"] !== undefined) {
    Config.override("nanofuzz.ai.cacheFile", options["aiCacheFile"]);
  }

  // composite input generator config options
  Config.override(
    "nanofuzz.generators.compositeLookbackWindow",
    options["cigInputLookback"]
  );
  Config.override(
    "nanofuzz.generators.compositeChunkSize",
    options["cigInputChunkSize"]
  );
  Config.override(
    "nanofuzz.generators.compositeExplorationChance",
    options["cigRandomness"]
  );
  Config.override(
    "nanofuzz.generators.leaderboardInitialFocus",
    options["cigInputFocus"]
  );
  Config.override(
    "nanofuzz.generators.leaderboardFocusDecay",
    options["cigInputFocusDecay"]
  );
  Config.override(
    "nanofuzz.generators.compositeTrackCheckpoints",
    Boolean(options["cigStatsCheckpoints"])
  );

  // debug options
  const debugVal = options["debug"];
  if (debugVal !== false && debugVal !== undefined) {
    const scope =
      typeof debugVal === "string" ? debugVal.toLowerCase().trim() : "*";
    const scopes = scope.split(",").map((s) => s.trim());
    Config.override(
      "nanofuzz.debug.runners",
      scopes.includes("*") || scopes.includes("runners")
    );
    Config.override(
      "nanofuzz.ai.debug",
      scopes.includes("*") || scopes.includes("ai")
    );
  } else {
    Config.override("nanofuzz.debug.runners", false);
    Config.override("nanofuzz.ai.debug", false);
  }

  // Clear compiler cache if requested
  if (options["clearCompileCache"]) {
    CompilerFactory.clean();
  }

  try {
    await ParserAdapter.init();

    const programObj = ProgramFactory.fromFile(filename);
    const targetFnDef = programObj.functionsExported[fnname];
    const fnRef = targetFnDef?.getRef();
    const fnFuzzOptions = fnRef?.fuzzOptions;

    function getEffectiveOption<K extends keyof FuzzOptions>(
      cliOptionName: string,
      fuzzOptKey: K,
      cliValue: FuzzOptions[K]
    ): FuzzOptions[K] {
      const isDefault =
        program.getOptionValueSource(cliOptionName) === "default";
      if (
        isDefault &&
        fnFuzzOptions &&
        fnFuzzOptions[fuzzOptKey] !== undefined
      ) {
        return fnFuzzOptions[fuzzOptKey]!;
      }
      return cliValue;
    }

    // TODO: There is no upgrade logic here like in FuzzPanel:
    //       We need to re-factor the nano file logic out of
    //       FuzzPanel so that we can call it here.
    let injectTests: FuzzPinnedTest[] = [];
    const nanoJsonFile = fs.existsSync(filename + ".nano.json5")
      ? filename + ".nano.json5"
      : fs.existsSync(filenameIn + ".nano.json5")
        ? filenameIn + ".nano.json5"
        : undefined;
    if (nanoJsonFile && fs.existsSync(nanoJsonFile)) {
      try {
        const fullSet = JSONN.parse<FuzzTests>(
          fs.readFileSync(nanoJsonFile, "utf8")
        );
        const fnSet = fullSet.functions?.[fnname];
        if (fnSet && fnSet.tests) {
          injectTests = Object.values(fnSet.tests);
        }
      } catch {
        // Ignore read or parse errors
      }
    }

    const results = await new Tester(filename, fnname, {
      argDefaults: ArgDef.getDefaultOptions(),
      maxTests: getEffectiveOption("maxTests", "maxTests", options["maxTests"]),
      fnTimeout: getEffectiveOption(
        "fnTimeout",
        "fnTimeout",
        options["fnTimeout"]
      ),
      suiteTimeout: getEffectiveOption(
        "maxRuntime",
        "suiteTimeout",
        options["maxRuntime"]
      ),
      seed: options["seed"],
      maxDupeInputs: getEffectiveOption(
        "maxDupeInputs",
        "maxDupeInputs",
        options["maxDupeInputs"]
      ),
      maxFailures: getEffectiveOption(
        "maxFailures",
        "maxFailures",
        options["maxFailures"]
      ),
      useTransformer: options["transformer"],
      useImplicit: options["heuristicOracle"],
      useHuman: options["exampleOracle"],
      useProperty: options["propertyOracle"],
      outputFile: outfile,
      measures: {
        CoverageMeasure: {
          enabled: options["coverageMeasure"],
          weight: 1,
        },
        FailedTestMeasure: {
          enabled: options["failedTestMeasure"],
          weight: 1,
        },
      },
      generators: {
        AiInputGenerator: { enabled: options["aiInputGenerator"] },
        MutationInputGenerator: {
          enabled: options["mutationInputGenerator"],
        },
        RandomInputGenerator: {
          enabled: options["randomInputGenerator"],
        },
      },
    }).testSync(injectTests, undefined, updateFn, () => isCancelled);

    process.removeListener("SIGINT", sigintListener);

    if (isCancelled) {
      return USER_CANCELLED;
    }

    const someTestsRan =
      results.stats.counters.passedTests + results.stats.counters.failedTests;
    const someTestsFailed = results.stats.counters.failedTests;

    if (someTestsRan && !results.stats.counters.erroredTests) {
      if (someTestsFailed) {
        return ERROR_TEST_FAILURE; // tests ran and some failed
      } else {
        return EXIT_OK; // tests ran and none failed);
      }
    } else {
      return ERROR_INTERNAL; // internal error
    }
  } catch (e: unknown) {
    process.removeListener("SIGINT", sigintListener);
    await LlmAdapter.flushCache(5000);
    if (isError(e)) {
      if (e.stack) {
        console.error(e.stack);
      } else {
        console.error(`${e.name}: ${e.message}`);
      }
    } else {
      console.error("Unknown internal error");
    }
    return ERROR_USAGE; // internal error
  }
}

if (require.main === module) {
  runCliInProcess().then((code) => process.exit(code));
}

// ---------------------------- Parameter Validators --------------------------- //

function parseFloatArgGeZero(value: string, _previous: number): number {
  const parsedValue = parseFloat(value);
  if (isNaN(parsedValue)) {
    throw new Commander.InvalidArgumentError("Not a number");
  }
  if (parsedValue < 0) {
    throw new Commander.InvalidArgumentError("Negative number not allowed");
  }
  return parsedValue;
} // fn: parseFloatArgGeZero

function parseAiCacheMode(value: string, _previous: string): string {
  const allowed = [
    "passthrough",
    "record",
    "replay-record",
    "replay-error",
    "replay-passthrough",
  ];
  if (!allowed.includes(value)) {
    throw new Commander.InvalidArgumentError(
      `Invalid ai cache mode '${value}'. Allowed: ${allowed.join(", ")}`
    );
  }
  return value;
} // fn: parseAiCacheMode

function parseCoverageScopeOption(value: string, _previous: string): string {
  try {
    parseCoverageScope(value);
    return value;
  } catch (_e) {
    throw new Commander.InvalidArgumentError(
      `Invalid coverage scope '${value}'. Allowed tokens: 'project', 'directimports', 'static'`
    );
  }
} // fn: parseCoverageScopeOption

function parseFloatArgZeroToOne(value: string, _previous: number): number {
  const parsedValue = parseFloatArgGeZero(value, _previous);
  if (parsedValue > 1) {
    throw new Commander.InvalidArgumentError("Number > 1 not allowed");
  }
  return parsedValue;
} // fn: parseFloatArgZeroToOne

function parseIntArgGeZero(value: string, _previous: number): number {
  const parsedValue = parseInt(value);
  if (isNaN(parsedValue)) {
    throw new Commander.InvalidArgumentError("Not a number");
  }
  if (parsedValue < 0) {
    throw new Commander.InvalidArgumentError("Negative number not allowed");
  }
  return parsedValue;
} // fn: parseNonNegIntArg

function parseIntArgGeOne(value: string, _previous: number): number {
  const parsedValue = parseIntArgGeZero(value, _previous);
  if (parsedValue < 1) {
    throw new Commander.InvalidArgumentError("Zero not allowed");
  }
  return parsedValue;
} // fn: parseGeOneIntArg
