import * as jestadapter from "./JestAdapter";
import { FuzzTests, FuzzOptions } from "../Types";
import { ArgOptions, ArgTag } from "../analysis/typescript/Types";

const argDefaults: ArgOptions = {
  strCharset: "abc",
  strLength: { min: 0, max: 3 },
  numInteger: true,
  numSigned: false,
  anyType: ArgTag.NUMBER,
  anyDims: 0,
  dftDimLength: { min: 0, max: 1 },
  dimLength: [],
};

const baseOptions: Omit<FuzzOptions, "argDefaults" | "measures" | "generators"> = {
  maxTests: 1,
  fnTimeout: 100,
  suiteTimeout: 1000,
  seed: "seed",
  maxDupeInputs: 1,
  maxFailures: 1,
  useImplicit: false,
  useHuman: false,
  useProperty: false,
};

const measures = {
  FailedTestMeasure: { enabled: true, weight: 1 },
  CoverageMeasure: { enabled: false, weight: 0 },
} as FuzzOptions["measures"];

const generators = {
  RandomInputGenerator: { enabled: true },
  MutationInputGenerator: { enabled: false },
} as FuzzOptions["generators"];

const makeOptions = (overrides: Partial<FuzzOptions> = {}): FuzzOptions => ({
  ...baseOptions,
  argDefaults: overrides.argDefaults ?? argDefaults,
  measures: overrides.measures ?? measures,
  generators: overrides.generators ?? generators,
  maxTests: overrides.maxTests ?? baseOptions.maxTests,
  fnTimeout: overrides.fnTimeout ?? baseOptions.fnTimeout,
  suiteTimeout: overrides.suiteTimeout ?? baseOptions.suiteTimeout,
  seed: overrides.seed ?? baseOptions.seed,
  maxDupeInputs: overrides.maxDupeInputs ?? baseOptions.maxDupeInputs,
  maxFailures: overrides.maxFailures ?? baseOptions.maxFailures,
  useImplicit: overrides.useImplicit ?? baseOptions.useImplicit,
  useHuman: overrides.useHuman ?? baseOptions.useHuman,
  useProperty: overrides.useProperty ?? baseOptions.useProperty,
});

describe("fuzzer/adapters/JestAdapter:", () => {
  it("emits 'it' for all generated scenarios", () => {
    const tests: FuzzTests = {
      version: "0.0.0",
      functions: {
        sampleFn: {
          options: makeOptions({ useHuman: true, useProperty: true }),
          validators: ["isValid"],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 1,
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  value: "value",
                },
              ],
            },
            "1": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 2,
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  isException: true,
                  value: undefined,
                },
              ],
            },
          },
          isVoid: false,
        },
        voidFn: {
          options: makeOptions({ useImplicit: true }),
          validators: [],
          tests: {
            only: {
              input: [],
              output: [],
              pinned: true,
            },
          },
          isVoid: true,
        },
      },
    };

    const out = jestadapter.toString(tests, "mymodule.ts");

    expect(out).toContain('it("sampleFn.0.human"');
    expect(out).toContain('it("sampleFn.0.isValid"');
    expect(out).toContain('it("sampleFn.1.human"');
    expect(out).toContain('it("voidFn.0.heuristic"');

    const itMatches = out.match(/\bit\(/g) ?? [];
    expect(itMatches.length).toBeGreaterThanOrEqual(4);
    expect(out.includes("test(")).toBeFalse();
  });

  it("keeps nano test filename helper", () => {
    const fname = jestadapter.getFilename("mymodule.ts");
    expect(fname).toBe("mymodule.nano.test.ts");
  });
});
