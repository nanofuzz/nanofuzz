import { VmGlobals } from "../Types";

export abstract class AbstractRunner {
  protected readonly _module: NodeJS.Module;
  protected readonly _jsFn: string;

  // !!!!!!
  // Requires a compiled JS
  public constructor(module: NodeJS.Module, jsFn: string) {
    this._module = module;
    this._jsFn = jsFn;
  }

  /**
   * Returns the measure's unique identifier
   */
  public get id(): string {
    return this.constructor.name;
  }

  // !!!!!!
  public abstract run(
    inputs: unknown[],
    timeout?: number
  ): [unknown, VmGlobals];
}
