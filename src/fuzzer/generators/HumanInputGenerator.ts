import { ArgDef } from "../analysis/ArgDef";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { NextableStatus } from "./Types";
import { FuzzPinnedTest, InputAndSource } from "../Types";

/**
 * HumanInputGenerator generates predefined/injected inputs (e.g., pinned tests).
 *
 * It reports a priority nextable status of "now!" until exhausted to
 * ensure injected inputs are always drained prior to other generators.
 */
export class HumanInputGenerator extends AbstractInputGenerator {
  protected _inputs: Omit<InputAndSource, "tick">[] = [];
  protected _index = 0;

  public constructor(
    specs: ArgDef[] = [],
    rngSeed?: string,
    inputs: (FuzzPinnedTest | Omit<InputAndSource, "tick">)[] = []
  ) {
    super(specs, rngSeed);
    if (inputs.length > 0) {
      this._inject(inputs);
    }
  }

  public override nextable(): NextableStatus {
    return this._index < this._inputs.length ? "now!" : false;
  } // nextable()

  public override next(): InputAndSource {
    if (this._index >= this._inputs.length) {
      throw new Error("HumanInputGenerator is exhausted.");
    }
    const item = this._inputs[this._index++];
    return {
      tick: this._index,
      value: item.value,
      source: item.source,
      injected: true,
    };
  } // next()

  public override onRunStart(
    _active: boolean,
    injectedInputs?: (FuzzPinnedTest | Omit<InputAndSource, "tick">)[]
  ): void {
    if (injectedInputs !== undefined && injectedInputs.length > 0) {
      this._inject(injectedInputs);
    }
  } // onRunStart()

  /**
   * Inject inputs into the queue
   */
  protected _inject(
    inputs: (FuzzPinnedTest | Omit<InputAndSource, "tick">)[]
  ): void {
    this._inputs.push(
      ...inputs.map((item): Omit<InputAndSource, "tick"> => {
        if ("input" in item) {
          return {
            value: item.input.map((i) => ({
              tag: "ArgValueTypeWrapped",
              value: i.value,
            })),
            source: item.input.length
              ? item.input[0].origin
              : { type: "unknown" },
            injected: true,
          };
        }
        return {
          value: item.value,
          source: item.source,
          injected: true,
        };
      })
    );
  } // _inject()
} // class: HumanInputGenerator
