import { PropertyOracle } from "./PropertyOracle";
import { Judgment, NamedJudgment } from "./Types";

describe("fuzzer.oracles.PropertyOracle", () => {
  it("Property Oracle - summary - empty", () => {
    const judgments: NamedJudgment[] = [];
    expect(PropertyOracle.summarize(judgments).judgment).toBe("unknown");
    expect(PropertyOracle.summarize(judgments).judgment).toEqual(
      summarizeOld(judgments.map((j) => j.judgment))
    );
  });

  it("Property Oracle - summary - all unknown", () => {
    const judgments: NamedJudgment[] = [makeUnknown(), makeUnknown()];
    expect(PropertyOracle.summarize(judgments).judgment).toBe("unknown");
    expect(PropertyOracle.summarize(judgments).judgment).toEqual(
      summarizeOld(judgments.map((j) => j.judgment))
    );
  });

  it("Property Oracle - summary - unknowns and fails - 1", () => {
    const judgments: NamedJudgment[] = [
      makeUnknown(),
      makeFail(),
      makeUnknown(),
    ];
    expect(PropertyOracle.summarize(judgments).judgment).toBe("fail");
    expect(PropertyOracle.summarize(judgments).judgment).toEqual(
      summarizeOld(judgments.map((j) => j.judgment))
    );
  });

  it("Property Oracle - summary - unknowns and fails - 2", () => {
    const judgments: NamedJudgment[] = [
      makeFail(),
      makeUnknown(),
      makeFail(),
      makeUnknown(),
    ];
    expect(PropertyOracle.summarize(judgments).judgment).toBe("fail");
    expect(PropertyOracle.summarize(judgments).judgment).toEqual(
      summarizeOld(judgments.map((j) => j.judgment))
    );
  });

  it("Property Oracle - summary - unknowns and passes - 1", () => {
    const judgments: NamedJudgment[] = [
      makeUnknown(),
      makePass(),
      makeUnknown(),
    ];
    expect(PropertyOracle.summarize(judgments).judgment).toBe("pass");
    expect(PropertyOracle.summarize(judgments).judgment).toEqual(
      summarizeOld(judgments.map((j) => j.judgment))
    );
  });

  it("Property Oracle - summary - unknowns and passes - 2", () => {
    const judgments: NamedJudgment[] = [
      makePass(),
      makeUnknown(),
      makePass(),
      makeUnknown(),
    ];
    expect(PropertyOracle.summarize(judgments).judgment).toBe("pass");
    expect(PropertyOracle.summarize(judgments).judgment).toEqual(
      summarizeOld(judgments.map((j) => j.judgment))
    );
  });

  it("Property Oracle - summary - passes and fails - 1", () => {
    const judgments: NamedJudgment[] = [makePass(), makeFail()];
    expect(PropertyOracle.summarize(judgments).judgment).toBe("fail");
    expect(PropertyOracle.summarize(judgments).judgment).toEqual(
      summarizeOld(judgments.map((j) => j.judgment))
    );
  });

  it("Property Oracle - summary - passes and fails - 2", () => {
    const judgments: NamedJudgment[] = [makePass(), makePass(), makeFail()];
    expect(PropertyOracle.summarize(judgments).judgment).toBe("fail");
    expect(PropertyOracle.summarize(judgments).judgment).toEqual(
      summarizeOld(judgments.map((j) => j.judgment))
    );
  });

  it("Property Oracle - summary - passes and fails - 3", () => {
    const judgments: NamedJudgment[] = [makeFail(), makePass(), makePass()];
    expect(PropertyOracle.summarize(judgments).judgment).toBe("fail");
    expect(PropertyOracle.summarize(judgments).judgment).toEqual(
      summarizeOld(judgments.map((j) => j.judgment))
    );
  });

  it("Property Oracle - summary - passes, fails, and unknowns - 1", () => {
    const judgments: NamedJudgment[] = [makeUnknown(), makePass(), makeFail()];
    expect(PropertyOracle.summarize(judgments).judgment).toBe("fail");
    expect(PropertyOracle.summarize(judgments).judgment).toEqual(
      summarizeOld(judgments.map((j) => j.judgment))
    );
  });

  it("Property Oracle - summary - passes, fails, and unknowns - 2", () => {
    const judgments: NamedJudgment[] = [
      makePass(),
      makeUnknown(),
      makePass(),
      makeFail(),
    ];
    expect(PropertyOracle.summarize(judgments).judgment).toBe("fail");
    expect(PropertyOracle.summarize(judgments).judgment).toEqual(
      summarizeOld(judgments.map((j) => j.judgment))
    );
  });
});

const make: (j: Judgment) => NamedJudgment = (j) => ({
  name: j,
  judgment: j,
  trace: [],
  deciders: [],
});
const makeUnknown: () => NamedJudgment = () => make("unknown");
const makePass: () => NamedJudgment = () => make("pass");
const makeFail: () => NamedJudgment = () => make("fail");

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
