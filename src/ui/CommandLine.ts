import * as Commander from "commander";
import * as Config from "../Config";
import * as fs from "node:fs";
import { SingleBar, Presets } from "cli-progress";
import * as ParserAdapter from "../fuzzer/adapters/ParserAdapter";
import { ArgDef, FuzzBusyStatusMessage, Tester } from "../fuzzer/Fuzzer";
import * as CompilerFactory from "../fuzzer/compilers/CompilerFactory";
import path from "node:path";
import { isError } from "../fuzzer/Util";

/**
 * Command line interface for NaNofuzz.
 *
 * Usage: yarn nanofuzz --help
 *
 * Uses mostly pytest-compatible exitcodes:
 *   - Exit code 0: All tests passed successfully
 *   - Exit code 1: Tests ran but some of the tests failed
 *   - Exit code 2: <not used>
 *   - Exit code 3: Internal error happened while running tests
 *   - Exit code 4: Command line usage error
 *   - Exit code 5: <not used>
 */
const EXIT_OK = 0;
const ERROR_TEST_FAILURE = 1;
const ERROR_INTERNAL = 3;
const ERROR_USAGE = 4;

Commander.program
  .name("nanofuzz")
  .version(`NaNofuzz ${process.env.NANOFUZZ_VERSION}`)
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
  .option(`--seed <string>`, `Seed for pseudo-random number generator`, "")

  // ------------------------------- Transformers ------------------------------ //

  .option(`--no-transformer`, `Disable input transformers`)

  // --------------------------------- Oracles --------------------------------- //

  .option(`--no-heuristic-oracle`, `Disable heuristic oracle`)
  .option(`--no-property-oracle`, `Disable property oracle`)
  .option(`--no-example-oracle`, `Disable example oracle`)

  // --------------------------------- Measures -------------------------------- //

  .option(`--no-coverage-measure`, `Disable code coverage measure`)
  .option(`--no-failed-test-measure`, `Disable failed test measure`)

  // ----------------------------- Input Generators ---------------------------- //

  .option(`--no-ai-input-generator`, `Disable AI input generator`)
  .option(`--no-mutation-input-generator`, `Disable mutation input generator`)

  .option(`--model-provider <string>`, `AI model provider`)
  .option(`--model-name <string>`, `AI model name`)
  .option(`--model-key <string>`, `AI model API key`)

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

  // ------------------------------ System Cleanup ----------------------------- //

  .option(
    `--clear-compile-cache`,
    `Force clearing the compile cache prior to testing`
  );

// Process & validate CLI input
Commander.program
  .exitOverride((_err: Commander.CommanderError) => {
    process.exit(ERROR_USAGE); // command line usage error
  })
  .parse();

console.info(`NaNofuzz v${process.env.NANOFUZZ_VERSION}`);

// Resolve the filename
const filenameIn: string = Commander.program.args[0];
let filename: string;
try {
  filename = require.resolve(filenameIn);
} catch (_e: unknown) {
  if (fs.existsSync(path.resolve(filenameIn))) {
    filename = path.resolve(filenameIn);
  } else {
    console.error(`Error: file not found: ${filenameIn}`);
    process.exit(ERROR_USAGE); // command line usage error
  }
}

const fnname = Commander.program.args[1];
const options = Commander.program.opts();

// Resolve the output file
const outfile = options["outputFile"]
  ? path.resolve(options["outputFile"])
  : undefined;

// Setup update message handler & the progress bar
let lastWasMilestone = true;
const bar = new SingleBar(
  {
    format: " - Testing [{bar}] {percentage}%",
    clearOnComplete: true,
    linewrap: true,
  },
  Presets.shades_classic
);
const updateFn = (payload: FuzzBusyStatusMessage) => {
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
    }
  }
  lastWasMilestone = payload.channel !== "update";
};

// Set config options
for (const key in options) {
  const value = options[key];
  switch (key) {
    // ai config options
    case "modelProvider":
      Config.override("nanofuzz.ai.provider", value);
      break;
    case "modelName":
      Config.override("nanofuzz.ai.model", value);
      break;
    case "modelKey":
      Config.override("nanofuzz.ai.apiKey", value);
      break;

    // composite input generator config options
    case "cigInputLookback":
      Config.override("nanofuzz.generators.compositeLookbackWindow", value);
      break;
    case "cigInputChunkSize":
      Config.override("nanofuzz.generators.compositeChunkSize", value);
      break;
    case "cigRandomness":
      Config.override("nanofuzz.generators.compositeExplorationChance", value);
      break;
    case "cigInputFocus":
      Config.override("nanofuzz.generators.leaderboardInitialFocus", value);
      break;
    case "cigInputFocusDecay":
      Config.override("nanofuzz.generators.leaderboardFocusDecay", value);
      break;
  }
}

// Clear compiler cache if requested
if (options["clearCompileCache"]) {
  CompilerFactory.clean();
}

// -------------------------------- Run NaNofuzz ------------------------------- //

run();

async function run(): Promise<void> {
  try {
    await ParserAdapter.init();
    const results = await new Tester(filename, fnname, {
      argDefaults: ArgDef.getDefaultOptions(),
      maxTests: options["maxTests"],
      fnTimeout: options["fnTimeout"],
      suiteTimeout: options["maxRuntime"],
      seed: options["seed"],
      maxDupeInputs: options["maxDupeInputs"],
      maxFailures: options["maxFailures"],
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
          enabled: options["murationInputGenerator"],
        },
        RandomInputGenerator: {
          enabled: true, // always enabled
        },
      },
    }).testSync(undefined, undefined, updateFn);

    const someTestsRan =
      results.stats.counters.passedTests + results.stats.counters.failedTests;
    const someTestsFailed = results.stats.counters.failedTests;

    if (someTestsRan) {
      if (someTestsFailed) {
        process.exit(ERROR_TEST_FAILURE); // tests ran and some failed
      } else {
        process.exit(EXIT_OK); // tests ran and none failed
      }
    } else {
      process.exit(ERROR_INTERNAL); // internal error
    }
  } catch (e: unknown) {
    if (isError(e)) {
      if (e.stack) {
        console.error(e.stack);
      } else {
        console.error(`${e.name}: ${e.message}`);
      }
    } else {
      console.error("Unknown internal error");
    }
    process.exit(ERROR_USAGE); // internal error
  }
} // fn: run

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
