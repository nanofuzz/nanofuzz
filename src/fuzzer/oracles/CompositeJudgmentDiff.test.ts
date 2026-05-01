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
    const diff = new CompositeJudgmentDiff(examples, props).statsFor([
      validatorName,
    ]);
    expect(Object.keys(diff).length).toBe(5);
    expect(diff.falseFailures.length).toEqual(0);
    expect(diff.falsePasses.length).toEqual(0);
    expect(diff.trueFailures.length).toEqual(0);
    expect(diff.truePasses.length).toEqual(1);
    expect(diff.prospectiveFailures.length).toEqual(0);

    //const _summary = CompositeJudgmentDiff.summarize(diff);
    // more tests here!!!!!!!!!!
  });
});
