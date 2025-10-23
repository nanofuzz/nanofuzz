import { VmGlobals } from "../Types";

/**
 * Abstract test runner class
 */
export abstract class AbstractRunner {
  protected readonly _module: NodeJS.Module; // Node module
  protected readonly _jsFn: string; // Function to call

  /**
   * Creates a new test runner for a given module and exported module function.
   *
   * @param `module` loaded program module
   * @param `jsFn` exported function within `module` to call
   */
  public constructor(module: NodeJS.Module, jsFn: string) {
    this._module = module;
    this._jsFn = jsFn;
  } // fn: constructor

  /**
   * Returns the measure's name
   */
  public get name(): string {
    return this.constructor.name;
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
  ): [unknown, VmGlobals];
}
