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
   * Returns the runner's name
   */
  public get name(): string {
    return this._name;
  } // property: get name

  /**
   * Called prior to the start of the run
   */
  public onRunStart(): Promise<void> {
    return new Promise((resolve, _reject) => resolve());
  }

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

  /**
   * Called after the end of the run
   */
  public async onRunEnd(): Promise<void> {
    return new Promise((resolve, _reject) => resolve());
  }
}

export type RunnerResult = {
  result: (
    | { tag: "timeout" }
    | {
        tag: "error";
        name: string;
        message: string;
        stack?: string;
        source?: "put" | "host"; // if the error originated within the put !!!!!!!!!! ts
      }
    | { tag: "value"; value: unknown }
  ) & { seq: number };
  env: VmGlobals;
};

export type RunnerInput = {
  args: unknown[];
  seq: number;
};
