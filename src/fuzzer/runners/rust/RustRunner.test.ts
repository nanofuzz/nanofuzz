import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RustRunner } from "./RustRunner";
import { RunnerFactory } from "../RunnerFactory";
import { FunctionDef } from "../../analysis/FunctionDef";
import { ArgDef } from "../../analysis/ArgDef";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import * as Parser from "../../adapters/ParserAdapter";
import { FuzzEnv } from "../../Types";
import { getDefaultFuzzExecutionOptions } from "../../FuzzerFactory";

describe("fuzzer/runners/rust/RustRunner: ", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-rustrunner-test-")
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("executes basic Rust functions with numbers and return values", async () => {
    const rsPath = path.join(tempDir, "add.rs");
    fs.writeFileSync(
      rsPath,
      `pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["add"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "add", env);
    await runner.onRunStart();

    const res = await runner.run([10, 32], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe(42);
    }

    await runner.onRunEnd();
  });

  it("executes functions with strings, booleans, and vectors", async () => {
    const rsPath = path.join(tempDir, "compound.rs");
    fs.writeFileSync(
      rsPath,
      `pub fn greet(name: &str, count: i32, uppercase: bool, items: Vec<i32>) -> String {
    let mut msg = format!("Hello, {}! count={} sum={}", name, count, items.iter().sum::<i32>());
    if uppercase {
        msg = msg.to_uppercase();
    }
    msg
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["greet"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "greet", env);
    await runner.onRunStart();

    const res = await runner.run(["Alice", 3, true, [1, 2, 3]], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe("HELLO, ALICE! COUNT=3 SUM=6");
    }

    await runner.onRunEnd();
  });

  it("executes functions taking a seeded PRNG closure and errors when seed is omitted", async () => {
    const rsPath = path.join(tempDir, "prng_test.rs");
    fs.writeFileSync(
      rsPath,
      `pub fn sample(mut prng: impl FnMut() -> f64) -> f64 {
    prng()
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["sample"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "sample", env);
    await runner.onRunStart();

    // Invocation with a seeded PRNG payload succeeds deterministically
    const res1 = await runner.run(
      [{ __nanofuzz_type: "prng", seed: "fixed_seed_abc" }],
      5000
    );
    expect(res1.result.tag).toBe("value");
    if (res1.result.tag === "value") {
      expect(typeof res1.result.value).toBe("number");
      expect(res1.result.value as number).toBeGreaterThanOrEqual(0);
      expect(res1.result.value as number).toBeLessThan(1);
    }

    const res2 = await runner.run(
      [{ __nanofuzz_type: "prng", seed: "fixed_seed_abc" }],
      5000
    );
    expect(res2.result.tag).toBe("value");
    if (res2.result.tag === "value" && res1.result.tag === "value") {
      expect(res2.result.value).toBe(res1.result.value);
    }

    // Invocation without a seed returns an ArgumentError instead of silently faking a seed
    const errRes = await runner.run([{}], 5000);
    expect(errRes.result.tag).toBe("error");
    if (errRes.result.tag === "error") {
      expect(errRes.result.name).toBe("ArgumentError");
      expect(errRes.result.message).toContain(
        "Argument 0 expects a PRNG payload with a valid seed"
      );
    }

    await runner.onRunEnd();
  });

  it("catches panics without terminating the host process", async () => {
    const rsPath = path.join(tempDir, "divide.rs");
    fs.writeFileSync(
      rsPath,
      `pub fn divide(a: i32, b: i32) -> i32 {
    if b == 0 {
        panic!("division by zero");
    }
    a / b
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["divide"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "divide", env);
    await runner.onRunStart();

    // Normal invocation
    const okRes = await runner.run([10, 2], 5000);
    expect(okRes.result.tag).toBe("value");
    if (okRes.result.tag === "value") {
      expect(okRes.result.value).toBe(5);
    }

    // Panic invocation
    const panicRes = await runner.run([10, 0], 5000);
    expect(panicRes.result.tag).toBe("error");
    if (panicRes.result.tag === "error") {
      expect(panicRes.result.name).toBe("Panic");
      expect(panicRes.result.message).toContain("division by zero");
      expect(panicRes.result.source).toBe("put");
    }

    // Process is still alive and responds to subsequent invocations
    const recoverRes = await runner.run([100, 4], 5000);
    expect(recoverRes.result.tag).toBe("value");
    if (recoverRes.result.tag === "value") {
      expect(recoverRes.result.value).toBe(25);
    }

    await runner.onRunEnd();
  });

  it("catches UnsatisfiedAssumption and reports skip", async () => {
    const rsPath = path.join(tempDir, "filtered.rs");
    fs.writeFileSync(
      rsPath,
      `use nanofuzz_runtime::assume;

pub fn must_be_positive(x: i32) -> i32 {
    assume!(x > 0, "x must be positive");
    x * 2
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["must_be_positive"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "must_be_positive", env);
    await runner.onRunStart();

    // Valid input
    const okRes = await runner.run([5], 5000);
    expect(okRes.result.tag).toBe("value");
    if (okRes.result.tag === "value") {
      expect(okRes.result.value).toBe(10);
    }

    // Skipped input (unsatisfied assumption)
    const skipRes = await runner.run([-3], 5000);
    expect(skipRes.result.tag).toBe("skip");
    if (skipRes.result.tag === "skip") {
      expect(skipRes.result.message).toBe("x must be positive");
    }

    await runner.onRunEnd();
  });

  it("executes property validators in-host", async () => {
    const rsPath = path.join(tempDir, "validator_test.rs");
    fs.writeFileSync(
      rsPath,
      `use nanofuzz_runtime::FuzzTestResult;

pub fn double(x: i32) -> i32 {
    x * 2
}

pub fn doubleValidator(r: &FuzzTestResult) -> &'static str {
    let in_val: i32 = r.get_in(0).unwrap();
    let out_val: i32 = r.get_out().unwrap();
    if out_val == in_val * 2 {
        "pass"
    } else {
        "fail"
    }
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["double"];
    const validatorDef = program.functionsExported["doubleValidator"];
    const env = createTestEnv(fnDef, [validatorDef.getRef()]);

    const runner = new RustRunner(rsPath, "double", env);
    await runner.onRunStart();

    const res = await runner.run([7], 5000, ["doubleValidator"]);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe(14);
      expect(res.result.validators).toBeDefined();
      expect(res.result.validators!["doubleValidator"]).toEqual({
        tag: "value",
        value: "pass",
      });
    }

    await runner.onRunEnd();
  });

  it("handles timeouts and recovers cleanly on subsequent calls", async () => {
    const rsPath = path.join(tempDir, "timeout_test.rs");
    fs.writeFileSync(
      rsPath,
      `pub fn loop_or_add(hang: bool, a: i32) -> i32 {
    if hang {
        loop {}
    }
    a + 1
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["loop_or_add"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "loop_or_add", env);
    await runner.onRunStart();

    // Call that times out
    const timeoutRes = await runner.run([true, 10], 100);
    expect(timeoutRes.result.tag).toBe("timeout");

    // Next call spawns a fresh host and succeeds
    const okRes = await runner.run([false, 10], 5000);
    expect(okRes.result.tag).toBe("value");
    if (okRes.result.tag === "value") {
      expect(okRes.result.value).toBe(11);
    }

    await runner.onRunEnd();
  });

  it("is instantiated correctly via RunnerFactory", () => {
    const rsPath = path.join(tempDir, "sample.rs");
    fs.writeFileSync(rsPath, "pub fn add(a: i32) -> i32 { a }");

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["add"];
    const env = createTestEnv(fnDef);

    const runner = RunnerFactory(env, rsPath, "add");
    expect(runner instanceof RustRunner).toBeTrue();
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

function createTestEnv(
  fnDef: FunctionDef,
  validators: FuzzEnv["validators"] = []
): FuzzEnv {
  return {
    function: fnDef,
    options: {
      argDefaults: ArgDef.getDefaultOptions(),
      maxTests: 100,
      maxDupeInputs: 50,
      maxFailures: 0,
      fnTimeout: 100,
      suiteTimeout: 0,
      useImplicit: true,
      useHuman: false,
      useProperty: validators.length > 0,
      useTransformer: false,
      measures: {
        CoverageMeasure: { enabled: true, weight: 1 },
        FailedTestMeasure: { enabled: true, weight: 1 },
      },
      generators: {
        RandomInputGenerator: { enabled: true },
        MutationInputGenerator: { enabled: false },
        AiInputGenerator: { enabled: false },
        UserInputGenerator: { enabled: false },
      },
    },
    executionOptions: getDefaultFuzzExecutionOptions(),
    validators,
    transformers: [],
    userGenerators: [],
  };
} // fn: createTestEnv
