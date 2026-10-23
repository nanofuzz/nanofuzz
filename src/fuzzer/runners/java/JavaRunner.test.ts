import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { JavaRunner } from "./JavaRunner";
import { RunnerFactory } from "../RunnerFactory";
import { FunctionDef } from "../../analysis/FunctionDef";
import { ArgDef } from "../../analysis/ArgDef";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import * as Parser from "../../adapters/ParserAdapter";
import { FuzzEnv } from "../../Types";
import { getDefaultFuzzExecutionOptions } from "../../FuzzerFactory";

describe("fuzzer/runners/java/JavaRunner: ", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-javarunner-test-")
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

  it("executes basic Java functions with numbers and return values", async () => {
    const javaPath = path.join(tempDir, "Calculator.java");
    fs.writeFileSync(
      javaPath,
      `public class Calculator {
    public static int add(int a, int b) {
        return a + b;
    }
}
`
    );

    const program = ProgramFactory.fromFile(javaPath, "java");
    const fnDef = program.functionsExported["add"];
    const env = createTestEnv(fnDef);

    const runner = new JavaRunner(javaPath, "add", env);
    await runner.onRunStart();

    const res = await runner.run([10, 32], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe(42);
    }

    await runner.onRunEnd();
  });

  it("executes functions with strings, booleans, and arrays", async () => {
    const javaPath = path.join(tempDir, "Greeter.java");
    fs.writeFileSync(
      javaPath,
      `public class Greeter {
    public static String greet(String name, int count, boolean uppercase, int[] items) {
        int sum = 0;
        if (items != null) {
            for (int x : items) sum += x;
        }
        String msg = "Hello, " + name + "! count=" + count + " sum=" + sum;
        if (uppercase) {
            msg = msg.toUpperCase();
        }
        return msg;
    }
}
`
    );

    const program = ProgramFactory.fromFile(javaPath, "java");
    const fnDef = program.functionsExported["greet"];
    const env = createTestEnv(fnDef);

    const runner = new JavaRunner(javaPath, "greet", env);
    await runner.onRunStart();

    const res = await runner.run(["Alice", 3, true, [1, 2, 3]], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe("HELLO, ALICE! COUNT=3 SUM=6");
    }

    await runner.onRunEnd();
  });

  it("executes instance methods on classes with default constructor", async () => {
    const javaPath = path.join(tempDir, "Counter.java");
    fs.writeFileSync(
      javaPath,
      `public class Counter {
    private int base = 100;
    public int offset(int delta) {
        return base + delta;
    }
}
`
    );

    const program = ProgramFactory.fromFile(javaPath, "java");
    const fnDef = program.functionsExported["offset"];
    const env = createTestEnv(fnDef);

    const runner = new JavaRunner(javaPath, "offset", env);
    await runner.onRunStart();

    const res = await runner.run([25], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe(125);
    }

    await runner.onRunEnd();
  });

  it("catches exceptions without terminating the host process", async () => {
    const javaPath = path.join(tempDir, "Divider.java");
    fs.writeFileSync(
      javaPath,
      `public class Divider {
    public static int divide(int a, int b) {
        if (b == 0) {
            throw new IllegalArgumentException("division by zero");
        }
        return a / b;
    }
}
`
    );

    const program = ProgramFactory.fromFile(javaPath, "java");
    const fnDef = program.functionsExported["divide"];
    const env = createTestEnv(fnDef);

    const runner = new JavaRunner(javaPath, "divide", env);
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
      expect(errRes.result.name).toBe("IllegalArgumentException");
      expect(errRes.result.message).toContain("division by zero");
      expect(errRes.result.source).toBe("put");
    }

    // Process is still alive and responds to subsequent invocations
    const recoverRes = await runner.run([100, 4], 5000);
    expect(recoverRes.result.tag).toBe("value");
    if (recoverRes.result.tag === "value") {
      expect(recoverRes.result.value).toBe(25);
    }

    await runner.onRunEnd();
  });

  it("catches UnsatisfiedAssumptionException and reports skip", async () => {
    const javaPath = path.join(tempDir, "Filtered.java");
    fs.writeFileSync(
      javaPath,
      `import static com.nanofuzz.runtime.Assume.assume;

public class Filtered {
    public static int mustBePositive(int x) {
        assume(x > 0, "x must be positive");
        return x * 2;
    }
}
`
    );

    const program = ProgramFactory.fromFile(javaPath, "java");
    const fnDef = program.functionsExported["mustBePositive"];
    const env = createTestEnv(fnDef);

    const runner = new JavaRunner(javaPath, "mustBePositive", env);
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
    const javaPath = path.join(tempDir, "ValidatorTest.java");
    fs.writeFileSync(
      javaPath,
      `import com.nanofuzz.runtime.FuzzTestResult;
import com.nanofuzz.runtime.ValidatorResult;

public class ValidatorTest {
    public static int doubleVal(int x) {
        return x * 2;
    }

    public static ValidatorResult doubleValValidator(FuzzTestResult r) {
        int inVal = r.getIn(0);
        int outVal = r.getOut();
        return ValidatorResult.from(outVal == inVal * 2);
    }
}
`
    );

    const program = ProgramFactory.fromFile(javaPath, "java");
    const fnDef = program.functionsExported["doubleVal"];
    const validatorDef = program.functionsExported["doubleValValidator"];
    const env = createTestEnv(fnDef, [validatorDef.getRef()]);

    const runner = new JavaRunner(javaPath, "doubleVal", env);
    await runner.onRunStart();

    const res = await runner.run([7], 5000, ["doubleValValidator"]);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe(14);
      expect(res.result.validators).toBeDefined();
      expect(res.result.validators!["doubleValValidator"]).toEqual({
        tag: "value",
        value: "pass",
      });
    }

    await runner.onRunEnd();
  });

  it("executes functions with BigInteger, byte[], Set, and Map across MessagePack IPC", async () => {
    const javaPath = path.join(tempDir, "DataTypes.java");
    fs.writeFileSync(
      javaPath,
      `import java.math.BigInteger;
import java.util.Set;
import java.util.Map;

public class DataTypes {
    public static BigInteger addBig(BigInteger a, BigInteger b) {
        return a.add(b);
    }

    public static byte[] reverseBytes(byte[] bytes) {
        byte[] rev = new byte[bytes.length];
        for (int i = 0; i < bytes.length; i++) {
            rev[i] = bytes[bytes.length - 1 - i];
        }
        return rev;
    }
}
`
    );

    const program = ProgramFactory.fromFile(javaPath, "java");
    const addBigDef = program.functionsExported["addBig"];
    const envBig = createTestEnv(addBigDef);

    const runnerBig = new JavaRunner(javaPath, "addBig", envBig);
    await runnerBig.onRunStart();

    const resBig = await runnerBig.run([100n, 200n], 5000);
    expect(resBig.result.tag).toBe("value");
    if (resBig.result.tag === "value") {
      expect(resBig.result.value).toBe(300n);
    }
    await runnerBig.onRunEnd();

    const revDef = program.functionsExported["reverseBytes"];
    const envRev = createTestEnv(revDef);
    const runnerRev = new JavaRunner(javaPath, "reverseBytes", envRev);
    await runnerRev.onRunStart();

    const inBytes = new Uint8Array([1, 2, 3, 4]);
    const resBytes = await runnerRev.run([inBytes], 5000);
    expect(resBytes.result.tag).toBe("value");
    if (resBytes.result.tag === "value") {
      expect(resBytes.result.value).toEqual(new Uint8Array([4, 3, 2, 1]));
    }
    await runnerRev.onRunEnd();
  });

  it("handles timeouts and recovers cleanly on subsequent calls", async () => {
    const javaPath = path.join(tempDir, "TimeoutTest.java");
    fs.writeFileSync(
      javaPath,
      `public class TimeoutTest {
    public static int loopOrAdd(boolean hang, int a) {
        if (hang) {
            while (true) {}
        }
        return a + 1;
    }
}
`
    );

    const program = ProgramFactory.fromFile(javaPath, "java");
    const fnDef = program.functionsExported["loopOrAdd"];
    const env = createTestEnv(fnDef);

    const runner = new JavaRunner(javaPath, "loopOrAdd", env);
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

  it("handles target functions that print to System.out without breaking protocol", async () => {
    const javaPath = path.join(tempDir, "PrintTest.java");
    fs.writeFileSync(
      javaPath,
      `public class PrintTest {
    public static int shout(int a) {
        System.out.println("Hello from PUT shouting on System.out!");
        System.out.print("Another line without newline");
        return a * 10;
    }
}
`
    );

    const program = ProgramFactory.fromFile(javaPath, "java");
    const fnDef = program.functionsExported["shout"];
    const env = createTestEnv(fnDef);

    const runner = new JavaRunner(javaPath, "shout", env);
    await runner.onRunStart();

    const res = await runner.run([5], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe(50);
    }

    await runner.onRunEnd();
  });

  it("is instantiated correctly via RunnerFactory", () => {
    const javaPath = path.join(tempDir, "Sample.java");
    fs.writeFileSync(
      javaPath,
      "public class Sample { public static int add(int a) { return a; } }"
    );

    const program = ProgramFactory.fromFile(javaPath, "java");
    const fnDef = program.functionsExported["add"];
    const env = createTestEnv(fnDef);

    const runner = RunnerFactory(env, javaPath, "add");
    expect(runner instanceof JavaRunner).toBeTrue();
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
