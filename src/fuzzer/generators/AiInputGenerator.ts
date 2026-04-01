import { AbstractInputGenerator } from "./AbstractInputGenerator";
import {
  ArgTag,
  ArgType,
  ArgValueType,
  ArgValueTypeWrapped,
} from "../analysis/typescript/Types";
import * as JSON5 from "json5";
import { LlmAdapter } from "../adapters/LlmAdapter";
import { ArgDef, FunctionDef, InputAndSource } from "../Fuzzer";
import { ArgDefValidator } from "../analysis/typescript/ArgDefValidator";
import * as zod from "zod";
import { InputGeneratorStatsAi } from "./Types";

/**
 * Generates new inputs using a large language model
 */
export class AiInputGenerator extends AbstractInputGenerator {
  protected _inputQueue: InputAndSource[] = []; // Cache of valid, generated inputs
  protected _fn: FunctionDef; // Function target for inputs
  protected _llm?: LlmAdapter; // Back-end AI model
  protected _callsPending = 0; // Number of calls to AI model pending
  protected _stats = _initStats(); // Stats about inputs generated

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
    return !!this._inputQueue.length;
  } // fn: isAvailable

  /**
   * Manage the life-cycle of the ProgramModel and clear
   * any now-invalid items out of the input cache at the
   * start of each run.
   *
   * @param `active` indicates if inputs are expected this run
   */
  public onRunStart(active: boolean): void {
    // Abandon back-end if stale or no longer configured
    if (
      this._llm &&
      (!active || !LlmAdapter.isConfigured() || this._llm.isStale())
    ) {
      this._llm = undefined;
      this._inputQueue = []; // empty the queue to avoid user confusion
    }

    // Create new back-end if configured but not yet loaded
    if (active && !this._llm && LlmAdapter.isConfigured()) {
      this._llm = new LlmAdapter();
      this._inputQueue = []; // empty the queue to avoid user confusion
    }

    // Input generation options may have changed, so re-validate
    // any cached inputs
    if (this._inputQueue.length) {
      const validator = new ArgDefValidator(this._specs);
      this._inputQueue = this._inputQueue.filter((e) => {
        const isValid = validator.validate(e.value);
        if (!isValid) {
          this._stats.inputs.invalidLater++;
        }
        return isValid;
      });
    }

    // Refill the cache if it's empty
    if (this._llm && !this._inputQueue.length) {
      this._getMoreInputs();
    }
  } // fn: onRunStart

  /**
   * Returns the next input
   *
   * @returns AI-generated input
   */
  public next(): InputAndSource {
    const inputToReturn = this._inputQueue.pop();
    if (inputToReturn === undefined) {
      throw new Error(`next() not allowed when isAvailable()===false`);
    }
    if (!this._inputQueue.length) {
      this._getMoreInputs();
    }
    return inputToReturn;
  } // fn: next

  /**
   * Gets more inputs from the back-end AI model
   */
  private _getMoreInputs(): void {
    // Let any prior calls finish before making a new one
    if (this._callsPending) {
      return;
    }

    if (this._llm) {
      this._callsPending++;
      const modelId = this._llm.id;
      try {
        const validInputs: { [k: string]: ArgValueType }[] = [];
        const invalidInputs: { [k: string]: ArgValueType }[] = [];
        const validator = new ArgDefValidator(this._specs);

        this._stats.calls.sent++;
        const [schema, directives] = this._getInputsSchema();

        // Fetch inputs from the llm
        this._llm.genInputs(this._fn, [schema, directives]).then((inputs) => {
          // Update tokens received stats
          if (inputs.stats) {
            this._stats.tokens.received += inputs.stats.tokensReceived;
            if (!this._stats.tokens.receivedCost) {
              this._stats.tokens.receivedCost = {
                ...inputs.stats.tokensReceivedCost,
              };
            } else if (
              this._stats.tokens.receivedCost.unit ===
              inputs.stats.tokensReceivedCost.unit
            ) {
              this._stats.tokens.receivedCost.amt +=
                inputs.stats.tokensReceivedCost.amt;
            }

            // Update tokens sent stats
            this._stats.tokens.sent += inputs.stats.tokensSent;
            if (!this._stats.tokens.sentCost) {
              this._stats.tokens.sentCost = {
                ...inputs.stats.tokensSentCost,
              };
            } else if (
              this._stats.tokens.sentCost.unit ===
              inputs.stats.tokensSentCost.unit
            ) {
              this._stats.tokens.sentCost.amt +=
                inputs.stats.tokensSentCost.amt;
            }
          }

          // Handle error cases
          switch (inputs.error?.type) {
            case undefined:
              this._stats.calls.valid++;
              this._stats.calls.history.push({ success: true });
              break;
            case "discard":
              this._stats.calls.invalid++;
              this._stats.calls.history.push({ discard: true });
              break;
            case "failure":
              this._stats.calls.failed++;
              this._stats.calls.history.push({
                failure: true,
                message: inputs.error.message,
              });
              break;
          }

          // Process the inputs
          inputs.programInputs.forEach((input) => {
            this._stats.inputs.gen++;

            // Decode the input
            Object.keys(input).forEach((k) => {
              input[k] = _decode(input[k]);
            });

            // Validate the input
            if (
              validator.validate(
                this._specs.map((arg) => {
                  return {
                    tag: "ArgValueTypeWrapped",
                    value: input[arg.getName()],
                  };
                })
              )
            ) {
              validInputs.push(input);
            } else {
              invalidInputs.push(input);
              this._stats.inputs.invalid++;
            }
          });
          if (invalidInputs.length && LlmAdapter.isDebugConfigured()) {
            console.debug(
              `Discarded ${invalidInputs.length} of ${invalidInputs.length + validInputs.length} LLM inputs for being invalid: ${JSON5.stringify(invalidInputs, null, 2)}`
            );
          }

          // Push valid inputs to the input queue
          this._inputQueue.push(
            ...validInputs.map((input): InputAndSource => {
              return {
                tick: 0,
                value: this._specs.map((arg): ArgValueTypeWrapped => {
                  return {
                    tag: "ArgValueTypeWrapped",
                    value: input[arg.getName()],
                  };
                }),
                source: {
                  type: "generator",
                  generator: "AiInputGenerator",
                  model: modelId ?? "unknown model",
                },
              };
            })
          );
        });
      } finally {
        this._callsPending--;
      }
    }
  } // fn: _getMoreInputs

  /**
   * Returns a JSON schema representing the function inputs.
   *
   * @returns JSON schema
   */
  protected _getInputsSchema(): [
    ReturnType<zod.ZodType["toJSONSchema"]>,
    string[],
  ] {
    const zodObj: { [k: string]: zod.ZodType } = {};
    const directives: string[] = [];
    this._specs.forEach((arg) => {
      zodObj[arg.getName()] = this._argDefToSchema(
        arg,
        arg.getName(),
        directives
      );
    });
    directives.push(
      `${NANOFUZZ_UNDEFINED} is a placeholder for the actual value \`undefined\``
    );
    directives.push(
      `${NANOFUZZ_MISSING_PROPERTY} is a placeholder for a missing property`
    );
    directives.push(
      `${NANOFUZZ_TRUE} is a placeholder for the actual value \`true\``
    );
    directives.push(
      `${NANOFUZZ_FALSE} is a placeholder for the actual value \`false\``
    );
    return [
      zod
        .strictObject({ programInputs: zod.array(zod.strictObject(zodObj)) })
        .toJSONSchema(),
      directives,
    ];
  } // fn: _getInputsSchema

  /**
   * Creates a ZodSchema that represents the structure and
   * constraints of the ArgDef provided.
   *
   * Because Zod has many limitations in terms of what it
   * can represernt, in some cases we use placeholder values
   * that must be decoded with `_decode` prior to use.
   *
   * @param `inArg` ArgDef to convert to a Zod schema
   * @returns a Zod schema for the ArgDef
   */
  protected _argDefToSchema(
    inArg: ArgDef<ArgType>,
    path: string,
    directives: string[]
  ): zod.ZodType {
    // !!! do we handle optionality or dimensions in all cases here?
    const argIntervals = inArg.getIntervals();
    const argChildren = inArg
      .getChildren()
      .filter((child) => !child.isNoInput());
    const argOptions = inArg.getOptions();

    // Helper function that creates a Zod schema from an ArgDef
    const argToZod = (arg: ArgDef<ArgType>): zod.ZodType => {
      switch (arg.getType()) {
        case ArgTag.NUMBER: {
          const desc = `value must be >= ${Number(argIntervals[0].min)} && <= ${Number(argIntervals[0].max)}`;
          directives.push(`${path}: ${desc}`);
          return (argOptions.numInteger ? zod.int() : zod.number())
            .min(Number(argIntervals[0].min))
            .max(Number(argIntervals[0].max))
            .describe(desc);
        }
        case ArgTag.BOOLEAN: {
          if (!!argIntervals[0].min !== !!argIntervals[0].max) {
            return zod.boolean();
          } else {
            const specialValue = argIntervals[0].min
              ? NANOFUZZ_TRUE
              : NANOFUZZ_FALSE;
            const desc = `value must === \`${specialValue}\``;
            directives.push(`${path}: ${desc}`);
            return zod.enum([specialValue]).describe(desc);
          }
        }
        case ArgTag.STRING: {
          const charSet = argOptions.strCharset;
          const desc = `string length must be >= ${argOptions.strLength.min} && <= ${argOptions.strLength.max}; the string may contain only the following characters: ${charSet}`;
          directives.push(`${path}: ${desc}}`);
          return zod
            .string()
            .min(argOptions.strLength.min)
            .max(argOptions.strLength.max)
            .refine((s) => [...s].every((char) => charSet.includes(char)))
            .describe(desc);
        }
        case ArgTag.LITERAL: {
          const literalValue = arg.getConstantValue();
          switch (typeof literalValue) {
            case "undefined": {
              directives.push(
                `${path}: value must === \`${NANOFUZZ_UNDEFINED}\``
              );
              return zod.enum([NANOFUZZ_UNDEFINED]);
            }
            case "boolean": {
              const specialValue = literalValue
                ? NANOFUZZ_TRUE
                : NANOFUZZ_FALSE;
              directives.push(`${path}: value must === ${specialValue}`);
              return zod.enum([specialValue]);
            }
            case "number":
              directives.push(
                `${path}: value must === ${String(literalValue)}`
              );
              return zod.number().min(literalValue).max(literalValue);
            case "string":
              directives.push(
                `${path}: value must === \`${String(literalValue)}\``
              );
              return zod.enum([literalValue]);
            case "object":
              throw new Error(`Array and Object literals not supported`);
            default:
              throw new Error(`Type not supported: ${typeof literalValue}`);
          }
        }
        case ArgTag.OBJECT: {
          const obj: { [k: string]: zod.ZodType } = {};
          argChildren.forEach((child) => {
            const zodChild = this._argDefToSchema(
              child,
              `${path}.${child.getName()}`,
              directives
            );
            obj[child.getName()] = child.isOptional()
              ? zod.union([zodChild, zod.enum([NANOFUZZ_MISSING_PROPERTY])])
              : zodChild; // mandatory
          });
          return zod.strictObject(obj);
        }
        case ArgTag.UNION: {
          const unionMembers = argChildren.map((child, i) =>
            this._argDefToSchema(child, `${path}.union[${i}]`, directives)
          );
          return zod.union([
            unionMembers[0],
            unionMembers[1],
            ...unionMembers.slice(2),
          ]);
        }
        default: {
          throw new Error(`Unexpected argument type: "${arg.getType()}"`);
        }
      }
    }; // helper fn: argToZod

    // Optionality
    let zodArg: zod.ZodType = inArg.isOptional()
      ? zod.union([argToZod(inArg), zod.enum([NANOFUZZ_UNDEFINED])])
      : argToZod(inArg); // mandatory

    // Dimensions
    argOptions.dimLength.forEach((dim) => {
      const desc = `array length must be >= ${dim.min} && <= ${dim.max}`;
      directives.push(`${path}: ${desc}`);
      zodArg = zod.array(zodArg).min(dim.min).max(dim.max).describe(desc);
    });
    return zodArg;
  } // fn: _argDefToSchema

  /**
   * Return stats about the AI input generation process
   */
  public get stats(): InputGeneratorStatsAi {
    return JSON.parse(JSON.stringify(this._stats));
  } // getter: stats
} // class: AiInputGenerator

/**
 * Returns an initialized stats structure
 */
function _initStats(): InputGeneratorStatsAi {
  return {
    inputs: { gen: 0, invalid: 0, invalidLater: 0, inQueue: 0 },
    calls: { sent: 0, valid: 0, invalid: 0, failed: 0, history: [] },
    tokens: {
      sent: 0,
      received: 0,
    },
  };
} // fn: _initStats

/**
 * Replaces special placeholder values in an ArgValueType with
 * the actual values. We do this to work around the cases Zod
 * can't handle natively.
 *
 * @param data
 * @returns
 */
function _decode(data: ArgValueType): ArgValueType {
  switch (typeof data) {
    case "object":
      if (Array.isArray(data)) {
        return data.map((e) => _decode(e));
      } else {
        Object.keys(data).forEach((k) => {
          if (data[k] === NANOFUZZ_MISSING_PROPERTY) {
            delete data[k];
          } else {
            data[k] = _decode(data[k]);
          }
        });
        return data;
      }
    case "string": {
      switch (data) {
        case NANOFUZZ_MISSING_PROPERTY:
          throw new Error(
            "Internal error: NANOFUZZ_MISSING_PROPERTY not expected in string"
          );
        case NANOFUZZ_UNDEFINED:
          return undefined;
        case NANOFUZZ_TRUE:
          return true;
        case NANOFUZZ_FALSE:
          return false;
        default:
          return data;
      }
    }
    default:
      return data;
  }
} // fn: _decode

// Constants for encoding/decoding
const NANOFUZZ_UNDEFINED = "___NANOFUZZ____6158195231___UNDEFINED___";
const NANOFUZZ_MISSING_PROPERTY =
  "___NANOFUZZ____6158195231___MISSING___PROPERTY___";
const NANOFUZZ_TRUE = "___NANOFUZZ____6158195231___TRUE___";
const NANOFUZZ_FALSE = "___NANOFUZZ____6158195231___FALSE___";
