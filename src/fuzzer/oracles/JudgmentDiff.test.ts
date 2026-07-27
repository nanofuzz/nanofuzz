import { RunnerFactory } from "../runners/RunnerFactory";
import { JudgmentDiffer, JudgedExample } from "./JudgmentDiff";

describe("fuzzer.oracles.CompositeJudgmentDiff", () => {
  it("CompositeJudgmentDiff - base", () => {
    const j = {
      name: "dummy",
      trace: [],
      deciders: [],
    };
    const examples: JudgedExample[] = [
      {
        example: {
          inWrapped: [{ tag: "ArgValueTypeWrapped", value: true }],
          outWrapped: { tag: "ArgValueTypeWrapped", value: true },
          exception: false,
          timeout: false,
        },
        source: {
          type: "test",
          runId: "dummy-uuid",
          testId: 0,
        },
        judgments: {
          composite: { ...j, judgment: "pass" },
          example: { ...j, judgment: "pass" },
          implicit: { ...j, judgment: "fail" },
          property: { ...j, judgment: "unknown" },
          propertyDetail: [{ ...j, judgment: "pass" }],
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
    const diff = new JudgmentDiffer("dummy-uuid", examples, props).diffFor([
      validatorName,
    ]);
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
