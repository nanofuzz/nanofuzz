import { AbstractProgramModel } from "./AbstractProgramModel";
import * as JSON5 from "json5";
import { ModelArgOverrides } from "./Types";
import { FuzzIoElement } from "fuzzer/Types";
import { FunctionDef } from "fuzzer/Fuzzer";
import * as vscode from "vscode";

export class CopilotProgramModel extends AbstractProgramModel {
  private _promptCache: Record<string, string> = {};
  private _model?: vscode.LanguageModelChat;

  /** !!!!!! */
  constructor(fn: FunctionDef) {
    super(fn, "copilot");
    process.nextTick(() => {
      this._initModel();
    });
  } // !!!!!!

  // !!!!!!
  public isAvailable(): boolean {
    return !!this._model;
  } // !!!!!!

  // !!!!!!
  public async _initModel(): Promise<void> {
    if (this._model) return;

    /*
    const allModels = await vscode.lm.selectChatModels({});
    console.debug(
      `All available models: ${JSON5.stringify(
        allModels.map(
          (m) =>
            `v=${m.vendor},f=${m.family},id=${m.id},name=${m.name},mtoken=${m.maxInputTokens}`
        ),
        null,
        2
      )}`
    ); // !!!!!!!
    */

    const model =
      (
        await vscode.lm.selectChatModels({
          vendor: "copilot",
          family: "gpt-4o-mini",
        })
      ).at(0) ??
      (
        await vscode.lm.selectChatModels({
          vendor: "copilot",
          family: "gpt-4o",
        })
      ).at(0) ??
      (
        await vscode.lm.selectChatModels({
          vendor: "copilot",
          family: "Gemini",
          id: "models/gemini-2.5-flash", // "models/gemini-2.5-pro"
        })
      ).at(0) ??
      (await vscode.lm.selectChatModels({})).at(0);

    if (model && !this._model) {
      this._model = model;
      console.debug(
        `Selected model: v=${this._model.vendor};f=${this._model.family};id=${this._model.id}`
      );
    }
  }

  /** !!!!!! */
  public override async getSpec(): Promise<string | undefined> {
    if (this._fn.getCmt() === undefined) {
      this._fn.setCmt(
        JSON5.parse(await this._query([this._prompts.specFromCode])).spec.join(
          "\n"
        )
      );
      console.debug(`got the spec from the llm: ${this._fn.getCmt()}`); // !!!!!!
    }
    return this._fn.getCmt();
  } // !!!!!!

  /** !!!!!! */
  public override async generateExampleInputs(): Promise<FuzzIoElement[][]> {
    const inputs: FuzzIoElement[][] = JSON5.parse(
      await this._query([this._prompts.exampleInputs], true)
    );
    /* !!!!!!!!
    inputs.forEach((test) => {
      test.forEach(
        (input) =>
          (input.origin = {
            type: "model",
            category: this._cfgCategory,
            name: this._modelName,
          })
      );
    });
    */
    console.debug(
      `got these inputs from the llm: ${JSON5.stringify(inputs, null, 2)}`
    ); // !!!!!!
    return inputs;
  } // !!!!!!

  /** !!!!!! */
  public override async predictArgOverrides(): Promise<ModelArgOverrides[]> {
    // !!!!!!const oldOverrides = this._overrides;
    const newOverrides: ModelArgOverrides[] = JSON5.parse(
      await this._query([this._prompts.predictRanges])
    );
    console.debug(
      `got these overrides from the llm: ${JSON5.stringify(
        newOverrides,
        null,
        2
      )}`
    ); // !!!!!!
    // this._overrides = AbstractProgramModel.compareModelArgOverrides(
    //   oldOverrides,
    //   newOverrides
    // ); // !!!!!! Not sure this is necessary
    this._overrides = newOverrides;
    console.debug(
      `got these overrides from the llm (AFTER comparison): ${JSON5.stringify(
        this._overrides,
        null,
        2
      )}`
    ); // !!!!!!
    return this._overrides;
  } // !!!!!!

  /** !!!!!! */
  public async predictOutput(
    inputs: FuzzIoElement[]
  ): Promise<FuzzIoElement[]> {
    const output: FuzzIoElement[] = [
      {
        ...JSON5.parse(
          await this._query([this._prompts.predictOutput], false, {
            "fn-input": JSON5.stringify(inputs),
          })
        ),
        name: "0",
        offset: 0,
        /*
        origin: {
          type: "model",
          category: this._cfgCategory,
          name: this._modelName,
        },
        */
      },
    ];
    // !!!!!!!! validation
    console.debug(
      `got these outputs from the llm: ${JSON5.stringify(output, null, 2)}`
    );
    return output;
  } // !!!!!!

  // !!!!!! optioon to bypass cache
  private async _query(
    inPrompt: string[],
    bypassCache = false,
    variables: Record<string, string> = {}
  ): Promise<string> {
    if (!this._model) {
      await this._initModel();
    }
    if (!this._model) {
      throw new Error("Copilot models unavailable");
    }

    const prompt = inPrompt.map((p) => this._concretizePrompt(p, variables));
    const promptSerialized = JSON5.stringify(prompt);

    if (promptSerialized in this._promptCache && !bypassCache) {
      const cachedResponse = this._promptCache[promptSerialized];
      console.debug(`copilot(CACHE)<<<${prompt.join(", ")}`); // !!!!!!
      console.debug(`copilot(CACHE)>>>${cachedResponse}`); // !!!!!!
      return cachedResponse;
    } else {
      console.debug(`copilot<<<${prompt.join(", ")}`); // !!!!!!
      const promptParts: vscode.LanguageModelChatMessage[] = [];
      prompt.forEach((e) => {
        promptParts.push(vscode.LanguageModelChatMessage.User(e));
      }); // !!!!!! move to initializer
      vscode.lm.tools;
      const timer = Date.now();
      const stream = (
        await this._model.sendRequest(
          promptParts,
          {
            modelOptions: {} /*this._model.family === "Gemini"
                ? {
              generationConfig: {
                response_mime_type: `application/json`,
                responseMimeType: `application/json`,
              },
            },
            : */ /* {
              response_format: {
                type: "json_object",
              },
            },*/,
          },
          new vscode.CancellationTokenSource().token
        )
      ).text;
      const fragments: string[] = [];
      for await (const fragment of stream) {
        fragments.push(fragment);
      }
      let result = fragments.join("");
      const lines = result.split(`\n`);
      if (lines.at(0)?.startsWith("```") && lines.at(-1)?.endsWith("```")) {
        result = lines.slice(1, -1).join("\n").trim();
      } else {
        console.debug(`No markdown bullshit?? mkay: ${result}`); // !!!!!!!!
      }
      console.debug(`(${Date.now() - timer} ms) copilot(+CACHE)>>>${result}`); // !!!!!!
      this._promptCache[promptSerialized] = result;
      return result;
    }
  } // !!!!!!
}
