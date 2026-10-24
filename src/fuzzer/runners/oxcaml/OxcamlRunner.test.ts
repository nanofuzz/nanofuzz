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

  it("executes functions with record types over the IPC bridge", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "record_test.ml");
    fs.writeFileSync(
      mlPath,
      `type user = { name : string; age : int }

let birthday (u : user) : user =
  { name = u.name; age = u.age + 1 }
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["birthday"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "birthday", env);
    await runner.onRunStart();

    const res = await runner.run([{ name: "Alice", age: 30 }], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toEqual({ name: "Alice", age: 31 });
    }

    await runner.onRunEnd();
  });

  it("executes functions with Hashtbl types over the IPC bridge", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "hashtbl_test.ml");
    fs.writeFileSync(
      mlPath,
      `let scale_hashtbl (tbl : (string, int) Hashtbl.t) : (string, int) Hashtbl.t =
  let out = Hashtbl.create (Hashtbl.length tbl) in
  Hashtbl.iter (fun k v -> Hashtbl.add out k (v * 10)) tbl;
  out
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["scale_hashtbl"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "scale_hashtbl", env);
    await runner.onRunStart();

    const inputMap = new Map([
      ["apple", 2],
      ["banana", 5],
    ]);
    const res = await runner.run([inputMap], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toEqual(
        new Map([
          ["apple", 20],
          ["banana", 50],
        ])
      );
    }

    await runner.onRunEnd();
  });

  it("executes functions with Set and Map functor types over the IPC bridge", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "functors_test.ml");
    fs.writeFileSync(
      mlPath,
      `module IntSet = Set.Make(Int)
module StringMap = Map.Make(String)

let double_set (s : IntSet.t) : IntSet.t =
  IntSet.map (fun x -> x * 2) s

let uppercase_map (m : int StringMap.t) : int StringMap.t =
  StringMap.fold (fun k v acc -> StringMap.add (String.uppercase_ascii k) v acc) m StringMap.empty
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");

    // Test Set
    const setDef = program.functionsExported["double_set"];
    const setEnv = createTestEnv(setDef);
    const setRunner = new OxcamlRunner(mlPath, "double_set", setEnv);
    await setRunner.onRunStart();

    const setRes = await setRunner.run([new Set([1, 2, 3])], 5000);
    expect(setRes.result.tag).toBe("value");
    if (setRes.result.tag === "value") {
      expect(setRes.result.value).toEqual(new Set([2, 4, 6]));
    }
    await setRunner.onRunEnd();

    // Test Map
    const mapDef = program.functionsExported["uppercase_map"];
    const mapEnv = createTestEnv(mapDef);
    const mapRunner = new OxcamlRunner(mlPath, "uppercase_map", mapEnv);
    await mapRunner.onRunStart();

    const mapRes = await mapRunner.run(
      [
        new Map([
          ["hello", 1],
          ["world", 2],
        ]),
      ],
      5000
    );
    expect(mapRes.result.tag).toBe("value");
    if (mapRes.result.tag === "value") {
      expect(mapRes.result.value).toEqual(
        new Map([
          ["HELLO", 1],
          ["WORLD", 2],
        ])
      );
    }
    await mapRunner.onRunEnd();
  });

  it("executes functions with association lists over the IPC bridge", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "assoc_test.ml");
    fs.writeFileSync(
      mlPath,
      `let inc_assoc (l : (string * int) list) : (string * int) list =
  List.map (fun (k, v) -> (k, v + 1)) l
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["inc_assoc"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "inc_assoc", env);
    await runner.onRunStart();

    const res = await runner.run(
      [
        [
          ["a", 10],
          ["b", 20],
        ],
      ],
      5000
    );
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toEqual([
        ["a", 11],
        ["b", 21],
      ]);
    }

    await runner.onRunEnd();
  });

  it("executes functions with list types over the IPC bridge", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "list_ipc_test.ml");
    fs.writeFileSync(
      mlPath,
      `let double_list (l : int list) : int list =
  List.map (fun x -> x * 2) l
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["double_list"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "double_list", env);
    await runner.onRunStart();

    const res = await runner.run([[1, 2, 3]], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toEqual([2, 4, 6]);
    }

    await runner.onRunEnd();
  });

  it("executes functions with array types over the IPC bridge", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "array_ipc_test.ml");
    fs.writeFileSync(
      mlPath,
      `let inc_array (arr : int array) : int array =
  Array.map (fun x -> x + 1) arr
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["inc_array"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "inc_array", env);
    await runner.onRunStart();

    const res = await runner.run([[10, 20, 30]], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toEqual([11, 21, 31]);
    }

    await runner.onRunEnd();
  });

  it("executes functions with tuple types over the IPC bridge", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "tuple_ipc_test.ml");
    fs.writeFileSync(
      mlPath,
      `let swap_pair (p : int * string) : string * int =
  let (n, s) = p in (s, n)
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["swap_pair"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "swap_pair", env);
    await runner.onRunStart();

    const res = await runner.run([[42, "hello"]], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toEqual(["hello", 42]);
    }

    await runner.onRunEnd();
  });

  it("executes functions with option types over the IPC bridge", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "option_ipc_test.ml");
    fs.writeFileSync(
      mlPath,
      `let bump_opt (opt : int option) : int option =
  match opt with
  | Some n -> Some (n + 10)
  | None -> None
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["bump_opt"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "bump_opt", env);
    await runner.onRunStart();

    const someRes = await runner.run([5], 5000);
    expect(someRes.result.tag).toBe("value");
    if (someRes.result.tag === "value") {
      expect(someRes.result.value).toBe(15);
    }

    const noneRes = await runner.run([null], 5000);
    expect(noneRes.result.tag).toBe("value");
    if (noneRes.result.tag === "value") {
      expect(noneRes.result.value).toBeNull();
    }

    await runner.onRunEnd();
  });

  it("executes functions with bytes types over the IPC bridge", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "bytes_ipc_test.ml");
    fs.writeFileSync(
      mlPath,
      `let reverse_bytes (b : bytes) : bytes =
  let len = Bytes.length b in
  let res = Bytes.create len in
  for i = 0 to len - 1 do
    Bytes.set res i (Bytes.get b (len - 1 - i))
  done;
  res
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["reverse_bytes"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "reverse_bytes", env);
    await runner.onRunStart();

    const inputBytes = new Uint8Array([1, 2, 3, 4]);
    const res = await runner.run([inputBytes], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toEqual(new Uint8Array([4, 3, 2, 1]));
    }

    await runner.onRunEnd();
  });

  it("executes functions with nested record types over the IPC bridge", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "nested_record_test.ml");
    fs.writeFileSync(
      mlPath,
      `type person = { name : string; age : int }
type company = { boss : person; title : string }

let promote (c : company) : company =
  { boss = { name = c.boss.name; age = c.boss.age + 1 }; title = "Senior " ^ c.title }
`
    );

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["promote"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "promote", env);
    await runner.onRunStart();

    const companyInput = {
      boss: { name: "Dave", age: 40 },
      title: "Engineer",
    };
    const res = await runner.run([companyInput], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toEqual({
        boss: { name: "Dave", age: 41 },
        title: "Senior Engineer",
      });
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
