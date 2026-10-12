import { PropertyOracle } from "./PropertyOracle";
import { Judgment } from "./Types";
import { AbstractRunner, RunnerResult } from "../runners/AbstractRunner";

class MockPropRunner extends AbstractRunner {
  private readonly _runFn: () => Promise<RunnerResult>;

  public constructor(name: string, runFn: () => Promise<RunnerResult>) {
    super(name);
    this._runFn = runFn;
  }

  public override async run(): Promise<RunnerResult> {
    return this._runFn();
  }

  public override killHost(): void {
    // No-op for mock
  }
}

describe("fuzzer.oracles.PropertyOracle", () => {
  it("Property Oracle - summary - empty", () => {
    const judgments: Judgment[] = [];
    expect(PropertyOracle.summarize(judgments)).toBe("unknown");
    expect(PropertyOracle.summarize(judgments)).toEqual(
      summarizeOld(judgments)
    );
  });

  it("Property Oracle - summary - all unknown", () => {
    const judgments: Judgment[] = ["unknown", "unknown"];
    expect(PropertyOracle.summarize(judgments)).toBe("unknown");
    expect(PropertyOracle.summarize(judgments)).toEqual(
      summarizeOld(judgments)
    );
  });

  it("Property Oracle - summary - unknowns and fails - 1", () => {
    const judgments: Judgment[] = ["unknown", "fail", "unknown"];
    expect(PropertyOracle.summarize(judgments)).toBe("fail");
    expect(PropertyOracle.summarize(judgments)).toEqual(
      summarizeOld(judgments)
    );
  });

  it("Property Oracle - summary - unknowns and fails - 2", () => {
    const judgments: Judgment[] = ["fail", "unknown", "fail", "unknown"];
    expect(PropertyOracle.summarize(judgments)).toBe("fail");
    expect(PropertyOracle.summarize(judgments)).toEqual(
      summarizeOld(judgments)
    );
  });

  it("Property Oracle - summary - unknowns and passes - 1", () => {
    const judgments: Judgment[] = ["unknown", "pass", "unknown"];
    expect(PropertyOracle.summarize(judgments)).toBe("pass");
    expect(PropertyOracle.summarize(judgments)).toEqual(
      summarizeOld(judgments)
    );
  });

  it("Property Oracle - summary - unknowns and passes - 2", () => {
    const judgments: Judgment[] = ["pass", "unknown", "pass", "unknown"];
    expect(PropertyOracle.summarize(judgments)).toBe("pass");
    expect(PropertyOracle.summarize(judgments)).toEqual(
      summarizeOld(judgments)
    );
  });

  it("Property Oracle - summary - passes and fails - 1", () => {
    const judgments: Judgment[] = ["pass", "fail"];
    expect(PropertyOracle.summarize(judgments)).toBe("fail");
    expect(PropertyOracle.summarize(judgments)).toEqual(
      summarizeOld(judgments)
    );
  });

  it("Property Oracle - summary - passes and fails - 2", () => {
    const judgments: Judgment[] = ["pass", "pass", "fail"];
    expect(PropertyOracle.summarize(judgments)).toBe("fail");
    expect(PropertyOracle.summarize(judgments)).toEqual(
      summarizeOld(judgments)
    );
  });

  it("Property Oracle - summary - passes and fails - 3", () => {
    const judgments: Judgment[] = ["fail", "pass", "pass"];
    expect(PropertyOracle.summarize(judgments)).toBe("fail");
    expect(PropertyOracle.summarize(judgments)).toEqual(
      summarizeOld(judgments)
    );
  });

  it("Property Oracle - summary - passes, fails, and unknowns - 1", () => {
    const judgments: Judgment[] = ["unknown", "pass", "fail"];
    expect(PropertyOracle.summarize(judgments)).toBe("fail");
    expect(PropertyOracle.summarize(judgments)).toEqual(
      summarizeOld(judgments)
    );
  });

  it("Property Oracle - summary - passes, fails, and unknowns - 2", () => {
    const judgments: Judgment[] = ["pass", "unknown", "pass", "fail"];
    expect(PropertyOracle.summarize(judgments)).toBe("fail");
    expect(PropertyOracle.summarize(judgments)).toEqual(
      summarizeOld(judgments)
    );
  });

  it("Property Oracle - judge handles error, timeout, skip, and values", async () => {
    const mockRunnerPass = new MockPropRunner("passVal", async () => ({
      result: { tag: "value", value: "pass", seq: 0 },
      env: {},
    }));

    const mockRunnerFail = new MockPropRunner("failVal", async () => ({
      result: { tag: "value", value: "fail", seq: 0 },
      env: {},
    }));

    const mockRunnerTimeout = new MockPropRunner("timeoutVal", async () => ({
      result: { tag: "timeout", seq: 0 },
      env: {},
    }));

    const mockRunnerError = new MockPropRunner("errorVal", async () => ({
      result: {
        tag: "error",
        name: "CustomError",
        message: "crashed",
        stack: "Error: crashed",
        seq: 0,
      },
      env: {},
    }));

    const oracle = new PropertyOracle([
      mockRunnerPass,
      mockRunnerFail,
      mockRunnerTimeout,
      mockRunnerError,
    ]);

    const res = await oracle.judge(
      { in: [1], out: 1, exception: false, timeout: false },
      100
    );

    expect(res.length).toBe(4);
    expect(res[0]).toBe("pass");
    expect(res[1]).toBe("fail");

    const errTimeout = res[2];
    expect(errTimeout instanceof Error).toBeTrue();
    if (errTimeout instanceof Error) {
      expect(errTimeout.name).toBe("PropertyValidatorTimeout");
      expect(errTimeout.message).toContain(
        'property validator "timeoutVal" timed out'
      );
    }

    const errCustom = res[3];
    expect(errCustom instanceof Error).toBeTrue();
    if (errCustom instanceof Error) {
      expect(errCustom.name).toBe("CustomError");
      expect(errCustom.message).toBe("crashed");
    }
  });

  it("Property Oracle - mapJudgments maps value, timeout, skip, error, and return value issues", () => {
    const validators = [
      { name: "vPass", module: "mod", startOffset: 0, endOffset: 0 },
      { name: "vFail", module: "mod", startOffset: 0, endOffset: 0 },
      { name: "vBoolPass", module: "mod", startOffset: 0, endOffset: 0 },
      { name: "vBoolFail", module: "mod", startOffset: 0, endOffset: 0 },
      { name: "vTimeout", module: "mod", startOffset: 0, endOffset: 0 },
      { name: "vSkip", module: "mod", startOffset: 0, endOffset: 0 },
      { name: "vError", module: "mod", startOffset: 0, endOffset: 0 },
      { name: "vBadReturn", module: "mod", startOffset: 0, endOffset: 0 },
      { name: "vMissing", module: "mod", startOffset: 0, endOffset: 0 },
    ];

    const validatorResults = {
      vPass: { tag: "value" as const, value: "pass" },
      vFail: { tag: "value" as const, value: "fail" },
      vBoolPass: { tag: "value" as const, value: true },
      vBoolFail: { tag: "value" as const, value: false },
      vTimeout: { tag: "timeout" as const },
      vSkip: { tag: "skip" as const, message: "assumption failed" },
      vError: {
        tag: "error" as const,
        name: "ValidatorException",
        message: "something went wrong",
        stack: "Stack trace line",
      },
      vBadReturn: { tag: "value" as const, value: 12345 },
    };

    const { judgments, harnessErrors } = PropertyOracle.mapJudgments(
      validatorResults,
      validators,
      200
    );

    expect(judgments.length).toBe(9);
    expect(judgments[0]).toBe("pass");
    expect(judgments[1]).toBe("fail");
    expect(judgments[2]).toBe("pass");
    expect(judgments[3]).toBe("fail");
    expect(judgments[4]).toBe("unknown");
    expect(judgments[5]).toBe("unknown");
    expect(judgments[6]).toBe("unknown");
    expect(judgments[7]).toBe("unknown");
    expect(judgments[8]).toBe("unknown");

    expect(harnessErrors.length).toBe(4);
    expect(harnessErrors[0].kind).toBe("timeout");
    expect(harnessErrors[0].fnName).toBe("vTimeout");
    expect(harnessErrors[1].kind).toBe("exception");
    expect(harnessErrors[1].fnName).toBe("vSkip");
    expect(harnessErrors[2].kind).toBe("exception");
    expect(harnessErrors[2].fnName).toBe("vError");
    expect(harnessErrors[2].message).toBe("something went wrong");
    expect(harnessErrors[3].kind).toBe("exception");
    expect(harnessErrors[3].fnName).toBe("vBadReturn");
  });
});

/**
 * This is a prior and particular implementation of the summary
 * specific to NaNofuzz 0.3 included here for testing as an alternative
 * implementation with a known good result.
 *
 * @param `judgements` array of individual property-based judgments
 * @returns summarized judgment
 */
function summarizeOld(judgments: Judgment[]): Judgment {
  // Convert to v0.3-style judgments
  const oldJudgments: (boolean | undefined)[] = judgments.map((j) =>
    j === "unknown" ? undefined : j === "pass" ? true : false
  );
  let s: boolean | undefined = undefined;
  for (const i in oldJudgments) {
    const thisJudgment: boolean | undefined = oldJudgments[i];
    if (thisJudgment === true || thisJudgment === false) {
      s = s === undefined ? !!thisJudgment : s && !!thisJudgment;
    }
  }
  // Convert back to a v0.4-style judgment
  return s === true ? "pass" : s === false ? "fail" : "unknown";
} // fn: summarizeOld
