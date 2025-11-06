import { AbstractProgramModel } from "./AbstractProgramModel";
import * as JSON5 from "json5";
import * as gemini from "@google/generative-ai";
import { ModelArgOverrides } from "./Types";
import { FunctionDef, FuzzIoElement } from "../fuzzer/Fuzzer";

export class GeminiProgramModel extends AbstractProgramModel {
  private _apiToken: string;
  private _modelName: string;
  private _promptCache: Record<string, string> = {};
  private _model: gemini.GenerativeModel;

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

    this._model = new gemini.GoogleGenerativeAI(
      this._apiToken
    ).getGenerativeModel({
      model: this._modelName,
      systemInstruction: this._prompts.system,
      generationConfig: { responseMimeType: `application/json` },
    });
  } // !!!!!!

  // !!!!!!
  public get id(): string | undefined {
    return `o=GeminiProgramModel,v=google,f=gemini,n=${this._modelName}`;
  }

  // !!!!!!
  public isAvailable(): boolean {
    return !!this._model;
  } // !!!!!!

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
    const prompt = inPrompt.map((p) => this._concretizePrompt(p, variables));
    const promptSerialized = JSON5.stringify(prompt);

    if (promptSerialized in this._promptCache && !bypassCache) {
      const cachedResponse = this._promptCache[promptSerialized];
      console.debug(`gemini(CACHE)<<<${prompt.join(", ")}`); // !!!!!!
      console.debug(`gemini(CACHE)>>>${cachedResponse}`); // !!!!!!
      return cachedResponse;
    } else {
      console.debug(`gemini<<<${prompt.join(", ")}`); // !!!!!!

      const promptParts: gemini.Part[] = [];
      prompt.forEach((e) => {
        promptParts.push({
          text: e,
        });
      }); // !!!!!! move to initializer

      const timer = performance.now();
      const result = (
        await this._model.generateContent(promptParts)
      ).response.text();
      console.debug(
        `(${performance.now() - timer} ms) gemini(+CACHE)>>>${result}`
      ); // !!!!!!
      this._promptCache[promptSerialized] = result;
      return result;
    }
  } // !!!!!!
}
