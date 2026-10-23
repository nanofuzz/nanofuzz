import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OxcamlRunner } from "./OxcamlRunner";
import { RunnerFactory } from "../RunnerFactory";
import { FunctionDef } from "../../analysis/FunctionDef";
import { ArgDef } from "../../analysis/ArgDef";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import * as Parser from "../../adapters/ParserAdapter";
import { FuzzEnv } from "../../Types";
import { getDefaultFuzzExecutionOptions } from "../../FuzzerFactory";
import { OxcamlCompiler } from "../../compilers/oxcaml/OxcamlCompiler";

describe("fuzzer/runners/oxcaml/OxcamlRunner: ", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-oxcamlrunner-test-")
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

  it("executes basic OCaml functions with numbers and return values", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "add.ml");
    fs.writeFileSync(
      mlPath,
      `let add (a : int) (b : int) : int =
  a + b
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["add"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "add", env);
    await runner.onRunStart();

    const res = await runner.run([10, 32], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe(42);
    }

    await runner.onRunEnd();
  });

  it("executes functions with strings, booleans, and lists", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "compound.ml");
    fs.writeFileSync(
      mlPath,
      `let greet (name : string) (count : int) (uppercase : bool) (items : int list) : string =
  let sum = List.fold_left (+) 0 items in
  let msg = Printf.sprintf "Hello, %s! count=%d sum=%d" name count sum in
  if uppercase then String.uppercase_ascii msg else msg
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["greet"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "greet", env);
    await runner.onRunStart();

    const res = await runner.run(["Alice", 3, true, [1, 2, 3]], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe("HELLO, ALICE! COUNT=3 SUM=6");
    }

    await runner.onRunEnd();
  });

  it("catches exceptions without terminating the host process", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "divide.ml");
    fs.writeFileSync(
      mlPath,
      `let divide (a : int) (b : int) : int =
  if b = 0 then
    raise (Failure "division by zero")
  else
    a / b
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["divide"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "divide", env);
    await runner.onRunStart();

    // Normal invocation
    const okRes = await runner.run([10, 2], 5000);
    expect(okRes.result.tag).toBe("value");
    if (okRes.result.tag === "value") {
      expect(okRes.result.value).toBe(5);
    }

    // Exception invocation
    const errRes = await runner.run([10, 0], 5000);
    expect(errRes.result.tag).toBe("error");
    if (errRes.result.tag === "error") {
      expect(errRes.result.message).toContain("division by zero");
      expect(errRes.result.stack).toBeDefined();
      expect(errRes.result.stack).toContain("divide.ml");
    }

    // Host should still be alive and responsive
    const nextOkRes = await runner.run([20, 4], 5000);
    expect(nextOkRes.result.tag).toBe("value");
    if (nextOkRes.result.tag === "value") {
      expect(nextOkRes.result.value).toBe(5);
    }

    await runner.onRunEnd();
  });

  it("executes in-host property validators and reports pass/fail", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "validator_test.ml");
    fs.writeFileSync(
      mlPath,
      `let double (x : int) : int =
  x * 2

let doubleValidator (result : Nanofuzz_runtime.fuzz_test_result) : Nanofuzz_runtime.validator_result =
  match Nanofuzz_runtime.get_in 0 result with
  | Some (\`Int x) ->
    (match Nanofuzz_runtime.get_out result with
     | \`Int out_val ->
       if out_val = x * 2 then Nanofuzz_runtime.Pass else Nanofuzz_runtime.Fail
     | _ -> Nanofuzz_runtime.Unknown)
  | _ -> Nanofuzz_runtime.Unknown
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["double"];
    const validatorDef = program.functionsExported["doubleValidator"];
    expect(validatorDef).toBeDefined();

    const env = createTestEnv(fnDef, [validatorDef.getRef()]);

    const runner = new OxcamlRunner(mlPath, "double", env);
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
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "timeout_test.ml");
    fs.writeFileSync(
      mlPath,
      `let loop_or_add (hang : bool) (a : int) : int =
  if hang then
    let rec loop () = loop () in loop ()
  else
    a + 1
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["loop_or_add"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "loop_or_add", env);
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
    const mlPath = path.join(tempDir, "sample.ml");
    fs.writeFileSync(mlPath, "let add (a : int) : int = a");

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["add"];
    const env = createTestEnv(fnDef);

    const runner = RunnerFactory(env, mlPath, "add");
    expect(runner instanceof OxcamlRunner).toBeTrue();
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
