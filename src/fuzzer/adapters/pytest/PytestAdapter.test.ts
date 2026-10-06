import { PytestAdapter } from "./PytestAdapter";
import { FuzzOptions, FuzzTests } from "../../Types";
import { ArgOptions, ArgTag } from "../../analysis/Types";
import { PythonRunner } from "../../runners/python/PythonRunner";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

const argDefaults: ArgOptions = {
  strCharset: "abc",
  strLength: { min: 0, max: 3 },
  byteLength: { min: 0, max: 3 },
  dictLength: { min: 0, max: 3 },
  setLength: { min: 0, max: 3 },
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

  it("emits BigInt test cases as Python integers correctly", () => {
    const tests: FuzzTests = {
      version: "0.0.0",
      functions: {
        bigIntFn: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 100n,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  value: 200n,
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
      },
    };

    const out = new PytestAdapter(tests, "mymodule.py").toString();
    expect(out).toContain("def test_bigIntFn_0_expect(");
    expect(out).toContain("assert themodule.bigIntFn(*[100]) == 200");
  });

  it("emits async Pytest tests when isAsync is true", () => {
    const tests: FuzzTests = {
      version: "0.0.0",
      functions: {
        asyncVal: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 1,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  value: "result",
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
          isAsync: true,
        },
        asyncErr: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: -1,
                  origin: { type: "user" },
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
          isAsync: true,
        },
        asyncProp: {
          options: makeOptions({ useProperty: true }),
          validators: ["asyncPropValidator"],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 5,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
            },
          },
          isVoid: false,
          isAsync: true,
        },
        asyncVoid: {
          options: makeOptions({ useImplicit: true }),
          validators: [],
          tests: {
            "0": {
              input: [],
              output: [],
              pinned: true,
            },
          },
          isVoid: true,
          isAsync: true,
        },
        asyncHeuristic: {
          options: makeOptions({ useImplicit: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 10,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
            },
          },
          isVoid: false,
          isAsync: true,
        },
      },
    };

    const out = new PytestAdapter(tests, "async_module.py").toString();

    expect(out).toContain("import asyncio");
    expect(out).toContain("import inspect");
    expect(out).toContain("def test_asyncVal_0_expect():");
    expect(out).toContain(
      'assert asyncio.run(themodule.asyncVal(*[1])) == "result"'
    );
    expect(out).toContain("def test_asyncErr_0_expect():");
    expect(out).toContain("with pytest.raises(Exception):");
    expect(out).toContain("asyncio.run(themodule.asyncErr(*[-1]))");
    expect(out).toContain("def test_asyncProp_0_prop_Validator():");
    expect(out).toContain("def test_asyncVoid_0_heuristic():");
    expect(out).toContain(
      "assert asyncio.run(themodule.asyncVoid(*[])) == None"
    );
    expect(out).toContain("def test_asyncHeuristic_0_heuristic():");
    expect(out).toContain(
      'assert implicit_oracle(asyncio.run(themodule.asyncHeuristic(*[10]))) != "fail"'
    );
  });

  it("executes generated async Pytest test suite with pytest binary", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pytest-adapter-async-")
    );
    const modPath = path.join(tmpDir, "sample_async.py");
    const modCode = `import asyncio

async def asyncVal(x: int) -> str:
    await asyncio.sleep(0.01)
    return "result_" + str(x)

async def asyncErr(x: int):
    await asyncio.sleep(0.01)
    if x < 0:
        raise ValueError("negative")

async def asyncVoid():
    await asyncio.sleep(0.01)

async def asyncProp(x: int) -> int:
    await asyncio.sleep(0.01)
    return x * 2

def asyncPropValidator(result):
    if result["out"] is not None and result["out"] == 10:
        return "pass"
    return "fail"
`;
    fs.writeFileSync(modPath, modCode);

    const tests: FuzzTests = {
      version: "0.0.0",
      functions: {
        asyncVal: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 1,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  value: "result_1",
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
          isAsync: true,
        },
        asyncErr: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: -1,
                  origin: { type: "user" },
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
          isAsync: true,
        },
        asyncVoid: {
          options: makeOptions({ useImplicit: true }),
          validators: [],
          tests: {
            "0": {
              input: [],
              output: [],
              pinned: true,
            },
          },
          isVoid: true,
          isAsync: true,
        },
        asyncProp: {
          options: makeOptions({ useProperty: true }),
          validators: ["asyncPropValidator"],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 5,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
            },
          },
          isVoid: false,
          isAsync: true,
        },
      },
    };

    const adapter = new PytestAdapter(tests, modPath);
    const testCode = adapter.toString();
    const testPath = adapter.filename;
    fs.writeFileSync(testPath, testCode);

    const pyEnv = PythonRunner.envFor(modPath);

    try {
      const res = spawnSync(
        pyEnv.interpreter,
        [
          "-m",
          "pytest",
          testPath,
          "-o",
          "cache_dir=" + path.join(tmpDir, ".pytest_cache"),
        ],
        {
          cwd: tmpDir,
          env: pyEnv.env,
          encoding: "utf8",
        }
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("4 passed");
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("handles UnsatisfiedAssumption in property validators without failing test", () => {
    const tests: FuzzTests = {
      version: "0.0.0",
      functions: {
        myFn: {
          options: makeOptions({ useProperty: true }),
          validators: ["myFnValidator"],
          tests: {
            "0": {
              input: [
                {
                  name: "x",
                  offset: 0,
                  value: 1,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
            },
          },
          isVoid: false,
        },
      },
    };

    const out = new PytestAdapter(tests, "mymodule.py").toString();
    expect(out).toContain("UnsatisfiedAssumption");
    expect(out).toContain("return 'unknown'");
  });
});
