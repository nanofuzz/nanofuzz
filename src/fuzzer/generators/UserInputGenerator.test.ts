import { UserInputGenerator } from "./UserInputGenerator";
import { AbstractRunner } from "../runners/AbstractRunner";
import { RunnerResult } from "../runners/Types";
import * as ProgramFactory from "../analysis/ProgramFactory";
import { FuzzConfigStore } from "../FuzzConfigStore";
import { isRecord } from "../../Util";

class MockRunner extends AbstractRunner {
  private _runFn: (inputs: unknown[]) => Promise<RunnerResult>;

  public constructor(
    name: string,
    runFn: (inputs: unknown[]) => Promise<RunnerResult>
  ) {
    super(name);
    this._runFn = runFn;
  } // fn: constructor

  public override killHost(): void {
    // No-op
  }

  public override async run(
    inputs: unknown[],
    _timeout?: number
  ): Promise<RunnerResult> {
    return this._runFn(inputs);
  } // fn: run
}

describe("fuzzer/generators/UserInputGenerator:", () => {
  const tsCode = `export function testFn(n: number, s: string): string { return s + n; }`;
  const program = ProgramFactory.fromSource(() => tsCode, "typescript");
  const fnDef = program.functionsExported["testFn"];

  it("metadata and initial state", () => {
    const gen = new UserInputGenerator(fnDef, "seed123");
    expect(gen.name).toBe("UserInputGenerator");
    expect(gen.humanName).toBe("User");
    expect(gen.isTransformable).toBe(false);
    expect(gen.nextable()).toBe(false);
    expect(() => gen.next()).toThrow();
  });

  it("produces inputs from runner and tags origin correctly", async () => {
    let passedInputs: unknown[] = [];
    const mockRunner = new MockRunner("testFnGenerator", async (inputs) => {
      passedInputs = inputs;
      return {
        results: [
          {
            tag: "value",
            value: [42, "hello"],
          },
        ],
        seq: 1,
        env: {},
      };
    });

    const dftOptions = FuzzConfigStore.getDefaultFuzzOptions();
    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, dftOptions, mockRunner);

    expect(gen.nextable()).toBe("soon");
    const input = await gen.nextSoon();

    expect(passedInputs.length).toBe(1);
    const firstArg = passedInputs[0];
    expect(
      firstArg !== null &&
        typeof firstArg === "object" &&
        "__nanofuzz_type" in firstArg &&
        Reflect.get(firstArg, "__nanofuzz_type") === "prng"
    ).toBeTrue();

    expect(input.value.length).toBe(2);
    expect<unknown>(input.value[0]).toEqual({
      tag: "ArgValueTypeWrapped",
      value: 42,
    });
    expect<unknown>(input.value[1]).toEqual({
      tag: "ArgValueTypeWrapped",
      value: "hello",
    });

    expect(input.source).toEqual({
      type: "generator",
      generator: "UserInputGenerator",
      fnName: "testFnGenerator",
    });
  });

  it("exhausts when runner returns undefined or null", async () => {
    let callCount = 0;
    const mockRunner = new MockRunner("testFnGenerator", async () => {
      callCount++;
      if (callCount === 1) {
        return {
          results: [
            {
              tag: "value",
              value: [99, "world"],
            },
          ],
          seq: 1,
          env: {},
        };
      }
      return {
        results: [],
        seq: 2,
        env: {},
      };
    });

    const dftOptions = FuzzConfigStore.getDefaultFuzzOptions();
    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, dftOptions, mockRunner);

    expect(gen.nextable()).toBe("soon");
    const first = await gen.nextSoon();
    expect<unknown>(first.value[0].value).toBe(99);

    // The second call is in-flight prefetching; once awaited, the generator exhausts
    while (gen.nextable() === "soon") {
      try {
        await gen.nextSoon();
      } catch {
        break;
      }
    }
    expect(gen.nextable()).toBe(false);
  });

  it("voluntarily exhausts when user generator returns undefined without recording failure ticks", async () => {
    let callCount = 0;
    const mockRunner = new MockRunner("testFnGenerator", async () => {
      callCount++;
      if (callCount === 1) {
        return {
          results: [
            {
              tag: "value",
              value: [100, "item1"],
            },
          ],
          seq: 1,
          env: {},
        };
      }
      // Generator voluntarily exhausts by returning undefined (or null)
      return {
        results: [
          {
            tag: "value",
            value: undefined,
          },
        ],
        seq: 2,
        env: {},
      };
    });

    const dftOptions = FuzzConfigStore.getDefaultFuzzOptions();
    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, dftOptions, mockRunner);

    // Initial item is retrieved
    const first = await gen.nextSoon();
    expect<unknown>(first.value[0].value).toBe(100);

    // Drain/wait for second call which returns [undefined]
    while (gen.nextable() === "soon") {
      try {
        await gen.nextSoon();
      } catch {
        break;
      }
    }

    // Must be cleanly exhausted, NOT failed
    expect(gen.nextable()).toBe(false);
    expect(gen.failureCount).toBe(0);
    expect(gen.consecutiveFailures).toBe(0);
  });

  it("throws error if user generator throws an exception", async () => {
    const mockRunner = new MockRunner("testFnGenerator", async () => {
      return {
        results: [
          {
            tag: "error",
            name: "TypeError",
            message: "something exploded in generator",
            stack: "TypeError: something exploded",
          },
        ],
        seq: 1,
        env: {},
      };
    });

    const dftOptions = FuzzConfigStore.getDefaultFuzzOptions();
    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, dftOptions, mockRunner);

    let caughtError: unknown;
    try {
      await gen.nextSoon();
    } catch (e: unknown) {
      caughtError = e;
    }

    expect(caughtError instanceof Error).toBeTrue();
    if (caughtError instanceof Error) {
      expect(caughtError.message).toContain("something exploded in generator");
    }
    const cf5: number = gen.consecutiveFailures;
    expect(cf5).toBe(5);
    const fc5: number = gen.failureCount;
    expect(fc5).toBe(5);
    const ticks = Array.from(gen.failureTicks);
    expect(ticks.length).toBe(5);
    expect(ticks[0]).toBe(1);
    expect(ticks[4]).toBe(5);
  });

  it("resets consecutive failure counter when a valid input is produced after an error", async () => {
    let callCount = 0;
    const mockRunner = new MockRunner("testFnGenerator", async () => {
      callCount++;
      if (callCount === 1) {
        return {
          results: [
            {
              tag: "error",
              name: "TemporaryError",
              message: "transient network/timeout failure",
            },
          ],
          seq: 1,
          env: {},
        };
      }
      return {
        results: [
          {
            tag: "value",
            value: [42, "recovered"],
          },
        ],
        seq: 2,
        env: {},
      };
    });

    const dftOptions = FuzzConfigStore.getDefaultFuzzOptions();
    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, dftOptions, mockRunner);

    const input = await gen.nextSoon();
    expect<unknown>(input.value[0].value).toBe(42);
    expect<unknown>(input.value[1].value).toBe("recovered");

    const failCount: number = gen.failureCount;
    expect(failCount).toBe(1);
    const recoveredTicks: number[] = Array.from(gen.failureTicks);
    expect(recoveredTicks.length).toBe(1);
    expect(recoveredTicks[0]).toBe(1);
    const cf: number = gen.consecutiveFailures;
    expect(cf).toBe(0);
  });

  it("throws error if user generator throws UnsatisfiedAssumption", async () => {
    const mockRunner = new MockRunner("testFnGenerator", async () => {
      return {
        results: [
          {
            tag: "skip",
            message: "Cannot assume this",
          },
        ],
        seq: 1,
        env: {},
      };
    });

    const dftOptions = FuzzConfigStore.getDefaultFuzzOptions();
    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, dftOptions, mockRunner);

    let caughtError: unknown;
    try {
      await gen.nextSoon();
    } catch (e: unknown) {
      caughtError = e;
    }

    expect(caughtError instanceof Error).toBeTrue();
    if (caughtError instanceof Error) {
      expect(caughtError.message).toContain(
        "UnsatisfiedAssumption which is not allowed in input generators"
      );
    }
  });

  it("throws error if user generator times out", async () => {
    const mockRunner = new MockRunner("testFnGenerator", async () => {
      return {
        results: [
          {
            tag: "timeout",
          },
        ],
        seq: 1,
        env: {},
      };
    });

    const dftOptions = FuzzConfigStore.getDefaultFuzzOptions();
    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, dftOptions, mockRunner);

    let caughtError: unknown;
    try {
      await gen.nextSoon();
    } catch (e: unknown) {
      caughtError = e;
    }

    expect(caughtError instanceof Error).toBeTrue();
    if (caughtError instanceof Error) {
      expect(caughtError.message).toContain("timed out exceeding");
    }
  });

  it("records failure ticks if user generator returns non-array inputs", async () => {
    const mockRunner = new MockRunner("testFnGenerator", async () => {
      return {
        results: [
          {
            tag: "value",
            value: 12345, // invalid: should be [12345, ...]
          },
        ],
        seq: 1,
        env: {},
      };
    });

    const dftOptions = FuzzConfigStore.getDefaultFuzzOptions();
    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, dftOptions, mockRunner);

    let caughtError: unknown;
    try {
      await gen.nextSoon();
    } catch (e: unknown) {
      caughtError = e;
    }

    expect(caughtError instanceof Error).toBeTrue();
    if (caughtError instanceof Error) {
      expect(caughtError.message).toContain(
        "failed to produce valid inputs"
      );
    }
  });

  it("handles multiplexed batch of inputs returned in a single runner response", async () => {
    const allCapturedCalls: unknown[][] = [];
    const mockRunner = new MockRunner("testFnGenerator", async (inputs) => {
      allCapturedCalls.push(inputs);
      return {
        results: [
          { tag: "value", value: [1, "alpha"] },
          { tag: "value", value: [2, "beta"] },
          { tag: "value", value: [3, "gamma"] },
        ],
        seq: 1,
        env: {},
      };
    });

    const dftOptions = FuzzConfigStore.getDefaultFuzzOptions();
    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.workerCount = 2; // targetQueueSize = 2 * 3 = 6
    gen.onRunStart(true, [], undefined, dftOptions, mockRunner);

    const first = await gen.nextSoon();
    expect<unknown>(first.value[0].value).toBe(1);
    expect<unknown>(first.value[1].value).toBe("alpha");

    // First call during onRunStart must have requested full targetQueueSize (6)
    const firstCallArgs = allCapturedCalls[0];
    const firstArg = firstCallArgs ? firstCallArgs[0] : undefined;
    expect(isRecord(firstArg)).toBeTrue();
    const prngPayload = isRecord(firstArg) ? firstArg : {};
    expect(prngPayload["__nanofuzz_type"]).toBe("prng");
    expect(prngPayload["batch_size"]).toBe(6);

    // Remaining items from the batch should be immediately available in queue
    expect(gen.nextable()).toBe("now");
    const second = gen.next();
    expect<unknown>(second.value[0].value).toBe(2);
    expect<unknown>(second.value[1].value).toBe("beta");

    expect(gen.nextable()).toBe("now");
    const third = gen.next();
    expect<unknown>(third.value[0].value).toBe(3);
    expect<unknown>(third.value[1].value).toBe("gamma");
  });

  it("retains valid inputs from a noisy batch and resets consecutive failures counter", async () => {
    const mockRunner = new MockRunner("noisyGenerator", async () => {
      return {
        results: [
          { tag: "value", value: [10, "good1"] },
          { tag: "value", value: "not-an-array" },
          { tag: "value", value: [20, "good2"] },
          { tag: "value", value: "also-not-an-array" },
          { tag: "value", value: [30, "good3"] },
        ],
        seq: 1,
        env: {},
      };
    });

    const dftOptions = FuzzConfigStore.getDefaultFuzzOptions();
    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, dftOptions, mockRunner);

    // Initial fetch from onRunStart arrives via nextSoon
    const item1 = await gen.nextSoon();
    expect<unknown>(item1.value[0].value).toBe(10);

    // Remaining valid inputs from the batch are now available in queue
    expect(gen.nextable()).toBe("now");
    const item2 = gen.next();
    expect<unknown>(item2.value[0].value).toBe(20);

    expect(gen.nextable()).toBe("now");
    const item3 = gen.next();
    expect<unknown>(item3.value[0].value).toBe(30);

    // Consecutive failures must be 0 because the batch made progress
    expect(gen.consecutiveFailures).toBe(0);
    // Failure count reflects the 2 bad items dropped from the batch
    expect(gen.failureCount).toBe(2);
  });
});
