import { PytestAdapter } from "./PytestAdapter";
import { FuzzOptions, FuzzTests } from "../../Types";
import { ArgOptions, ArgTag } from "../../analysis/Types";

const argDefaults: ArgOptions = {
  strCharset: "abc",
  strLength: { min: 0, max: 3 },
  byteLength: { min: 0, max: 3 },
  dictLength: { min: 0, max: 3 },
  strRegex: undefined,
  numInteger: true,
  anyType: ArgTag.NUMBER,
  anyDims: 0,
  dftDimLength: { min: 0, max: 1 },
  dimLength: [],
  dimsUnique: false,
};

const baseOptions: Omit<
  FuzzOptions,
  "argDefaults" | "measures" | "generators"
> = {
  maxTests: 1,
  fnTimeout: 100,
  suiteTimeout: 1000,
  seed: "seed",
  maxDupeInputs: 1,
  maxFailures: 1,
  useTransformer: true,
  useImplicit: false,
  useHuman: false,
  useProperty: false,
};

const measures: FuzzOptions["measures"] = {
  FailedTestMeasure: { enabled: true, weight: 1 },
  CoverageMeasure: { enabled: false, weight: 0 },
};

const generators: FuzzOptions["generators"] = {
  RandomInputGenerator: { enabled: true },
  MutationInputGenerator: { enabled: false },
  AiInputGenerator: { enabled: false },
};

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

describe("fuzzer/adapters/pytest/PytestAdapter:", () => {
  it("emits unit test fn for all generated scenarios", () => {
    const tests: FuzzTests = {
      version: "0.0.0",
      functions: {
        sampleFn: {
          options: makeOptions({ useHuman: true, useProperty: true }),
          validators: ["sampleFnValidator"],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 1,
                  origin: {
                    type: "generator",
                    generator: "RandomInputGenerator",
                  },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  value: "value",
                  origin: { type: "user" },
                },
              ],
            },
            "1": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 2,
                  origin: {
                    type: "generator",
                    generator: "RandomInputGenerator",
                  },
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
                  origin: { type: "user" },
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

    const out = new PytestAdapter(tests, "mymodule.ts").toString();

    expect(out).toContain("def test_sampleFn_0_expect(");
    expect(out).toContain("def test_sampleFn_0_prop_Validator(");
    expect(out).toContain("def test_sampleFn_1_expect(");
    expect(out).toContain("def test_voidFn_0_heuristic(");

    const itMatches = out.match(/\bdef test_/g) ?? [];
    expect(itMatches.length).toBeGreaterThanOrEqual(4);
    expect(out.includes("test(")).toBeFalse();
  });

  it("keeps nano test filename helper", () => {
    const fname = new PytestAdapter(
      {
        version: "0.0.0",
        functions: {},
      },
      "mymodule.py"
    ).filename;
    expect(fname).toBe("mymodule_nano_test.py");
  });
});
