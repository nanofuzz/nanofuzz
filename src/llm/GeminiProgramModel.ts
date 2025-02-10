import { AbstractProgramModel } from "./AbstractProgramModel";
import * as JSON5 from "json5";
import * as gemini from "@google/generative-ai";
import { ModelArgOverrides } from "./Types";
import { FuzzIoElement } from "fuzzer/Types";
import { FunctionDef } from "fuzzer/Fuzzer";

export class GeminiProgramModel extends AbstractProgramModel {
  private _apiToken: string;
  private _modelName: string;
  private static _promptCache: Record<string, string> = {};

  /** !!!!!! */
  constructor(fn: FunctionDef) {
    super(fn, "gemini");
    this._apiToken = this._getConfig("apitoken", "");
    this._modelName = this._getConfig("model", "");
    if (this._apiToken === "") {
      throw new Error("No Gemini API token is configured");
    }
    if (this._modelName === "") {
      throw new Error("No Gemini model name is configured");
    }
  } // !!!!!!

  /** !!!!!! */
  public override async getSpec(): Promise<string | undefined> {
    if (this._fn.getSpec() === undefined) {
      this._fn.setSpec(
        JSON5.parse(await this._query([this._prompts.specFromCode])).spec.join(
          "\n"
        )
      );
      console.debug(`got the spec from the llm: ${this._fn.getSpec()}`); // !!!!!!
    }
    return this._fn.getSpec();
  } // !!!!!!

  /** !!!!!! */
  public override async generateExampleInputs(): Promise<FuzzIoElement[][]> {
    const inputs: FuzzIoElement[][] = JSON5.parse(
      await this._query([this._prompts.exampleInputs])
    );
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
    console.debug(
      `got these tests from the llm: ${JSON5.stringify(inputs, null, 2)}`
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

  // !!!!!! optioon to bypass cache
  private async _query(
    inPrompt: string[],
    type: "text" | "json" = "json",
    bypassCache = false
  ): Promise<string> {
    const prompt = inPrompt.map((p) => this._concretizePrompt(p));
    const promptSerialized = JSON5.stringify(prompt);

    if (promptSerialized in GeminiProgramModel._promptCache && !bypassCache) {
      const cachedResponse = GeminiProgramModel._promptCache[promptSerialized];
      console.debug(`gemini(CACHE)<<<${prompt.join(", ")}`); // !!!!!!
      console.debug(`gemini(CACHE)>>>${cachedResponse}`); // !!!!!!
      return cachedResponse;
    } else {
      const genAI = new gemini.GoogleGenerativeAI(this._apiToken);
      const model = genAI.getGenerativeModel({
        model: this._modelName,
        systemInstruction: this._prompts.system,
        generationConfig: { responseMimeType: `application/${type}` },
      });
      console.debug(`gemini<<<${prompt.join(", ")}`); // !!!!!!

      const promptParts: gemini.Part[] = [];
      prompt.forEach((e) => {
        promptParts.push({
          text: e,
        });
      }); // !!!!!! move to initializer

      const result = (await model.generateContent(promptParts)).response.text();
      console.debug(`gemini(+CACHE)>>>${result}`); // !!!!!!
      GeminiProgramModel._promptCache[promptSerialized] = result;
      return result;
    }
  } // !!!!!!
}
