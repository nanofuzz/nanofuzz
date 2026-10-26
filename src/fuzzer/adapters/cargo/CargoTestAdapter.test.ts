import { CargoTestAdapter } from "./CargoTestAdapter";
import * as TestAdapterFactory from "../TestAdapterFactory";
import * as Config from "../../../Config";
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
    expect(out).toContain("extern crate nanofuzz_runtime;");
    expect(out).toContain(
      "use nanofuzz_runtime::{FuzzTestResult, ValidatorResult};"
    );
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

  it("emits reproduction banner when test failed due to an active sanitizer", () => {
    Config.override("nanofuzz.rust.sanitizer", "borrow");
    const tests: FuzzTests = {
      version: "0.4.0",
      functions: {
        badBorrowFn: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 42,
                  origin: {
                    type: "generator",
                    generator: "RandomInputGenerator",
                  },
                },
              ],
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  value: "BorrowSanitizerError: conflicting write",
                  isException: true,
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
    expect(out).toContain(
      "// [NaNofuzz] Note: This failure was detected by BorrowSanitizer."
    );
    expect(out).toContain(
      '// Run with: RUSTFLAGS="-Zsanitizer=borrow" cargo test'
    );
    expect(out).toContain("#[should_panic]");
    Config.override("nanofuzz.rust.sanitizer", "none");
  }); // fn: emits reproduction banner

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

pub fn divide(a: f64, b: f64) -> f64 {
    a / b
}

pub fn sqrt(a: f64) -> f64 {
    a.sqrt()
}

pub fn divide_f32(a: f32, b: f32) -> f32 {
    a / b
}

pub fn opt_inc(x: Option<i32>) -> Option<i32> {
    x.map(|n| n + 1)
}

pub fn opt_msg(s: Option<String>) -> Option<String> {
    s.map(|v| format!("msg: {}", v))
}

pub fn opt_sqrt(x: f64) -> Option<f64> {
    if x < 0.0 {
        Some(f64::NAN)
    } else if x == 0.0 {
        None
    } else {
        Some(x.sqrt())
    }
}

pub fn next_char(c: char) -> char {
    if c == 'z' {
        'a'
    } else {
        ((c as u8) + 1) as char
    }
}

pub fn add_u64(a: u64, b: u64) -> u64 {
    a + b
}

pub fn scale_vec(v: Vec<f64>, factor: f64) -> Vec<f64> {
    v.into_iter().map(|x| x * factor).collect()
}

pub fn swap_pair(pair: (i32, f64)) -> (f64, i32) {
    (pair.1, pair.0)
}

pub fn greet_slice(name: &str) -> String {
    format!("Hello, {}!", name)
}

pub fn word_counts(words: Vec<String>) -> std::collections::HashMap<String, i32> {
    let mut map = std::collections::HashMap::new();
    for w in words {
        *map.entry(w).or_insert(0) += 1;
    }
    map
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
        divide: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "a",
                  offset: 0,
                  value: 6.0,
                  origin: { type: "user" },
                },
                {
                  name: "b",
                  offset: 1,
                  value: 2.0,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: 3,
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        sqrt: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "a",
                  offset: 0,
                  value: -1.0,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: NaN,
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        divide_f32: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "a",
                  offset: 0,
                  value: 6.0,
                  origin: { type: "user" },
                },
                {
                  name: "b",
                  offset: 1,
                  value: 2.0,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: 3,
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        opt_inc: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "x",
                  offset: 0,
                  value: 42,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: 43,
                  origin: { type: "user" },
                },
              ],
            },
            "1": {
              input: [
                {
                  name: "x",
                  offset: 0,
                  value: null,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: null,
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        opt_msg: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "s",
                  offset: 0,
                  value: "world",
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: "msg: world",
                  origin: { type: "user" },
                },
              ],
            },
            "1": {
              input: [
                {
                  name: "s",
                  offset: 0,
                  value: null,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: null,
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        opt_sqrt: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "x",
                  offset: 0,
                  value: -1.0,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: NaN,
                  origin: { type: "user" },
                },
              ],
            },
            "1": {
              input: [
                {
                  name: "x",
                  offset: 0,
                  value: 4.0,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: 2.0,
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        next_char: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "c",
                  offset: 0,
                  value: "a",
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: "b",
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        add_u64: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "a",
                  offset: 0,
                  value: 100,
                  origin: { type: "user" },
                },
                {
                  name: "b",
                  offset: 1,
                  value: 200,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: 300,
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        scale_vec: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "v",
                  offset: 0,
                  value: [1.0, 2.0],
                  origin: { type: "user" },
                },
                {
                  name: "factor",
                  offset: 1,
                  value: 3.0,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: [3.0, 6.0],
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        swap_pair: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "pair",
                  offset: 0,
                  value: [42, 3.5],
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: [3.5, 42],
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        greet_slice: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "name",
                  offset: 0,
                  value: "Alice",
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: "Hello, Alice!",
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        word_counts: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "words",
                  offset: 0,
                  value: ["apple", "banana", "apple"],
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: {
                    apple: 2,
                    banana: 1,
                  },
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

    expect(testCode).toContain("assert_eq!(actual, 3.0f64);");
    expect(testCode).toContain("assert!(actual.is_nan());");
    expect(testCode).toContain("assert_eq!(actual, 3.0f32);");
    expect(testCode).toContain("assert_eq!(actual, Some(43i32));");
    expect(testCode).toContain("assert_eq!(actual, None);");
    expect(testCode).toContain(
      'assert_eq!(actual, Some(String::from("msg: world")));'
    );
    expect(testCode).toContain(
      "assert!(actual.map_or(false, |v| v.is_nan()));"
    );
    expect(testCode).toContain("assert_eq!(actual, 'b');");
    expect(testCode).toContain("assert_eq!(actual, 300u64);");
    expect(testCode).toContain("assert_eq!(actual, vec![3.0f64, 6.0f64]);");
    expect(testCode).toContain("assert_eq!(actual, (3.5f64, 42i32));");
    expect(testCode).toContain(
      'assert_eq!(actual, String::from("Hello, Alice!"));'
    );

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
    expect(res.stdout).toContain("20 passed");
  });

  it("emits __nanofuzz_get__ shim for unexported function and passes cargo test", () => {
    // Setup a cargo project with an unexported function in tests/private_lib.rs
    const srcDir = path.join(tempDir, "src");
    const testsDir = path.join(tempDir, "tests");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(testsDir, { recursive: true });

    const runtimePath = path
      .resolve("./packages/runtime/rust")
      .replace(/\\/g, "/");
    fs.writeFileSync(
      path.join(tempDir, "Cargo.toml"),
      `[package]
name = "unexport_test_crate"
version = "0.1.0"
edition = "2021"

[dependencies]
nanofuzz-runtime = { path = "${runtimePath}" }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
`
    );

    const modPath = path.join(testsDir, "private_lib.rs");
    fs.writeFileSync(
      modPath,
      `
fn private_multiply(x: i32, factor: i32) -> i32 {
    x * factor
}
`
    );

    const tests: FuzzTests = {
      version: "0.4.0",
      functions: {
        private_multiply: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "x",
                  offset: 0,
                  value: 6,
                  origin: { type: "user" },
                },
                {
                  name: "factor",
                  offset: 1,
                  value: 7,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "out",
                  offset: 0,
                  value: 42,
                  origin: { type: "user" },
                },
              ],
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

    expect(testCode).toContain(
      "pub fn __nanofuzz_get__(arg_0: i32, arg_1: i32) -> i32"
    );
    expect(testCode).toContain("private_multiply(arg_0, arg_1)");
    expect(testCode).toContain("target::__nanofuzz_get__(6i32, 7i32)");

    const res = spawnSync(
      "cargo",
      [
        "test",
        "--manifest-path",
        path.join(tempDir, "Cargo.toml"),
        "--test",
        "private_lib_nano_test",
      ],
      {
        cwd: tempDir,
        encoding: "utf8",
      }
    );

    expect(res.status)
      .withContext(`stdout: ${res.stdout}\nstderr: ${res.stderr}`)
      .toBe(0);
    expect(res.stdout).toContain("1 passed");
  });
});
