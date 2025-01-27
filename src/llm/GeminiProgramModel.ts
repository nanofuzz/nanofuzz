import { FunctionRef } from "../fuzzer/analysis/typescript/Types";
import { ProgramDef } from "../fuzzer/analysis/typescript/ProgramDef";
import { AbstractProgramModel } from "./AbstractProgramModel";
import * as JSON5 from "json5";
import * as gemini from "@google/generative-ai";
import { ModelInputRanges } from "./Types";

export class GeminiProgramModel extends AbstractProgramModel {
  private _apiToken: string;
  private _modelName: string;

  constructor(pgm: ProgramDef, fnRef: FunctionRef) {
    super(pgm, fnRef, "gemini");
    this._apiToken = this._getConfig("apitoken", "");
    this._modelName = this._getConfig("model", "");
    if (this._apiToken === "") {
      throw new Error("No Gemini API token is configured");
    }
    if (this._modelName === "") {
      throw new Error("No Gemini model name is configured");
    }
    if (!this._spec) {
      this.generateSpec();
    }
  }

  public override async generateSpec(): Promise<string> {
    if (!this._spec) {
      this._spec = JSON5.parse(
        await this._query([this._prompts.specFromCode])
      ).spec.join("\n");
      this._concretizePrompts();
      console.debug(`got the spec from the llm: ${this._spec}`); // !!!!!!
    }
    this.predictInputRanges(); // !!!!!! Need to take into account the ranges!
    this.generateExampleInputs(); // !!!!!!
    return this._spec;
  }

  public override async generateExampleInputs(): Promise<any[][]> {
    const inputs = JSON5.parse(
      await this._query([this._prompts.exampleInputs])
    ).inputs;
    console.debug(
      `got these tests from the llm: ${JSON5.stringify(inputs, null, 2)}`
    ); // !!!!!!
    return inputs;
  }

  public override async predictInputRanges(): Promise<ModelInputRanges> {
    const ranges: ModelInputRanges = JSON5.parse(
      await this._query([this._prompts.predictRanges])
    ).inputs;
    console.debug(
      `got these ranges from the llm: ${JSON5.stringify(ranges, null, 2)}`
    ); // !!!!!!
    return ranges;
  }

  private async _query(
    prompt: string[],
    type: "text" | "json" = "json"
  ): Promise<string> {
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
    });

    const result = await model.generateContent(promptParts);
    console.debug(`gemini>>>${result.response.text()}`); // !!!!!!
    return result.response.text();
  }
}
