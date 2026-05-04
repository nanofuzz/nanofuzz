import { RunnerFactory } from "../runners/RunnerFactory";
import { CompositeJudgmentDiff, JudgedExample } from "./CompositeJudgmentDiff";

describe("fuzzer.oracles.CompositeJudgmentDiff", () => {
  it("CompositeJudgmentDiff - base", () => {
    const examples: JudgedExample[] = [
      {
        example: {
          in: [true],
          out: true,
          exception: false,
          timeout: false,
        },
        source: {
          runId: "dummy-uuid",
          testId: 0,
        },
        judgments: {
          composite: "pass",
          example: "pass",
          implicit: "fail",
          property: "unknown",
          propertyDetail: ["pass"],
        },
        addlJudgments: {},
      },
    ];
    const validatorName = "exampleValidator";
    const props = [
      {
        name: validatorName,
        runner: RunnerFactory({
          type: "typescript.src",
          fnName: validatorName,
          src: `import { FuzzTestResult } from "@nanofuzz/runtime";
export function ${validatorName}(r: FuzzTestResult): "pass" | "fail" | "unknown" {
  const input: boolean = r.in[0];
  const output: boolean = r.out;
  return input===output ? "pass" : "fail";
}`,
        }),
      },
    ];
    const diff = new CompositeJudgmentDiff(
      "dummy-uuid",
      examples,
      props
    ).diffFor([validatorName]);
    expect(Object.keys(diff).length).toEqual(4); // !!!!!!!!!! more detail here
    expect(diff.summary).toEqual({
      greens: 0,
      reds: 0,
      squares: ["gray", "gray", "gray", "gray", "gray"],
    });
    expect(Object.keys(diff.detail).length).toEqual(6);
    expect(diff.detail.exceptions.length).toEqual(0);
    expect(diff.detail.falseFailures.length).toEqual(0);
    expect(diff.detail.falsePasses.length).toEqual(0);
    expect(diff.detail.trueFailures.length).toEqual(0);
    expect(diff.detail.truePasses.length).toEqual(1);
    expect(diff.detail.prospectiveFailures.length).toEqual(0);

    //const _summary = CompositeJudgmentDiff.summarize(diff);
    // more tests here!!!!!!!!!!
  });
});
