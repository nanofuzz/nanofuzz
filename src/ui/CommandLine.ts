import * as Commander from "commander";
import * as fs from "node:fs";
import { SingleBar, Presets } from "cli-progress";
import * as ParserAdapter from "../fuzzer/adapters/ParserAdapter";
import { ArgDef, FuzzBusyStatusMessage, Tester } from "../fuzzer/Fuzzer";
import * as CompilerFactory from "../fuzzer/compilers/CompilerFactory";
import path from "node:path";

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
Commander.program
  .name("nanofuzz")
  .version(`NaNofuzz ${process.env.NANOFUZZ_VERSION}`)
  .argument(`<filename>`, `The Python or Typescript module to test`)
  .argument(`<function>`, `The entrypoint function to test`)

  .option(
    `--output-file`,
    `Path and filename to output file for test results (in JSONN format)`
  )

  .option(
    `--max-runtime <suiteTimeout>`,
    `Maximum time in ms NaNofuzz may run (0=no limit)`,
    parseIntArg,
    3000
  )
  .option(
    `--max-tests <maxTests>`,
    `Maximum number of tests NaNofuzz may run`,
    parseIntArg,
    1000
  )
  .option(
    `--max-dupe-inputs <maxDupeInputs>`,
    `Maximum number of sequential duplicate inputs`,
    parseIntArg,
    1000
  )
  .option(
    `--max-failures <maxFailures>`,
    `Maximum number of test failures (0=no limit)`,
    parseIntArg,
    0
  )
  .option(
    `--fn-timeout <fnTimeout>`,
    `Maximum time in ms allowed for a tested function to run`,
    parseIntArg,
    200
  )
  .option(`--seed <seed>`, `Seed for pseudo-random number generator`)

  .option(`--no-heuristic-oracle`, `Disable heuristic oracle`)
  .option(`--no-property-oracle`, `Disable property oracle`)
  .option(`--no-example-oracle`, `Disable example oracle`)

  .option(`--no-coverage-measure`, `Disable code coverage measure`)
  .option(`--no-failed-test-measure`, `Disable failed test measure`)

  .option(`--no-ai-input-generator`, `Disable AI input generator`)
  .option(`--no-mutation-input-generator`, `Disable mutation input generator`)

  .option(`--model-provider <modelProvider>`, `AI model provider`) // !!!!!!!!!!
  .option(`--model-name <modelName>`, `AI model name`) // !!!!!!!!!!
  .option(`--model-key <modelKey>`, `AI model API key`) // !!!!!!!!!!

  .option(
    `--clear-compile-cache`,
    `Forces NaNofuzz to clear the compile cache prior to testing`
  );

Commander.program
  .exitOverride((_err: Commander.CommanderError) => {
    process.exit(4); // command line usage error
  })
  .parse();

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
    process.exit(4); // command line usage error
  }
}

const fnname = Commander.program.args[1];
const options = Commander.program.opts();

if (options["clearCompileCache"]) {
  CompilerFactory.clean();
}

let lastWasMilestone = true;
const bar = new SingleBar(
  {
    format: "  testing [{bar}] {percentage}%",
  },
  Presets.shades_classic
);
const updateFn = (payload: FuzzBusyStatusMessage) => {
  switch (payload.channel) {
    case "summary":
    case "milestone": {
      if (!lastWasMilestone) {
        bar.stop();
        process.stdout.write("\x1b[A\x1b[K");
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

console.info(`NaNofuzz v${process.env.NANOFUZZ_VERSION}`);
ParserAdapter.init().then(async () => {
  const results = await new Tester(filename, fnname, {
    argDefaults: ArgDef.getDefaultOptions(),
    maxTests: options["maxTests"],
    fnTimeout: options["fnTimeout"],
    suiteTimeout: options["suiteTimeout"],
    seed: options["seed"],
    maxDupeInputs: options["maxDupeInputs"],
    maxFailures: options["maxFailures"],
    useImplicit: options["useImplicit"],
    useHuman: options["useHuman"],
    useProperty: options["useProperty"],
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

  const someTestsRan = !!results.results.length;
  const someTestsFailed = results.results.some((r) => r.category !== "ok");

  if (someTestsRan) {
    if (someTestsFailed) {
      process.exit(1); // tests ran and some failed
    } else {
      process.exit(0); // tests ran and none failed
    }
  } else {
    process.exit(3); // error
  }
});

function parseIntArg(value: string, _previous: number): number {
  const parsedValue = parseInt(value);
  if (isNaN(parsedValue)) {
    throw new Commander.InvalidArgumentError("Not a number");
  }
  return parsedValue;
}
