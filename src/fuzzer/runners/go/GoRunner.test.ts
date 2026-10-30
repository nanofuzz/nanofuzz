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

  it("catches UnsatisfiedAssumptionError and reports skip rather than error", async () => {
    const goFile = path.join(tempDir, "assume_test.go");
    fs.writeFileSync(
      goFile,
      `package assumetest

import (
    "fmt"
    "github.com/nanofuzz/runtime"
)

func CheckValid(mode int, expr string) string {
    if mode == 1 {
        runtime.Assume(len(expr) > 2, "Expression must be syntactically valid")
    } else if mode == 2 {
        if len(expr) <= 2 {
            panic(&runtime.UnsatisfiedAssumptionError{Message: "Expression must be syntactically valid"})
        }
    } else if mode == 3 {
        if len(expr) <= 2 {
            panic(fmt.Errorf("unsatisfied assumption: Expression must be syntactically valid"))
        }
    }
    return expr
}
`
    );

    const env = makeTestEnv(goFile, "CheckValid");
    const runner = new GoRunner(goFile, "CheckValid", env);
    await runner.onRunStart();

    // 1. runtime.Assume (struct value)
    const res1 = await runner.run([1, "Ub"]);
    expect(res1.result.tag).toBe("skip");
    if (res1.result.tag === "skip") {
      expect(res1.result.message).toContain(
        "Expression must be syntactically valid"
      );
    }

    // 2. Pointer *runtime.UnsatisfiedAssumptionError
    const res2 = await runner.run([2, "Ub"]);
    expect(res2.result.tag).toBe("skip");
    if (res2.result.tag === "skip") {
      expect(res2.result.message).toContain(
        "Expression must be syntactically valid"
      );
    }

    // 3. Formatted error with "unsatisfied assumption:"
    const res3 = await runner.run([3, "Ub"]);
    expect(res3.result.tag).toBe("skip");
    if (res3.result.tag === "skip") {
      expect(res3.result.message).toBe(
        "Expression must be syntactically valid"
      );
    }

    // 4. Valid input returns value
    const resOk = await runner.run([1, "1 + 2"]);
    expect(resOk.result.tag).toBe("value");
    if (resOk.result.tag === "value") {
      expect(resOk.result.value).toBe("1 + 2");
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

  it("executes functions taking a PRNG func with and without seed", async () => {
    const goPath = path.join(tempDir, "prng_test.go");
    fs.writeFileSync(
      goPath,
      `package main

func Sample(prng func() float64) float64 {
    return prng()
}
`
    );

    const env = makeTestEnv(goPath, "Sample");

    const runner = new GoRunner(goPath, "Sample", env);
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

    runner.killHost();
  });
});
