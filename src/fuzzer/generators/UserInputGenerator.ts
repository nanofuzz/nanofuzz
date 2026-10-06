import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { ArgValueTypeWrapped } from "../analysis/Types";
import { FunctionDef } from "../analysis/FunctionDef";
import { FuzzPinnedTest, InputAndSource } from "../Types";
import { NextableStatus } from "./Types";
import { AbstractRunner, RunnerResult } from "../runners/AbstractRunner";
import * as JSONN from "../../Jsonn";
import { isError } from "../Util";

/**
 * UserInputGenerator executes a user-provided input generator function
 * defined in the same module and language as the function under test.
 */
export class UserInputGenerator extends AbstractInputGenerator {
  protected _fn: FunctionDef; // Target function under test
  protected _userGenRunner?: AbstractRunner; // Test runner for user generator function
  protected _active = false; // Whether generator is active for current run
  protected _exhausted = false; // Whether user generator returned undefined (exhausted)
  protected _inputQueue: InputAndSource[] = []; // In-memory queue of generated inputs
  protected _callsPending = 0; // Number of in-flight runner calls
  protected _pendingError?: Error; // Uncaught error/exception from generator execution
  protected _tickCount = 0; // Iteration count for PRNG seeding
  protected _fnTimeout = 0; // Execution timeout per generator call
  protected _rngSeed?: string; // Random number generator seed

  public constructor(
    fn: FunctionDef,
    rngSeed: string | undefined,
    userGenRunner?: AbstractRunner,
    fnTimeout: number = 0
  ) {
    super(fn.getArgDefs(), rngSeed);
    this._fn = fn;
    this._rngSeed = rngSeed;
    this._userGenRunner = userGenRunner;
    this._fnTimeout = fnTimeout;
  } // fn: constructor

  /**
   * Returns human-readable generator name
   */
  public override get humanName(): string {
    return "User";
  } // property: get humanName

  /**
   * User-provided inputs bypass input transformers.
   */
  public override get isTransformable(): boolean {
    return false;
  } // property: get isTransformable

  /**
   * Returns 'now' if inputs are available, 'soon' if in-flight, or false if exhausted/disabled.
   */
  public override nextable(): NextableStatus {
    if (this._pendingError) {
      return "now";
    }
    if (
      this._active &&
      this._userGenRunner &&
      !this._exhausted &&
      !this._callsPending &&
      this._inputQueue.length < 3
    ) {
      this._getMoreInputs();
    }
    if (this._inputQueue.length > 0) {
      return "now";
    }
    if (this._callsPending > 0) {
      return "soon";
    }
    return false;
  } // fn: nextable

  /**
   * Returns the next input from the queue.
   */
  public override next(): InputAndSource {
    if (this._pendingError) {
      const err = this._pendingError;
      this._pendingError = undefined;
      throw err;
    }
    const item = this._inputQueue.shift();
    if (item === undefined) {
      throw new Error(`next() not allowed when nextable() is false`);
    }
    if (
      this._active &&
      this._userGenRunner &&
      !this._exhausted &&
      !this._callsPending &&
      this._inputQueue.length < 3
    ) {
      this._getMoreInputs();
    }
    return item;
  } // fn: next

  /**
   * Asynchronously waits until the pending runner execution completes.
   */
  public override async waitUntilReady(): Promise<boolean> {
    while (this.nextable() === "soon") {
      if (this._pendingPromise) {
        await this._pendingPromise;
      } else {
        break;
      }
    }
    if (this._pendingError) {
      const err = this._pendingError;
      this._pendingError = undefined;
      throw err;
    }
    const status = this.nextable();
    return status === "now" || status === "now!";
  } // fn: waitUntilReady

  /**
   * Asynchronously awaits any pending generator call and returns the next input.
   */
  public override async nextSoon(): Promise<InputAndSource> {
    const ready = await this.waitUntilReady();
    if (ready) {
      return this.next();
    }
    throw new Error(
      `nextSoon() failed: generator '${this.name}' is no longer pending and produced no inputs.`
    );
  } // fn: nextSoon

  /**
   * Prepares generator at the start of a fuzz run.
   */
  public override onRunStart(
    active: boolean,
    _injectedInputs: (FuzzPinnedTest | Omit<InputAndSource, "tick">)[] = [],
    _transformRunner?: AbstractRunner,
    fnTimeout: number = 0,
    _maxDupeInputs: number = 0,
    userGenRunner?: AbstractRunner
  ): void {
    this._active = active;
    this._exhausted = false;
    this._inputQueue = [];
    this._callsPending = 0;
    this._pendingPromise = undefined;
    this._pendingError = undefined;
    this._fnTimeout = fnTimeout;
    if (userGenRunner !== undefined) {
      this._userGenRunner = userGenRunner;
    }
    if (this._active && this._userGenRunner) {
      this._getMoreInputs();
    }
  } // fn: onRunStart

  /**
   * Triggers an asynchronous runner call to fetch the next input from the user generator.
   */
  protected _getMoreInputs(): void {
    if (
      this._callsPending > 0 ||
      this._exhausted ||
      !this._active ||
      !this._userGenRunner
    ) {
      return;
    }

    this._callsPending++;
    this._tickCount++;

    const callSeed = `${this._rngSeed ?? ""}:${this._tickCount}:${this._prng()}`;
    const prngArg = { __nanofuzz_type: "prng", seed: callSeed };

    let resolvePending!: (hasInputs: boolean) => void;
    this._pendingPromise = new Promise<boolean>((resolve) => {
      resolvePending = resolve;
    });

    const runner = this._userGenRunner;
    const effectiveTimeout = Math.max(this._fnTimeout * 5, 5000);
    const runnerPromise = runner.run([prngArg], effectiveTimeout);

    runnerPromise
      .then((res: RunnerResult) => {
        if (res.result.tag === "skip") {
          throw new Error(
            `UserInputGenerator '${runner.name}' threw UnsatisfiedAssumption which is not allowed in input generators: ${res.result.message}`
          );
        }

        if (res.result.tag === "error") {
          const stack = res.result.stack ? `\n${res.result.stack}` : "";
          throw new Error(
            `UserInputGenerator '${runner.name}' threw an error: ${res.result.name}: ${res.result.message}${stack}`
          );
        }

        if (res.result.tag === "timeout") {
          throw new Error(
            `UserInputGenerator '${runner.name}' timed out exceeding ${effectiveTimeout} ms`
          );
        }

        if (res.result.tag === "value") {
          const rawVal = res.result.value;

          // Exhaustion check: undefined or null indicates no more inputs
          if (rawVal === undefined || rawVal === null) {
            this._exhausted = true;
            return;
          }

          if (!Array.isArray(rawVal)) {
            throw new Error(
              `UserInputGenerator '${runner.name}' must return an array/tuple of arguments (or undefined when exhausted), but returned: ${JSONN.stringify(rawVal)}`
            );
          }

          const argDefs = this._fn.getArgDefs();
          const wrappedValues: ArgValueTypeWrapped[] = argDefs.map(
            (_argDef, i) => ({
              tag: "ArgValueTypeWrapped",
              value: i < rawVal.length ? rawVal[i] : undefined,
            })
          );

          const candidate: InputAndSource = {
            tick: 0,
            value: wrappedValues,
            source: {
              type: "generator",
              generator: "UserInputGenerator",
              fnName: runner.name,
            },
          };

          this._inputQueue.push(candidate);
        }
      })
      .catch((e: unknown) => {
        this._exhausted = true;
        this._pendingError = isError(e) ? e : new Error(String(e));
      })
      .finally(() => {
        this._callsPending--;
        resolvePending(this._inputQueue.length > 0);
        this._pendingPromise = undefined;
      });
  } // fn: _getMoreInputs
} // class: UserInputGenerator
