import { UserInputGenerator } from "./UserInputGenerator";
import { AbstractRunner, RunnerResult } from "../runners/AbstractRunner";
import * as ProgramFactory from "../analysis/ProgramFactory";

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
        result: {
          tag: "value",
          value: [42, "hello"],
          seq: 1,
        },
        env: {},
      };
    });

    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, 200, 100, mockRunner);

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
          result: {
            tag: "value",
            value: [99, "world"],
            seq: 1,
          },
          env: {},
        };
      }
      return {
        result: {
          tag: "value",
          value: undefined,
          seq: 2,
        },
        env: {},
      };
    });

    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, 200, 100, mockRunner);

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

  it("throws error if user generator throws an exception", async () => {
    const mockRunner = new MockRunner("testFnGenerator", async () => {
      return {
        result: {
          tag: "error",
          name: "TypeError",
          message: "something exploded in generator",
          stack: "TypeError: something exploded",
          seq: 1,
        },
        env: {},
      };
    });

    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, 200, 100, mockRunner);

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
  });

  it("throws error if user generator throws UnsatisfiedAssumption", async () => {
    const mockRunner = new MockRunner("testFnGenerator", async () => {
      return {
        result: {
          tag: "skip",
          message: "Cannot assume this",
          seq: 1,
        },
        env: {},
      };
    });

    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, 200, 100, mockRunner);

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
        result: {
          tag: "timeout",
          seq: 1,
        },
        env: {},
      };
    });

    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, 200, 100, mockRunner);

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

  it("throws error if user generator returns non-array and non-undefined value", async () => {
    const mockRunner = new MockRunner("testFnGenerator", async () => {
      return {
        result: {
          tag: "value",
          value: 12345, // invalid: should be [12345, ...]
          seq: 1,
        },
        env: {},
      };
    });

    const gen = new UserInputGenerator(fnDef, "seed123", mockRunner);
    gen.onRunStart(true, [], undefined, 200, 100, mockRunner);

    let caughtError: unknown;
    try {
      await gen.nextSoon();
    } catch (e: unknown) {
      caughtError = e;
    }

    expect(caughtError instanceof Error).toBeTrue();
    if (caughtError instanceof Error) {
      expect(caughtError.message).toContain(
        "must return an array/tuple of arguments"
      );
    }
  });
});
