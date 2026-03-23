import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { ArgValueTypeWrapped } from "../analysis/typescript/Types";
import { InputAndSource } from "./../Types";
import * as JSON5 from "json5";
import { ProgramModel } from "../../models/ProgramModel";
import { FunctionDef } from "../Fuzzer";
import { ArgDefValidator } from "../analysis/typescript/ArgDefValidator";

/**
 * Generates new inputs using a large language model
 */
export class AiInputGenerator extends AbstractInputGenerator {
  protected _inputCache: InputAndSource[] = []; // Cache of valid, generated inputs
  protected _usedInputs: InputAndSource[] = []; // Used inputs
  protected _fn: FunctionDef; // Function target for inputs
  protected _model?: ProgramModel; // Back-end AI model
  protected _callsPending = 0; // Number of calls to AI model pending

  /**
   * Create a MutationInputGenerator
   *
   * @param `fn` FunctionDef to target with inputs
   * @param `rngSeed` Random seed for input generation
   */
  public constructor(fn: FunctionDef, rngSeed: string | undefined) {
    super(fn.getArgDefs(), rngSeed);
    this._fn = fn;
  } // fn: constructor

  /**
   * Are inputs available?
   *
   * @returns true if generator inputs are available, false otherwise
   */
  public nextable(): boolean {
    return !!this._inputCache.length;
  } // fn: isAvailable

  /**
   * Manage the life-cycle of the ProgramModel and clear
   * any now-invalid items out of the input cache at the
   * start of each run.
   */
  public onRunStart(active: boolean): void {
    // Abandon back-end if stale or no longer configured
    if (
      this._model &&
      (!active || !ProgramModel.isConfigured() || this._model.isStale())
    ) {
      this._model = undefined;
      this._inputCache = []; // flush the cache to avoid user confusion
    }

    // Create new back-end if configured but not yet loaded
    if (active && !this._model && ProgramModel.isConfigured()) {
      this._model = new ProgramModel(this._fn, this._specs);
      if (!this._inputCache.length) {
        this._getMoreInputs();
      }
      this._inputCache = []; // flush the cache to avoid user confusion
    }

    // Input generation options may have changed, so re-validate
    // any cached inputs
    if (this._inputCache.length) {
      const validator = new ArgDefValidator(this._specs);
      this._inputCache = this._inputCache.filter((e) =>
        validator.validate(e.value)
      );
    }

    // Refill the cache if it's empty
    if (this._model && !this._inputCache.length) {
      this._getMoreInputs();
    }

    return;
  } // fn: onRunStart

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

  /**
   * Gets more inputs from the back-end AI model
   */
  private _getMoreInputs(): void {
    // Let any prior calls finish before making a new one
    if (this._callsPending) {
      return;
    }

    // Bounce off the stack so we don't block the main fuzzer loop
    process.nextTick(async () => {
      if (this._model) {
        const modelId = this._model.id;
        this._callsPending++;
        try {
          this._inputCache.push(
            ...(await this._model.genInputs())
              .map((inputSet): InputAndSource => {
                return {
                  tick: 0,
                  value: inputSet.map((inputElement): ArgValueTypeWrapped => {
                    return {
                      tag: "ArgValueTypeWrapped",
                      value: inputElement.value,
                    };
                  }),
                  source: {
                    type: "generator",
                    generator: "AiInputGenerator",
                    model: modelId ?? "unknown model",
                  },
                };
              })
              .filter((e) => new ArgDefValidator(this._specs).validate(e.value))
          );
        } finally {
          this._callsPending--;
        }
      }
    });
  } // fn: _getMoreInputs
} // class: AiInputGenerator
