import { JestAdapter } from "./JestAdapter";
import { FuzzTests, FuzzOptions } from "../../Types";
import { ArgOptions, ArgTag } from "../../analysis/Types";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as ts from "typescript";
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
  workers: "auto",
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

describe("fuzzer/adapters/jest/JestAdapter:", () => {
  it("emits unit test for all generated scenarios", () => {
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

    const out = new JestAdapter(tests, "mymodule.ts").toString();

    expect(out).toContain('it("sampleFn.0.expect"');
    expect(out).toContain('it("sampleFn.0.prop.Validator"');
    expect(out).toContain('it("sampleFn.1.expect"');
    expect(out).toContain('it("voidFn.0.heuristic"');

    const itMatches = out.match(/\bit\(/g) ?? [];
    expect(itMatches.length).toBeGreaterThanOrEqual(4);
    expect(out.includes("test(")).toBeFalse();
  });

  it("keeps nano test filename helper", () => {
    const fname = new JestAdapter(
      {
        version: "0.0.0",
        functions: {},
      },
      "mymodule.ts"
    ).filename;
    expect(fname).toBe("mymodule.nano.test.ts");
  });

  it("emits BigInt test cases correctly", () => {
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

    const out = new JestAdapter(tests, "mymodule.ts").toString();
    expect(out).toContain(
      'it("bigIntFn.0.expect", () => {expect(themodule.bigIntFn(100n)).toEqual(200n);},100);'
    );
  });

  it("emits async Jest tests when isAsync is true", () => {
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

    const out = new JestAdapter(tests, "asyncModule.ts").toString();

    expect(out).toContain("runAsyncPropertyValidator");
    expect(out).toContain(
      'it("asyncVal.0.expect", async () => {expect(await themodule.asyncVal(1)).toEqual("result");},100);'
    );
    expect(out).toContain(
      'it("asyncErr.0.expect", async () => {await expect(themodule.asyncErr(-1)).rejects.toThrow();},100);'
    );
    expect(out).toContain('it("asyncProp.0.prop.Validator", async () => {');
    expect(out).toContain("await runAsyncPropertyValidator");
    expect(out).toContain(
      'it("asyncVoid.0.heuristic", async () => {expect(await themodule.asyncVoid()).toBeUndefined();},100);'
    );
    expect(out).toContain(
      'it("asyncHeuristic.0.heuristic", async () => {expect(implicitOracle(await themodule.asyncHeuristic(10))).toBe(true);},100);'
    );
  });

  it("executes generated async Jest test suite with jest runner", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jest-adapter-async-")
    );
    const modTsPath = path.join(tmpDir, "asyncModule.ts");
    const modJsPath = path.join(tmpDir, "asyncModule.js");
    const modTsCode = `export async function asyncVal(x: number): Promise<string> {
  await new Promise((r) => setTimeout(r, 10));
  return "result_" + x;
}

export async function asyncErr(x: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
  if (x < 0) {
    throw new Error("negative");
  }
}

export async function asyncVoid(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

export async function asyncProp(x: number): Promise<number> {
  await new Promise((r) => setTimeout(r, 10));
  return x * 2;
}

export function asyncPropValidator(result: { out: number }): string {
  if (result.out === 10) {
    return "pass";
  }
  return "fail";
}
`;
    fs.writeFileSync(modTsPath, modTsCode);
    const modTranspiled = ts.transpileModule(modTsCode, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    });
    fs.writeFileSync(modJsPath, modTranspiled.outputText);

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

    const adapter = new JestAdapter(tests, modTsPath);
    const testTsCode = adapter.toString();
    const testTranspiled = ts.transpileModule(testTsCode, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    });
    const testJsPath = path.join(tmpDir, "asyncModule.test.js");
    fs.writeFileSync(testJsPath, testTranspiled.outputText);
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "jest-adapter-test" })
    );
    fs.writeFileSync(
      path.join(tmpDir, "jest.config.json"),
      JSON.stringify({ testMatch: ["**/*.test.js"] })
    );

    try {
      const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
      const res = spawnSync(
        npxCmd,
        [
          "jest",
          "asyncModule.test.js",
          "--config=jest.config.json",
          "--colors=false",
        ],
        {
          cwd: tmpDir,
          encoding: "utf8",
          shell: process.platform === "win32",
        }
      );
      expect(res.status).toBe(0);
      expect(res.stderr + res.stdout).toContain("4 passed");
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

    const out = new JestAdapter(tests, "mymodule.ts").toString();
    expect(out).toContain("UnsatisfiedAssumption");
    expect(out).toContain("return 'unknown';");
  });
});
