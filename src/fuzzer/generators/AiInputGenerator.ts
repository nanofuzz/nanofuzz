import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { ArgDef } from "../analysis/typescript/ArgDef";
import { ArgType, ArgValueTypeWrapped } from "../analysis/typescript/Types";
import { InputAndSource } from "./../Types";
import { ArgDefValidator } from "../analysis/typescript/ArgDefValidator";
import * as JSON5 from "json5";
import { AbstractProgramModel } from "../../models/AbstractProgramModel";

/**
 * Generates new inputs using a large language model
 */
export class AiInputGenerator extends AbstractInputGenerator {
  private _inputCache: InputAndSource[] = [];
  private _usedInputs: InputAndSource[] = [];
  private _validator: ArgDefValidator;
  private _model: AbstractProgramModel;
  private _gensLeft = 2; //

  /**
   * Create a MutationInputGenerator
   *
   * @param `specs` ArgDef specification of inputs to generate
   * @param `rngSeed` Random seed for input generation
   * @param `leaderboard` Running list of "interesting" inputs
   */
  public constructor(
    specs: ArgDef<ArgType>[],
    rngSeed: string,
    model: AbstractProgramModel
  ) {
    super(specs, rngSeed);
    this._validator = new ArgDefValidator(specs);
    this._model = model;
    this._getMoreInputs();
  } // fn: constructor

  /**
   * This generator requires a leaderboard with at least one
   * "interesting" input to mutate.
   *
   * @returns true if generator is available, false otherwise
   */
  public isAvailable(): boolean {
    return !!this._inputCache.length;
  } // fn: isAvailable

  /**
   * Returns the next input
   *
   * @returns AI-generated input
   */
  public next(): InputAndSource {
    const inputToReturn = this._inputCache.pop();
    if (inputToReturn === undefined) {
      throw new Error(`next() not allowed when isAvailable()===false`);
    }
    this._usedInputs.push(inputToReturn);
    if (!this._inputCache.length) {
      this._getMoreInputs();
    }
    return JSON5.parse(JSON5.stringify(inputToReturn));
  } // fn: next

  // !!!!!!
  private _getMoreInputs() {
    if (this._gensLeft) {
      console.debug(`Calling the LLM for test inputs`); // !!!!!!!
      const timer = performance.now();
      process.nextTick(async () => {
        const inputs = await this._model.generateExampleInputs();
        console.debug(
          `Got test inputs from LLM: ${JSON5.stringify(inputs, null, 2)} in ${
            performance.now() - timer
          } ms`
        ); // !!!!!!!
        this._inputCache.push(
          ...inputs
            .map((inputSet): InputAndSource => {
              return {
                tick: 0,
                value: inputSet.map((inputElement): ArgValueTypeWrapped => {
                  return {
                    value: inputElement.value,
                  };
                }),
                source: {
                  type: "generator",
                  generator: "AiInputGenerator",
                  model: this._model.id ?? "unknown model",
                },
              };
            })
            .filter((input) => this._validator.validate(input.value))
        );
      });
    }
    this._gensLeft--;
  } // fn: _getMoreInputs
} // class: AiInputGenerator
