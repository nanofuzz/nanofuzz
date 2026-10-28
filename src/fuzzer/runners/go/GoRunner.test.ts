import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GoRunner } from "./GoRunner";
import { RunnerFactory } from "../RunnerFactory";
import * as Parser from "../../adapters/ParserAdapter";
import { FuzzEnv } from "../../Types";

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
    fs.writeFileSync(goFile, "package mathutil\nfunc Add(a, b int) int { return a + b }\n");
    const env = { options: {} } as unknown as FuzzEnv;
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

    const env = { options: {} } as unknown as FuzzEnv;
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

    const env = { options: {} } as unknown as FuzzEnv;
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
});
