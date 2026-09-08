import { ArgDef } from "./Fuzzer";
import { FuzzOptions } from "./Types";
import * as CompilerFactory from "./compilers/CompilerFactory";
import * as Parser from "./adapters/ParserAdapter";

// Extend default test timeout to 60s
jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

// Clean up prior testing temporary files, like compiler output,
// so that we actually run the compiler during testing
CompilerFactory.clean();

/**
 * Fuzzer option for enabling all Measures
 */
export const allMeasures = {
  FailedTestMeasure: {
    enabled: true,
    weight: 1,
  },
  CoverageMeasure: {
    enabled: true,
    weight: 1,
  },
};

/**
 * Fuzzer option for enabling all Generators
 */
export const allGenerators = {
  RandomInputGenerator: {
    enabled: true,
  },
  MutationInputGenerator: {
    enabled: true,
  },
  AiInputGenerator: {
    enabled: true,
  },
};

/**
 * Fuzzer option for integer arguments and a seed for deterministic test execution.
 */
export const intOptions: FuzzOptions = {
  argDefaults: ArgDef.getDefaultOptions(),
  maxTests: 1000,
  fnTimeout: 200,
  suiteTimeout: 0,
  seed: "qwertyuiop",
  maxDupeInputs: 1000,
  maxFailures: 0,
  useImplicit: true,
  useTransformer: true,
  useHuman: true,
  useProperty: false,
  measures: allMeasures,
  generators: allGenerators,
};

/**
 * Fuzzer option for float arguments and a seed for deterministic test execution.
 */
export const floatOptions: FuzzOptions = {
  ...intOptions,
  argDefaults: {
    ...ArgDef.getDefaultOptions(),
    numInteger: false,
  },
};

export async function initParser(): Promise<void> {
  await Parser.init();
}
