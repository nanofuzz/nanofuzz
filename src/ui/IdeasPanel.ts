import JSON5 from "json5";
import * as vscode from "vscode";
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
import { FuzzPanelMessageToWebView } from "./FuzzPanel";

let _isBusy: boolean = false;
const model = new LlmAdapter();
const schema = zod
  .array(
    zod.strictObject({
      functionSourceCode: zod
        .array(
          zod
            .string()
            .describe(
              `One line of source code. Preserve whitespace and comments.`
            )
        )
        .describe(
          `Property assertion function source code organized as an array of source code lines that include the function signature and the docstring comment. The function must return \`"pass" | "fail" | "unknown"\``
        ),
      functionName: zod.string().describe(`Callable name of the function`),
    })
  )
  .toJSONSchema();

// !!!!!!
export function proposeProperties(
  webview: vscode.Webview,
  fn: FunctionDef,
  results: FuzzTestResults
) {
  if (
    _isBusy ||
    !LlmAdapter.isConfigured() ||
    !vscode.workspace
      .getConfiguration("nanofuzz.ai.properties")
      .get<boolean>("generate", false) ||
    !results.env.options.useProperty
  ) {
    return;
  } else {
    _isBusy = true;
  }

  const examples: JudgedExample[] = results.results.map((r) => {
    return {
      example: {
        exception: r.exception,
        timeout: r.timeout,
        out: r.output[0]?.value,
        in: r.input.map((i) => i.value),
      },
      source: {
        runId: results.runId,
        testId: r.testId,
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

  // Generate & diff the candidate property judgments
  model.genProps(fn, schema).then((props) => {
    console.debug(
      `In the post-llm handler with: ${JSON5.stringify(props, null, 2)}`
    ); // !!!!!!!!!!
    const differ = new CompositeJudgmentDiff(
      results.runId,
      examples,
      props.map((p) => {
        console.debug(`creating jsrunner for ${p.functionName}`); // !!!!!!!!!!!
        return {
          name: p.functionName,
          runner: RunnerFactory({
            type: "typescript.src",
            src: p.functionSourceCode.join("\n"),
            fnName: p.functionName,
            fileName: path.resolve(
              `${fn.getModule()}.prospective.${p.functionName}.ts`
            ),
          }),
        };
      })
    );
    const message: FuzzPanelMessageToWebView = {
      command: "props.proposed",
      props: {},
    };
    props.forEach((p) => {
      console.debug(`---------------------`); // !!!!!!!!!!
      const diff = differ.diffFor([p.functionName]);
      message.props[p.functionName] = {
        src: p.functionSourceCode.join("\n"),
        diff,
      };
      console.debug(
        `diff for "${p.functionName}": ${JSON5.stringify(
          {
            ...diff,
            detail: {
              exceptions: diff.detail.exceptions.length,
              falseFailures: diff.detail.falseFailures.length,
              falsePasses: diff.detail.falsePasses.length,
              trueFailures: diff.detail.trueFailures.length,
              truePasses: diff.detail.truePasses.length,
              prospectiveFailures: diff.detail.prospectiveFailures.length,
            },
          },
          null,
          2
        )}`
      ); // !!!!!!!!!!
    });
    webview.postMessage(message);
    _isBusy = false;
  });
} // !!!!!!

// !!!!!!
export function isBusy(): boolean {
  return _isBusy;
} // !!!!!!
