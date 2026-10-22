import { CargoTestAdapter } from "./CargoTestAdapter";
import * as TestAdapterFactory from "../TestAdapterFactory";
import { FuzzOptions, FuzzTests } from "../../Types";
import { ArgOptions, ArgTag } from "../../analysis/Types";
import * as Parser from "../../adapters/ParserAdapter";
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
  UserInputGenerator: { enabled: false },
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

describe("fuzzer/adapters/cargo/CargoTestAdapter:", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-cargotest-")
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("emits unit test fn for all generated scenarios", () => {
    const tests: FuzzTests = {
      version: "0.4.0",
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
                  value: 10,
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
                  value: 20,
                  origin: { type: "user" },
                },
              ],
            },
            "1": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: -5,
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
        heuristicFn: {
          options: makeOptions({ useImplicit: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 42,
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

    const out = new CargoTestAdapter(tests, "mymodule.rs").toString();

    expect(out).toContain("fn test_sampleFn_0_expect()");
    expect(out).toContain("fn test_sampleFn_0_prop_Validator()");
    expect(out).toContain("fn test_sampleFn_1_expect()");
    expect(out).toContain("#[should_panic]");
    expect(out).toContain("fn test_voidFn_0_heuristic()");
    expect(out).toContain("fn test_heuristicFn_0_heuristic()");
    expect(out).toContain("assert!(nanofuzz_runtime::implicit_oracle(&res));");
    expect(out).toContain("mod target {");
    expect(out).toContain('include!("./mymodule.rs");');
  });

  it("names nano test filename correctly", () => {
    const adapter = new CargoTestAdapter(
      { version: "0.4.0", functions: {} },
      "/path/to/my_math.rs"
    );
    expect(adapter.filename).toBe("/path/to/my_math_nano_test.rs");
    expect(adapter.toolname).toBe("Cargo");
  });

  it("integrates with TestAdapterFactory", () => {
    const adapter = TestAdapterFactory.fromSourceFilename("target.rs", {
      version: "0.4.0",
      functions: {},
    });
    expect(adapter instanceof CargoTestAdapter).toBeTrue();
    expect(adapter.toolname).toBe("Cargo");
  });

  it("compiles and executes synthesized Rust regression tests via cargo test", () => {
    const runtimePath = path.resolve("./packages/runtime/rust");
    fs.writeFileSync(
      path.join(tempDir, "Cargo.toml"),
      `[package]
name = "test_crate"
version = "0.1.0"
edition = "2021"

[dependencies]
nanofuzz-runtime = { path = "${runtimePath.replace(/\\/g, "/")}" }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

[[test]]
name = "math_lib_nano_test"
path = "src/math_lib_nano_test.rs"
`
    );

    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    const modPath = path.join(srcDir, "math_lib.rs");
    fs.writeFileSync(
      modPath,
      `use nanofuzz_runtime::FuzzTestResult;

pub fn add(a: i32, b: i32) -> i32 {
    if a < 0 {
        panic!("negative a not allowed");
    }
    a + b
}

pub fn add_prop(a: i32, b: i32) -> i32 {
    a + b
}

pub fn addValidator(r: &FuzzTestResult) -> &'static str {
    let a: i32 = r.get_in(0).unwrap();
    let b: i32 = r.get_in(1).unwrap();
    let out: i32 = r.get_out().unwrap();
    if a + b == out { "pass" } else { "fail" }
}

pub fn add_heuristic(a: i32, b: i32) -> i32 {
    a + b
}

pub fn reset_all() {
}
`
    );

    const tests: FuzzTests = {
      version: "0.4.0",
      functions: {
        add: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "a",
                  offset: 0,
                  value: 10,
                  origin: { type: "user" },
                },
                {
                  name: "b",
                  offset: 1,
                  value: 20,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: 30,
                  origin: { type: "user" },
                },
              ],
            },
            "1": {
              input: [
                {
                  name: "a",
                  offset: 0,
                  value: -5,
                  origin: { type: "user" },
                },
                {
                  name: "b",
                  offset: 1,
                  value: 10,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
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
        add_prop: {
          options: makeOptions({ useProperty: true }),
          validators: ["addValidator"],
          tests: {
            "0": {
              input: [
                {
                  name: "a",
                  offset: 0,
                  value: 5,
                  origin: { type: "user" },
                },
                {
                  name: "b",
                  offset: 1,
                  value: 7,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
            },
          },
          isVoid: false,
        },
        reset_all: {
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
        },
        add_heuristic: {
          options: makeOptions({ useImplicit: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "a",
                  offset: 0,
                  value: 3,
                  origin: { type: "user" },
                },
                {
                  name: "b",
                  offset: 1,
                  value: 4,
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

    const adapter = new CargoTestAdapter(tests, modPath);
    const testCode = adapter.toString();
    const testPath = adapter.filename;
    fs.writeFileSync(testPath, testCode);

    // Run cargo test in the temp crate
    const res = spawnSync(
      "cargo",
      [
        "test",
        "--manifest-path",
        path.join(tempDir, "Cargo.toml"),
        "--test",
        "math_lib_nano_test",
      ],
      {
        cwd: tempDir,
        encoding: "utf8",
      }
    );

    expect(res.status)
      .withContext(`stdout: ${res.stdout}\nstderr: ${res.stderr}`)
      .toBe(0);
    expect(res.stdout).toContain("5 passed");
  });
});
