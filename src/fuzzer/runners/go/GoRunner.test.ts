import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GoRunner } from "./GoRunner";
import { RunnerFactory } from "../RunnerFactory";
import * as Parser from "../../adapters/ParserAdapter";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import { FuzzEnv } from "../../Types";
import { getDefaultFuzzExecutionOptions } from "../../FuzzerFactory";
import { intOptions } from "../../FuzzerTestHelper";

function makeTestEnv(file: string, fn: string): FuzzEnv {
  const pgm = ProgramFactory.fromFile(file, "go");
  const fnDef = pgm.functions[fn];
  return {
    function: fnDef,
    options: intOptions,
    executionOptions: getDefaultFuzzExecutionOptions(),
    validators: [],
    transformers: [],
    userGenerators: [],
  };
} // fn: makeTestEnv

describe("fuzzer/runners/go/GoRunner: ", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-gorunner-test-")
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

  it("instantiates GoRunner via RunnerFactory", () => {
    const goFile = path.join(tempDir, "math.go");
    fs.writeFileSync(
      goFile,
      "package mathutil\nfunc Add(a, b int) int { return a + b }\n"
    );
    const env = makeTestEnv(goFile, "Add");
    const runner = RunnerFactory(env, goFile, "Add");
    expect(runner instanceof GoRunner).toBeTrue();
  });

  it("compiles and runs a basic Go function and returns value", async () => {
    const goFile = path.join(tempDir, "calc.go");
    fs.writeFileSync(
      goFile,
      `package calc

func Multiply(a int, b int) int {
    return a * b
}
`
    );

    const env = makeTestEnv(goFile, "Multiply");
    const runner = new GoRunner(goFile, "Multiply", env);
    await runner.onRunStart();

    const res = await runner.run([6, 7]);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe(42);
    }
    runner.killHost();
  });

  it("captures panics and reports them as errors", async () => {
    const goFile = path.join(tempDir, "panic_test.go");
    fs.writeFileSync(
      goFile,
      `package panictest

func MustBePositive(n int) int {
    if n <= 0 {
        panic("must be positive")
    }
    return n * 2
}
`
    );

    const env = makeTestEnv(goFile, "MustBePositive");
    const runner = new GoRunner(goFile, "MustBePositive", env);
    await runner.onRunStart();

    const resFail = await runner.run([-5]);
    expect(resFail.result.tag).toBe("error");
    if (resFail.result.tag === "error") {
      expect(resFail.result.message).toContain("must be positive");
    }

    const resOk = await runner.run([10]);
    expect(resOk.result.tag).toBe("value");
    if (resOk.result.tag === "value") {
      expect(resOk.result.value).toBe(20);
    }
    runner.killHost();
  });

  it("round-trips structs, slices, maps, and pointers across the IPC bridge", async () => {
    const goFile = path.join(tempDir, "types_test.go");
    fs.writeFileSync(
      goFile,
      `package types_test

type User struct {
    Name string
    Age  int
}

func ProcessAll(u User, items []int, lookup map[string]int, ptr *int) int {
    val := 0
    if ptr != nil {
        val = *ptr
    }
    sum := 0
    for _, item := range items {
        sum += item
    }
    return u.Age + sum + lookup["bonus"] + val
}
`
    );

    const env = makeTestEnv(goFile, "ProcessAll");
    const runner = new GoRunner(goFile, "ProcessAll", env);
    await runner.onRunStart();

    const user = { Name: "alice", Age: 30 };
    const items = [1, 2, 3];
    const lookup = { bonus: 7 };
    const ptr = 5;

    const res = await runner.run([user, items, lookup, ptr]);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      // 30 + (1+2+3) + 7 + 5 = 48
      expect(res.result.value).toBe(48);
    }

    // Test with nil pointer
    const resNilPtr = await runner.run([user, items, lookup, null]);
    expect(resNilPtr.result.tag).toBe("value");
    if (resNilPtr.result.tag === "value") {
      // 30 + 6 + 7 + 0 = 43
      expect(resNilPtr.result.value).toBe(43);
    }

    runner.killHost();
  });
});
