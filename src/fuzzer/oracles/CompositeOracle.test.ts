import { CompositeOracle, Judgment } from "./CompositeOracle";

describe("fuzzer.oracles.CompositeOracle", () => {
  it("CompositeOracle.0", () => {
    const result = tester("unknown", "fail", "fail");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.1", () => {
    const result = tester("unknown", "pass", "fail");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.2", () => {
    const result = tester("unknown", "unknown", "unknown");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.3", () => {
    const result = tester("fail", "fail", "unknown");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.4", () => {
    const result = tester("pass", "fail", "fail");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.5", () => {
    const result = tester("unknown", "unknown", "pass");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.6", () => {
    const result = tester("fail", "pass", "fail");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.7", () => {
    const result = tester("fail", "fail", "pass");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.8", () => {
    const result = tester("fail", "pass", "pass");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.9", () => {
    const result = tester("unknown", "fail", "pass");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.10", () => {
    const result = tester("pass", "fail", "unknown");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.11", () => {
    const result = tester("fail", "unknown", "unknown");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.12", () => {
    const result = tester("pass", "pass", "fail");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.13", () => {
    const result = tester("pass", "fail", "pass");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.14", () => {
    const result = tester("fail", "fail", "fail");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.15", () => {
    const result = tester("pass", "pass", "pass");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.16", () => {
    const result = tester("pass", "unknown", "pass");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.17", () => {
    const result = tester("unknown", "unknown", "fail");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.18", () => {
    const result = tester("unknown", "pass", "unknown");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.19", () => {
    const result = tester("pass", "pass", "unknown");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.20", () => {
    const result = tester("fail", "unknown", "fail");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.21", () => {
    const result = tester("fail", "pass", "unknown");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.22", () => {
    const result = tester("fail", "unknown", "pass");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.23", () => {
    const result = tester("pass", "unknown", "fail");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.24", () => {
    const result = tester("unknown", "fail", "unknown");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.25", () => {
    const result = tester("unknown", "pass", "pass");
    expect(result.old === result.new).toBeTrue();
  }, 100);

  it("CompositeOracle.26", () => {
    const result = tester("pass", "unknown", "unknown");
    expect(result.old === result.new).toBeTrue();
  }, 100);
});

/**
 * Runs the three oracle judgments through both the old and new
 * composite oracles so their results may be compared.
 *
 * @param `implicit` judgment
 * @param `property` judgment
 * @param `human` judgment
 * @returns the old and new CompositeOracle Judgments
 */
export function tester(
  implicit: Judgment,
  property: Judgment,
  human: Judgment
): { old: Judgment; new: Judgment } {
  return {
    old: judgeOld(implicit, property, human),
    new: CompositeOracle.judge([[property, human], [implicit]]),
  };
}

/**
 * This is an older, particular implementation of the Composite Oracle
 * specific to NaNofuzz 0.3 included here for testing as an alternative
 * implementation with a known good result.
 *
 * @param `implicit` judgment
 * @param `property` judgment
 * @param `human` judgment
 * @returns composite judgment
 */
function judgeOld(
  implicit: Judgment,
  property: Judgment,
  human: Judgment
): Judgment {
  if (human === "pass") {
    if (property === "fail") {
      return "unknown";
    } else {
      return "pass";
    }
  } else if (human === "fail") {
    if (property === "pass") {
      return "unknown";
    } else {
      return "fail";
    }
  } else {
    if (property === "pass") {
      return "pass";
    } else if (property === "fail") {
      return "fail";
    } else {
      if (implicit === "unknown" || implicit === "pass") {
        return "pass";
      } else {
        return "fail";
      }
    }
  }
} // fn: judgeOld
