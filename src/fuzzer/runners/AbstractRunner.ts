import { AbstractHost } from "./AbstractHost";
import { RunnerCoverage, RunnerResult } from "./Types";

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
  } // get: name

  /**
   * Returns the module/target filename associated with this runner, if any.
   */
  public get filename(): string | undefined {
    return undefined;
  } // get: filename

  /**
   * Optional coverage info captured during test runner initialization or execution.
   */
  public get coverageInfo(): RunnerCoverage | undefined {
    return undefined;
  } // get: coverageInfo

  /**
   * Optional coverage info from the most recent run execution.
   */
  public get lastRunCoverage(): RunnerCoverage | undefined {
    return undefined;
  } // get: lastRunCoverage

  /**
   * Registers a callback to receive coverage hits after test execution.
   *
   * @param `callback` function called when coverage hits are produced
   */
  public onCoverage(_callback: (covData: unknown) => void): void {
    // Default no-op
  } // fn: onCoverage

  /**
   * Called prior to the start of the run
   */
  public onRunStart(): Promise<void> {
    return new Promise((resolve, _reject) => resolve());
  } // fn: onRunStart

  /**
   * Executes the test with a set of inputs and a timeout threshold.
   *
   * @param `inputs` test inputs
   * @param timeout  timeout threshold
   * @param validators optional list of validator function names to execute in-host
   * @param env optional extra environment variables
   * @param repetitions number of times to execute the function in-host (defaults to 1)
   */
  public abstract run(
    inputs: unknown[],
    timeout?: number,
    validators?: string[],
    env?: Record<string, string>,
    repetitions?: number
  ): Promise<RunnerResult>;

  /**
   * Executes a runner function with host-level interrupt handling.
   */
  public async runWithInterrupt<T>(
    fn: () => Promise<T>,
    remainingSuiteTime?: number,
    cancelFn?: () => boolean
  ): Promise<T> {
    const host = await this._getHost();
    if (host) {
      return host.runWithInterrupt(fn, remainingSuiteTime, cancelFn);
    }
    return fn();
  } // fn: runWithInterrupt

  /**
   * Internal getter for the runner's host process if one is managed.
   */
  protected async _getHost(): Promise<AbstractHost | undefined> {
    return undefined;
  } // fn: _getHost

  /**
   * Terminates the active worker host process if one is running.
   */
  public abstract killHost(): void;

  /**
   * Called after the end of the run
   */
  public async onRunEnd(): Promise<void> {
    return new Promise((resolve, _reject) => resolve());
  } // fn: onRunEnd
} // class: AbstractRunner
