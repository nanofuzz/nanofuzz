import { VmGlobals } from "../Types";

/**
 * Abstract test runner class
 */
export abstract class AbstractRunner {
  protected readonly _name: string;

  /**
   * Creates a new test runner for a given module and exported module function.
   *
   * @param `module` loaded program module
   * @param `jsFn` exported function within `module` to call
   */
  public constructor(name: string) {
    this._name = name;
  } // fn: constructor

  /**
   * Returns the measure's name
   */
  public get name(): string {
    return this._name;
  } // property: get name

  /**
   * Executes the test with a set of inputs and a timeout threshold.
   *
   * @param `inputs` test inputs
   * @param timeout  timeout threshold
   */
  public abstract run(
    inputs: unknown[],
    timeout?: number
  ): Promise<RunnerResult>;
}

export type RunnerResult = {
  result:
    | { tag: "timeout" }
    | { tag: "error"; name: string; message: string; stack?: string }
    | { tag: "value"; value: unknown };
  env: VmGlobals;
};
