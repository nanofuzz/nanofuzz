import { AbstractRunner, RunnerResult } from "./AbstractRunner";
import { VmGlobals } from "../Types";
import { isError } from "../Util";
import vm from "vm";

/**
 * Javascript test runner
 */
export class JavascriptRunner extends AbstractRunner {
  protected readonly _module: NodeJS.Module; // Node module
  protected readonly _jsFn: string; // Function to call
  protected _fnWrapper; // wrapper function for calling `jsFn`
  protected _seq = 0;

  /**
   * Create a new Javascript function runner
   *
   * @param `module` loaded program module
   * @param `jsFn` exported function within `module` to call
   */
  public constructor(module: NodeJS.Module, jsFn: string) {
    super(jsFn);

    this._module = module;
    this._jsFn = jsFn;

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
        `Cannot run '${jsFn} in ${module.filename} because it is not a function`
      );
    }

    // Build function wrapper that we will call with inputs
    this._fnWrapper = this.functionTimeout((...inputs: unknown[]): unknown => {
      return fnToCall(...inputs);
    });
  } // fn: constructor

  /**
   * Run `jsFn` in `module` with `inputs`
   *
   * @param `inputs` inputs to function
   * @param `timeout` stop and fail after `timeout` ms
   * @returns
   */
  public async run(
    inputs: unknown[],
    timeout: number | undefined = 0
  ): Promise<RunnerResult> {
    const thisSeq = this._seq++;
    try {
      const [outputs, context] = this._fnWrapper(timeout, ...inputs);
      return Promise.resolve({
        result: {
          tag: "value",
          value: outputs,
          seq: thisSeq,
        },
        env: context,
      });
    } catch (e: unknown) {
      if (isTimeoutError(e)) {
        return Promise.resolve({
          result: {
            tag: "timeout",
            seq: thisSeq,
          },
          env: {},
        });
      } else {
        if (isError(e)) {
          return Promise.resolve({
            result: {
              tag: "error",
              name: e.name,
              message: e.message,
              stack: e.stack,
              seq: thisSeq,
            },
            env: {},
          });
        } else {
          return Promise.resolve({
            result: {
              tag: "error",
              name: "UnknownJavsscriptRunnerError",
              message: "unknown",
              stack: "<no stack>",
              seq: thisSeq,
            },
            env: {},
          });
        }
      }
    }
  } // fn: run

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
  private functionTimeout(
    function_: (...inputs: unknown[]) => unknown
  ): (
    timeout: number | undefined,
    ...arguments_: unknown[]
  ) => [unknown, VmGlobals] {
    const script = new vm.Script(`returnValue = function_();`);

    const wrappedFunction = (
      timeout: number | undefined,
      ...arguments_: unknown[]
    ): [unknown, VmGlobals] => {
      // `function_` resides in the context of the original
      // loaded module, so we need minimal context here.
      const context: Record<string, unknown> = {
        returnValue: undefined,
        function_: () => function_(...arguments_),
      };

      script.runInNewContext(context, timeout ? { timeout: timeout } : {});

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
} // class: JavascriptRunner

/**
 * Adapted from: https://github.com/sindresorhus/function-timeout/blob/main/index.js
 *
 * Returns true if the exception is a timeout.
 *
 * @param error exception
 * @returns true if the exeception is a timeout exception, false otherwise
 */
function isTimeoutError(error: unknown): boolean {
  return (
    isError(error) &&
    "code" in error &&
    error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
  );
} // fn: isTimeoutError()
