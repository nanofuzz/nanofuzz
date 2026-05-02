import JSON5 from "json5";
import * as zod from "zod";
import { LlmAdapter } from "../fuzzer/adapters/LlmAdapter";
import { FunctionDef, FuzzTestResults } from "../fuzzer/Fuzzer";
import {
  CompositeJudgmentDiff,
  JudgedExample,
} from "../fuzzer/oracles/CompositeJudgmentDiff";
import { RunnerFactory } from "../fuzzer/runners/RunnerFactory";
import path from "node:path";
import { CompositeOracle } from "../fuzzer/oracles/CompositeOracle";

let _isBusy: boolean = false;
const model = new LlmAdapter();
const schema = zod
  .array(
    zod.strictObject({
      functionSourceCode: zod
        .string()
        .describe(
          `Property assertion function source code, including the function signature, that returns \`"pass" | "fail" | "unknown"\``
        ),
      functionName: zod.string().describe(`Callable name of the function`),
    })
  )
  .toJSONSchema();

// !!!!!!
export function proposeProperties(fn: FunctionDef, r: FuzzTestResults) {
  if (_isBusy || !LlmAdapter.isConfigured() || !r.env.options.useProperty) {
    return;
  } else {
    _isBusy = true;
  }

  const examples: JudgedExample[] = r.results.map((r) => {
    return {
      example: {
        exception: r.exception,
        timeout: r.timeout,
        out: r.output[0].value,
        in: r.input.map((i) => i.value),
      },
      judgments: {
        implicit: r.passedImplicit,
        example: r.passedHuman,
        composite: CompositeOracle.judge([
          [r.passedHuman, r.passedValidator],
          [r.passedImplicit],
        ]),
        property: r.passedValidator,
        propertyDetail: r.passedValidators,
      },
      addlJudgments: {},
    };
  });

  model.genProps(fn, schema).then((props) => {
    console.debug(
      `In the post-llm handler with: ${JSON5.stringify(props, null, 2)}`
    ); // !!!!!!!!!!
    const differ = new CompositeJudgmentDiff(
      examples,
      props.map((p) => {
        console.debug(`creating jsrunner for ${p.functionName}`); // !!!!!!!!!!!
        return {
          name: p.functionName,
          runner: RunnerFactory({
            type: "typescript.src",
            src: p.functionSourceCode,
            fnName: p.functionName,
            fileName: path.resolve(
              `${fn.getModule()}.prospective.${p.functionName}.ts`
            ),
          }),
        };
      })
    );
    for (const p of props) {
      console.debug(`---------------------`); // !!!!!!!!!!
      const diff = differ.diffFor([p.functionName]);
      console.debug(
        `diff for "${p.functionName}": ${JSON5.stringify(
          {
            exceptions: diff.exceptions.length,
            falseFailures: diff.falseFailures.length,
            falsePasses: diff.falsePasses.length,
            trueFailures: diff.trueFailures.length,
            truePasses: diff.truePasses.length,
            prospectiveFailures: diff.prospectiveFailures.length,
          },
          null,
          2
        )}`
      ); // !!!!!!!!!!
      const summary = CompositeJudgmentDiff.summarize(diff);
      console.debug(`summary: ${JSON5.stringify(summary, null, 2)}`); // !!!!!!!!!!
      const priority = CompositeJudgmentDiff.prioritize(diff);
      console.debug(`priority: ${priority}`); // !!!!!!!!!!
    }
    _isBusy = false;
  });
} // !!!!!!

// !!!!!!
export function isBusy(): boolean {
  return _isBusy;
} // !!!!!!
