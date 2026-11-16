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

  it("executes functions with Box and VecDeque through the runner", async () => {
    const rsPath = path.join(tempDir, "containers.rs");
    fs.writeFileSync(
      rsPath,
      `use std::collections::VecDeque;

pub fn modify_containers(
    mut b: Box<i32>,
    mut q: VecDeque<String>
) -> (Box<i32>, VecDeque<String>) {
    *b += 10;
    q.push_back("end".to_string());
    (b, q)
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["modify_containers"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "modify_containers", env);
    await runner.onRunStart();

    const res = await runner.run([5, ["start"]], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toEqual([15, ["start", "end"]]);
    }

    await runner.onRunEnd();
  });

  it("executes functions with Rc and Arc through the runner", async () => {
    const rsPath = path.join(tempDir, "shared_ptrs.rs");
    fs.writeFileSync(
      rsPath,
      `use std::rc::Rc;
use std::sync::Arc;

pub fn shared_ptrs(r: Rc<i32>, a: Arc<String>) -> (i32, String) {
    (*r + 1, format!("{}_arc", *a))
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["shared_ptrs"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "shared_ptrs", env);
    await runner.onRunStart();

    const res = await runner.run([41, "nanofuzz"], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toEqual([42, "nanofuzz_arc"]);
    }

    await runner.onRunEnd();
  });

  it("executes functions with Maps, Sets, Options, Tuples, Slices, and Fixed Arrays through the runner", async () => {
    const rsPath = path.join(tempDir, "all_collections.rs");
    fs.writeFileSync(
      rsPath,
      `use std::collections::{HashMap, HashSet};

pub fn check_all(
    map: HashMap<String, i32>,
    set: HashSet<i32>,
    opt: Option<String>,
    pair: (i32, bool),
    slice: &[i32],
    arr: [i32; 2],
    ch: char
) -> (i32, usize, String, i32, i32, i32, String) {
    let map_sum: i32 = map.values().sum();
    let set_size = set.len();
    let opt_val = opt.unwrap_or_else(|| "none".to_string());
    let pair_sum = if pair.1 { pair.0 * 2 } else { pair.0 };
    let slice_sum: i32 = slice.iter().sum();
    let arr_sum: i32 = arr[0] + arr[1];
    let ch_str = ch.to_string();
    (map_sum, set_size, opt_val, pair_sum, slice_sum, arr_sum, ch_str)
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["check_all"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "check_all", env);
    await runner.onRunStart();

    // Test with values populated
    const res1 = await runner.run(
      [
        { a: 10, b: 20 },
        [1, 2, 3],
        "some_val",
        [7, true],
        [1, 2, 3, 4],
        [100, 200],
        "Z",
      ],
      5000
    );
    expect(res1.result.tag).toBe("value");
    if (res1.result.tag === "value") {
      expect(res1.result.value).toEqual([30, 3, "some_val", 14, 10, 300, "Z"]);
    }

    // Test with Option as null (None), empty collections
    const res2 = await runner.run(
      [{}, [], null, [5, false], [], [0, 0], "a"],
      5000
    );
    expect(res2.result.tag).toBe("value");
    if (res2.result.tag === "value") {
      expect(res2.result.value).toEqual([0, 0, "none", 5, 0, 0, "a"]);
    }

    await runner.onRunEnd();
  });

  // TODO: also add oxcaml runner and parity tests once OCaml/OxCaml support is added
  it("executes functions taking a PRNG closure with and without seed", async () => {
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
      if (typeof res1.result.value === "number") {
        expect(res1.result.value).toBeGreaterThanOrEqual(0);
        expect(res1.result.value).toBeLessThan(1);
      }
    }

    const res2 = await runner.run(
      [{ __nanofuzz_type: "prng", seed: "fixed_seed_abc" }],
      5000
    );
    expect(res2.result.tag).toBe("value");
    if (res2.result.tag === "value" && res1.result.tag === "value") {
      expect(res2.result.value).toBe(res1.result.value);
    }

    // Invocation without a seed runs unseeded / pure random and succeeds
    const unseededRes = await runner.run([{}], 5000);
    expect(unseededRes.result.tag).toBe("value");
    if (unseededRes.result.tag === "value") {
      expect(typeof unseededRes.result.value).toBe("number");
      if (typeof unseededRes.result.value === "number") {
        expect(unseededRes.result.value).toBeGreaterThanOrEqual(0);
        expect(unseededRes.result.value).toBeLessThan(1);
      }
    }

    await runner.onRunEnd();
  });

  it("executes functions taking and returning structs over MsgPack IPC", async () => {
    const rsPath = path.join(tempDir, "struct_test.rs");
    fs.writeFileSync(
      rsPath,
      `pub struct User {
    pub name: String,
    pub age: u32,
    pub active: bool,
}

pub fn promote_user(u: User) -> User {
    User {
        name: format!("VIP_{}", u.name),
        age: u.age + 1,
        active: true,
    }
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["promote_user"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "promote_user", env);
    await runner.onRunStart();

    const res = await runner.run(
      [{ name: "Alice", age: 30, active: false }],
      5000
    );
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toEqual({
        name: "VIP_Alice",
        age: 31,
        active: true,
      });
    }

    await runner.onRunEnd();
  });

  it("executes functions with enums and Result over MsgPack IPC", async () => {
    const rsPath = path.join(tempDir, "enum_result_test.rs");
    fs.writeFileSync(
      rsPath,
      `pub enum Action {
    Increment(i32),
    Reset,
}

pub fn handle_action(state: i32, action: Action) -> Result<i32, String> {
    match action {
        Action::Increment(val) => {
            if val < 0 {
                Err("cannot increment by negative".to_string())
            } else {
                Ok(state + val)
            }
        }
        Action::Reset => Ok(0),
    }
}
`
    );

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["handle_action"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "handle_action", env);
    await runner.onRunStart();

    // Data variant returning Ok
    const res1 = await runner.run([10, { Increment: 5 }], 5000);
    expect(res1.result.tag).toBe("value");
    if (res1.result.tag === "value") {
      expect(res1.result.value).toEqual({ Ok: 15 });
    }

    // Data variant returning Err
    const res2 = await runner.run([10, { Increment: -5 }], 5000);
    expect(res2.result.tag).toBe("value");
    if (res2.result.tag === "value") {
      expect(res2.result.value).toEqual({
        Err: "cannot increment by negative",
      });
    }

    // Unit variant returning Ok
    const res3 = await runner.run([10, "Reset"], 5000);
    expect(res3.result.tag).toBe("value");
    if (res3.result.tag === "value") {
      expect(res3.result.value).toEqual({ Ok: 0 });
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

  it("recovers from host abort with sanitizer diagnostic and respawns host", async () => {
    const rsPath = path.join(tempDir, "sanitizer_abort.rs");
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

    // Verify initial run succeeds
    const res1 = await runner.run([1, 2], 5000);
    expect(res1.result.tag).toBe("value");

    // Simulate active borrow sanitizer on the runner
    runner.setSanitizerNameForTest("borrow");

    runner.simulateHostAbortForTest(
      "==12345==ERROR: BorrowSanitizer: conflicting write to active shared borrow at 0x7fff\n" +
        "    #0 0x555555562143 in target::add (src/target_instrumented.rs:2)\n"
    );

    // Next run should detect the sanitizer abort and return BorrowSanitizerError
    const res2 = await runner.run([3, 4], 5000);
    expect(res2.result.tag).toBe("error");
    if (res2.result.tag === "error") {
      expect(res2.result.name).toBe("BorrowSanitizerError");
      expect(res2.result.message).toContain(
        "conflicting write to active shared borrow"
      );
    }

    // Runner should re-arm and run subsequent inputs cleanly
    runner.setSanitizerNameForTest("none");
    const res3 = await runner.run([5, 6], 5000);
    expect(res3.result.tag).toBe("value");
    if (res3.result.tag === "value") {
      expect(res3.result.value).toBe(11);
    }

    await runner.onRunEnd();
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
