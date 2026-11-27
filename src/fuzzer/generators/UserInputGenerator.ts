import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { ArgValueTypeWrapped } from "../analysis/Types";
import { isArgValueType } from "../analysis/Util";
import { FunctionDef } from "../analysis/FunctionDef";
import { FuzzOptions, FuzzPinnedTest, InputAndSource } from "../Types";
import { NextableStatus } from "./Types";
import { AbstractRunner } from "../runners/AbstractRunner";
import { RunnerResult } from "../runners/Types";
import { isError } from "../Util";

/**
 * UserInputGenerator executes a user-provided input generator function
 * defined in the same module and language as the function under test.
 */
export class UserInputGenerator extends AbstractInputGenerator {
  protected static readonly MAX_CONSECUTIVE_FAILURES = 5;

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
  protected _failureTicks: number[] = []; // Ticks at which generator execution failed
  protected _consecutiveFailures = 0; // Consecutive failure streak, resets on success

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

  // ---------------------------------------------------------------------------
  // Core Public Generator Contract
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Lifecycle & Properties
  // ---------------------------------------------------------------------------

  /**
   * Prepares generator at the start of a fuzz run.
   */
  public override onRunStart(
    active: boolean,
    _injectedInputs: (FuzzPinnedTest | Omit<InputAndSource, "tick">)[],
    _transformRunner: AbstractRunner | undefined,
    fuzzOptions: FuzzOptions,
    userGenRunner?: AbstractRunner
  ): void {
    this._active = active;
    this._exhausted = false;
    this._inputQueue = [];
    this._callsPending = 0;
    this._pendingPromise = undefined;
    this._pendingError = undefined;
    this._failureTicks = [];
    this._consecutiveFailures = 0;
    this._fnTimeout = fuzzOptions.fnTimeout;
    if (userGenRunner !== undefined) {
      this._userGenRunner = userGenRunner;
    }
    if (this._active && this._userGenRunner) {
      this._getMoreInputs();
    }
  } // fn: onRunStart

  /**
   * Returns human-readable generator name
   */
  public override get humanName(): string {
    return "User";
  } // property: get humanName

  /**
   * Target queue capacity scaled to 3x active workers.
   */
  public get targetQueueSize(): number {
    return Math.max(3, this.workerCount * 3);
  }

  /**
   * Returns recorded ticks where generator execution failed or timed out.
   */
  public get failureTicks(): readonly number[] {
    return this._failureTicks;
  } // property: get failureTicks

  /**
   * Returns total count of failures recorded.
   */
  public get failureCount(): number {
    return this._failureTicks.length;
  } // property: get failureCount

  /**
   * Returns current consecutive failure streak.
   */
  public get consecutiveFailures(): number {
    return this._consecutiveFailures;
  } // property: get consecutiveFailures

  /**
   * User-provided inputs bypass input transformers.
   */
  public override get isTransformable(): boolean {
    return false;
  } // property: get isTransformable

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

    const callSeed =
      this._rngSeed !== undefined && this._rngSeed.length > 0
        ? `${this._rngSeed}:${this._tickCount}:${this._prng()}`
        : undefined;
    const batchSize = Math.max(
      1,
      this.targetQueueSize - this._inputQueue.length
    );
    const prngArg: Record<string, unknown> = {
      __nanofuzz_type: "prng",
      batch_size: batchSize,
    };
    if (callSeed !== undefined) {
      prngArg.seed = callSeed;
    }

    let resolvePending!: (hasInputs: boolean) => void;
    this._pendingPromise = new Promise<boolean>((resolve) => {
      resolvePending = resolve;
    });

    const runner = this._userGenRunner;
    const effectiveTimeout = Math.max(this._fnTimeout * 10, 30000);
    const runnerPromise = runner.run(
      [prngArg],
      effectiveTimeout,
      [],
      {},
      batchSize
    );

    runnerPromise
      .then((res: RunnerResult) => {
        const results = res.results ?? [];
        if (results.length === 0) {
          this._exhausted = true;
          return;
        }

        let validCount = 0;
        let voluntaryExhaustion = false;
        let firstErrorMsg: string | undefined;
        const argDefs = this._fn.getArgDefs();

        for (const item of results) {
          if (item.tag === "value") {
            // Voluntary exhaustion: generator returned undefined or null to signal end-of-stream
            if (item.value === undefined || item.value === null) {
              voluntaryExhaustion = true;
              break;
            }

            if (!Array.isArray(item.value)) {
              this._failureTicks.push(this._tickCount);
              continue;
            }

            const rawVal = item.value;
            const wrappedValues: ArgValueTypeWrapped[] = argDefs.map(
              (_argDef, i) => ({
                tag: "ArgValueTypeWrapped",
                value:
                  i < rawVal.length && isArgValueType(rawVal[i])
                    ? rawVal[i]
                    : undefined,
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
            validCount++;
          } else {
            // Failure, skip, or timeout on individual iteration
            this._failureTicks.push(this._tickCount);
            if (!firstErrorMsg) {
              if (item.tag === "skip") {
                firstErrorMsg = `UserInputGenerator '${runner.name}' threw UnsatisfiedAssumption which is not allowed in input generators: ${item.message}`;
              } else if (item.tag === "error") {
                const stack = item.stack ? `\n${item.stack}` : "";
                firstErrorMsg = `UserInputGenerator '${runner.name}' threw an error: ${item.name}: ${item.message}${stack}`;
              } else {
                firstErrorMsg = `UserInputGenerator '${runner.name}' timed out exceeding ${effectiveTimeout} ms`;
              }
            }
          }
        }

        if (voluntaryExhaustion) {
          this._exhausted = true;
          return;
        }

        if (validCount > 0) {
          // Generator is making progress: reset consecutive failures counter!
          this._consecutiveFailures = 0;
        } else {
          // Entire batch yielded 0 valid inputs
          this._consecutiveFailures++;
          if (
            this._consecutiveFailures >=
            UserInputGenerator.MAX_CONSECUTIVE_FAILURES
          ) {
            this._exhausted = true;
            this._pendingError = new Error(
              firstErrorMsg ??
                `UserInputGenerator '${runner.name}' failed to produce valid inputs across ${this._consecutiveFailures} consecutive batches.`
            );
          } else {
            // Attempt retry
            if (
              this._active &&
              this._userGenRunner &&
              !this._exhausted &&
              this._inputQueue.length < 3
            ) {
              this._getMoreInputs();
            }
          }
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
