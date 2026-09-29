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
    return this._inputs.length > 0 ? "now!" : false;
  } // nextable()

  public override next(): InputAndSource {
    const item = this._inputs.shift();
    if (item === undefined) {
      throw new Error("HumanInputGenerator is exhausted.");
    }
    return {
      tick: 0, // client sets this
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
