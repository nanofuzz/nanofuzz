import * as Commander from "commander";
import { Parser } from "web-tree-sitter";
import { ArgDef, Tester } from "../fuzzer/Fuzzer";

Commander.program
  .name("NaNofuzz")
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

  .option(`--model-provider <modelProvider>`, `AI model provider`)
  .option(`--model-name <modelName>`, `AI model name`)
  .option(`--model-key <modelKey>`, `AI model API key`);

// !!!!!!!!!! Pyhon Debug
// !!!!!!!!!! Set node-llm env variables??

Commander.program.parse();

const options = Commander.program.opts();

Parser.init().then(async () => {
  const results = await new Tester("nanofuzz-study/examples/1.ts", "minValue", {
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
  }).testSync();

  const testsRan = !!results.results.length;
  const testsFailed = results.results.some((r) => r.category !== "ok");

  if (testsRan) {
    if (testsFailed) {
      process.exit(); // tests ran and some failed
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
