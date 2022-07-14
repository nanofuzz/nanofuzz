import * as fs from "fs";
import seedrandom from "seedrandom";
import {
  ArgDef,
  ArgType,
  findFnInSource,
  getTsFnArgs,
} from "./analysis/Typescript";
import { GeneratorFactory } from "./generators/GeneratorFactory";

// !!! prng isn't advancing

// !!!
export const fuzzSetup = (
  options: FuzzOptions,
  srcFile: string,
  fnName?: string,
  offset?: number
): FuzzEnv => {
  const srcText = fs.readFileSync(srcFile);
  const fnMatches = findFnInSource(srcText.toString(), fnName, offset);

  if (!fnMatches.length)
    throw new Error(
      `Could not find function ${fnName}@${offset} in: ${srcFile})}`
    );

  const [foundFnName, foundFnSrc] = fnMatches[0];
  return {
    options: options,
    inputs: getTsFnArgs(foundFnSrc),
    fnName: foundFnName,
    fnSrc: foundFnSrc,
    srcFile: srcFile,
  };
};

// !!!
export const fuzz = (env: FuzzEnv): FuzzTestResults => {
  const prng = seedrandom(env.options.seed ?? "");

  // Main test loop
  for (let i = 0; i < env.options.numTests; i++) {
    // Build a generator for each argument
    const generators: (() => any)[] = [];
    env.inputs.forEach((e) => generators.push(GeneratorFactory(e, prng)));

    console.log(
      `Calling ${env.fnName}(${generators
        .map((e) => JSON.stringify(e()))
        .join(",")})`
    );
  }
  // !!! Setup call to function
  return {
    env: env,
    outputs: [], // !!!
  };
};

// !!!
export type FuzzEnv = {
  options: FuzzOptions;
  inputs: ArgDef<ArgType>[];
  fnName: string;
  fnSrc: string;
  srcFile: string;
};

// !!!
export type FuzzOptions = {
  outputFile?: string; // File to write output to
  seed?: string; // Variation / seed (optional)
  numTests: number; // Number of fuzzing tests to execute
  // !!! oracleFn: typeof isReal; // The oracle function TODO: Create type for function shape
};

// !!!
export type FuzzTestResults = {
  env: FuzzEnv;
  outputs: {
    // !!! input: number[]; // input to function
    // !!!output: ad.Outputs<number>; // output from function
    passed: boolean; // true if output matches oracle; false, otherwise
  }[];
};
