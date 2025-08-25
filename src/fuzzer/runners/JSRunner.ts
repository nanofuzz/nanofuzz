import { AbstractRunner } from "./AbstractRunner";
import { VmGlobals } from "../Types";
import vm from "vm";

export class JSRunner extends AbstractRunner {
  protected _fnWrapper: any;

  // !!!!!!
  // Requires a compiled JS
  public constructor(module: NodeJS.Module, jsFn: string) {
    super(module, jsFn);

    // Ensure we found an export module member
    if (!(jsFn in module)) {
      throw new Error(
        `Could not find exported function ${jsFn} in ${module.filename} to fuzz`
      );
    }

    // Module function to call
    const fnToCall = (module as any)[jsFn];

    // Ensure that what's exported is a function
    if (typeof fnToCall !== "function") {
      throw new Error(
        `Cannot fuzz exported member '${jsFn} in ${module.filename} because it is not a function`
      );
    }

    // Build function wrapper that we will call with inputs
    this._fnWrapper = this.functionTimeout((inputs: unknown[]): unknown => {
      return fnToCall(...inputs);
    });
  }

  // !!!!!!
  public run(
    inputs: unknown[],
    timeout: number | undefined = 0
  ): [unknown, VmGlobals] {
    return this._fnWrapper(timeout, inputs);
  }

  /**
   * Adapted from: https://github.com/sindresorhus/function-timeout/blob/main/index.js
   *
   * This function accepts a function and a timeout as input.  It then returns
   * a wrapper function that will throw an exception if the function does not
   * complete within, roughly, the timeout.
   *
   * @param function_ function to be executed with the timeout
   * @param param1
   * @returns
   */
  private functionTimeout(function_: any): any {
    const script = new vm.Script(`returnValue = function_();`);

    const wrappedFunction = (
      timeout: number,
      ...arguments_: unknown[]
    ): [unknown, VmGlobals] => {
      // `function_` resides in the context of the original
      // loaded module, so we need minimal context here.
      const context: Record<string, unknown> = {
        returnValue: undefined,
        function_: () => function_(...arguments_),
      };

      script.runInNewContext(context, { timeout: timeout });

      return [context.returnValue, context];
    };

    // Name this function to aid debugging
    Object.defineProperty(wrappedFunction, "name", {
      value: `functionTimeout(${function_.name || "<anonymous>"})`,
      configurable: true,
    });

    // Return the wrapped function for calling
    return wrappedFunction;
  } // fn: functionTimeout()
}
