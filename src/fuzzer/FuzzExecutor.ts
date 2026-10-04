import { FunctionDef } from "./analysis/FunctionDef";
import { FunctionRef } from "./analysis/Types";
import { isArgValueType } from "./analysis/Util";
import { CompositeInputGenerator } from "./generators/CompositeInputGenerator";
import { AbstractMeasure } from "./measures/AbstractMeasure";
import { ExampleOracle } from "./oracles/ExampleOracle";
import { ImplicitOracle } from "./oracles/ImplicitOracle";
import { PropertyOracle } from "./oracles/PropertyOracle";
import { Judgment } from "./oracles/Types";
import { AbstractRunner, RunnerResult } from "./runners/AbstractRunner";
import {
  FuzzOptions,
  FuzzPinnedTest,
  FuzzTestResult,
  TransformedInputAndSource,
} from "./Types";
import { categorizeResult, getIoKey } from "./Fuzzer";
import { isError } from "./Util";

export type FuzzExecutionOutput = {
  result: FuzzTestResult;
  valTime: number;
  measureTime: number;
};

/**
 * FuzzExecutor manages the single-test execution pipeline:
 * target execution, transformer handling, oracle judgments,
 * measurements, and feedback to the input generator.
 */
export class FuzzExecutor {
  protected _runner: AbstractRunner;
  protected _transformRunner?: AbstractRunner;
  protected _propRunners: AbstractRunner[];
  protected _propertyOracle: PropertyOracle;
  protected _measures: AbstractMeasure[];
  protected _options: FuzzOptions;
  protected _function: FunctionDef;
  protected _validators: FunctionRef[];
  protected _injectMap: Map<string, FuzzPinnedTest>;
  protected _getRemainingSuiteTime: () => number;

  public constructor(
    runner: AbstractRunner,
    transformRunner: AbstractRunner | undefined,
    propRunners: AbstractRunner[],
    propertyOracle: PropertyOracle,
    measures: AbstractMeasure[],
    options: FuzzOptions,
    functionDef: FunctionDef,
    validators: FunctionRef[],
    injectMap: Map<string, FuzzPinnedTest>,
    getRemainingSuiteTime: () => number
  ) {
    this._runner = runner;
    this._transformRunner = transformRunner;
    this._propRunners = propRunners;
    this._propertyOracle = propertyOracle;
    this._measures = measures;
    this._options = options;
    this._function = functionDef;
    this._validators = validators;
    this._injectMap = injectMap;
    this._getRemainingSuiteTime = getRemainingSuiteTime;
  } // fn: constructor

  /**
   * Retrieves the list of all runners involved in the fuzzing execution pipeline.
   *
   * @returns An array of all active runners.
   */
  public get runners(): AbstractRunner[] {
    return [this._runner, this._transformRunner, ...this._propRunners].filter(
      (r): r is AbstractRunner => r !== undefined
    );
  } // get: runners

  /**
   * Executes a single test input candidate through the pipeline:
   * pre-measure -> transformer check -> PUT run -> oracles -> categorization -> measure feedback
   *
   * @param candidate the transformed input and source
   * @param genTime time taken to generate the input
   * @param generator the composite input generator
   * @param getEffectiveCancelFn cancellation check function
   * @returns FuzzExecutionOutput or undefined if interrupted
   */
  public async execute(
    candidate: TransformedInputAndSource,
    genTime: number,
    generator: CompositeInputGenerator,
    getEffectiveCancelFn?: () => (() => boolean) | undefined
  ): Promise<FuzzExecutionOutput | undefined> {
    const result: FuzzTestResult = this._createInitialResult(
      candidate,
      genTime
    );
    let valTime = 0;
    let measureTime = 0;

    // 1. Prepare measures before test execution
    const startMeasTime = performance.now();
    this._measures.forEach((m) => {
      m.onBeforeNextTestExecution();
    });
    measureTime += performance.now() - startMeasTime;

    // 2. Handle transformer result if candidate was skipped/errored by transformer
    if (candidate.transformerResult && this._transformRunner) {
      this._handleTransformerResult(candidate.transformerResult, result);
    }

    // 3. Call the PUT via its runner if not skipped and no harness errors
    if (!result.skipped && result.harnessErrors.length === 0) {
      const startRunTime = performance.now();
      let exeOutput: RunnerResult;
      try {
        const cancelCheck = getEffectiveCancelFn
          ? getEffectiveCancelFn()
          : undefined;
        exeOutput = await this._runner.runWithInterrupt(
          () =>
            this._runner.run(
              result.input.map((e) => e.value),
              Math.max(this._options.fnTimeout, 0)
            ),
          this._getRemainingSuiteTime(),
          cancelCheck
        );
      } catch (e: unknown) {
        if (isError(e) && e.message === "runnerInterrupted") {
          return undefined;
        }

        if (isError(e)) {
          exeOutput = {
            result: {
              tag: "error",
              name: e.name,
              message: e.message,
              stack: e.stack ?? "<no stack>",
              seq: -1,
            },
            env: {},
          };
        } else {
          exeOutput = {
            result: {
              tag: "error",
              name: "unknown internal runner error",
              message: "unknown",
              stack: "<no stack>",
              seq: -1,
            },
            env: {},
          };
        }
      }
      result.timers.run = performance.now() - startRunTime;

      this._applyRunnerOutput(exeOutput, result);

      // 4. Evaluate oracles
      if (!result.skipped) {
        const startValTime = performance.now();
        const oracleSuccess = await this._evaluateOracles(
          result,
          getEffectiveCancelFn
        );
        if (!oracleSuccess) {
          return undefined; // interrupted
        }
        valTime += performance.now() - startValTime;
      }
    }

    // 5. Categorize the composite result
    result.category = categorizeResult(result);

    // 6. Take measurements & feed back to generator
    const startMeasureFeedbackTime = performance.now();
    const measurements = this._measures.map((e) =>
      e.measure(result.inputGenerated, result)
    );

    result.interestingReasons = generator.onInputFeedback(
      measurements,
      result.timers.run + result.timers.gen
    );
    measureTime += performance.now() - startMeasureFeedbackTime;

    return {
      result,
      valTime,
      measureTime,
    };
  }

  /**
   * Creates the initial fuzz test result object based on the generated input and its associated metadata.
   *
   * @param candidate The transformed input and source information for the test case.
   * @param genTime The time taken to generate the input.
   * @returns The initial fuzz test result object.
   */
  protected _createInitialResult(
    candidate: TransformedInputAndSource,
    genTime: number
  ): FuzzTestResult {
    const argDefs = this._function.getArgDefs();

    const result: FuzzTestResult = {
      pinned: false,
      inputGenerated: candidate,
      input: candidate.value.map((e, i) => {
        return {
          name: argDefs[i]?.getName() ?? "?",
          offset: i,
          value: e.value,
          origin: candidate.source,
        };
      }),
      output: [],
      exception: false,
      harnessErrors: [],
      timeout: false,
      skipped: false,
      passedImplicit: "unknown",
      passedHuman: "unknown",
      passedValidator: "unknown",
      passedValidators: [],
      timers: {
        run: 0,
        gen: genTime,
        transform: 0,
      },
      category: "ok",
      interestingReasons: [],
    };

    if (candidate.injected) {
      const pinnedTest = this._injectMap.get(getIoKey(result.input));
      if (pinnedTest) {
        result.pinned = Boolean(pinnedTest.pinned);
        if (pinnedTest.expectedOutput) {
          result.expectedOutput = pinnedTest.expectedOutput;
        }
      }
    }

    return result;
  } // fn: _createInitialResult

  /**
   * Handles the result of a transformer applied to the input, updating the fuzz test result accordingly.
   *
   * @param transformerResult The result produced by the transformer.
   * @param result The current fuzz test result object to be updated.
   */
  protected _handleTransformerResult(
    transformerResult: NonNullable<
      TransformedInputAndSource["transformerResult"]
    >,
    result: FuzzTestResult
  ): void {
    const fnName = this._transformRunner?.name ?? "transformer";
    switch (transformerResult.result.tag) {
      case "skip":
        result.skipped = true;
        result.skipReason = `(${fnName}) ${transformerResult.result.message}`;
        break;

      case "timeout":
        result.harnessErrors.push({
          kind: "timeout",
          stage: "transformer",
          fnName,
          message: `Timeout exceeding ${this._options.fnTimeout} ms`,
          display: `(${fnName} timeout)`,
        });
        break;

      case "error":
        result.harnessErrors.push({
          kind: "exception",
          stage: "transformer",
          fnName,
          message: transformerResult.result.message,
          display: `(${fnName} ${transformerResult.result.name}) ${transformerResult.result.message}`,
          stack: transformerResult.result.stack ?? "<no stack>",
        });
        break;

      case "value":
        break;
    }
  } // fn: _handleTransformerResult

  /**
   * Applies the output from the runner to the fuzz test result, updating its state accordingly.
   *
   * @param exeOutput The output produced by the runner.
   * @param result The current fuzz test result object to be updated.
   */
  protected _applyRunnerOutput(
    exeOutput: RunnerResult,
    result: FuzzTestResult
  ): void {
    switch (exeOutput.result.tag) {
      case "value":
        result.output.push({
          name: "0",
          offset: 0,
          value: isArgValueType(exeOutput.result.value)
            ? exeOutput.result.value
            : undefined,
          origin: { type: "put" },
        });
        break;
      case "error":
        result.exception = true;
        result.exceptionMessage = exeOutput.result.message;
        result.exceptionDisplay = `(${exeOutput.result.name}) ${exeOutput.result.message}`;
        result.stack = exeOutput.result.stack;
        break;
      case "timeout":
        result.timeout = true;
        break;
      case "skip":
        result.skipped = true;
        result.skipReason = exeOutput.result.message;
        break;
    }
  } // fn: _applyRunnerOutput

  /**
   * Evaluates the results of the fuzz test against the configured oracles (implicit, human, and property).
   *
   * @param result The current fuzz test result object to be evaluated.
   * @param getEffectiveCancelFn Optional function to retrieve the effective cancel function for the evaluation.
   * @returns A promise that resolves to a boolean indicating whether the evaluation was completed successfully.
   */
  protected async _evaluateOracles(
    result: FuzzTestResult,
    getEffectiveCancelFn?: () => (() => boolean) | undefined
  ): Promise<boolean> {
    // IMPLICIT ORACLE
    if (this._options.useImplicit) {
      result.passedImplicit = ImplicitOracle.judge(
        result.timeout,
        result.exception,
        this._function.isVoid(),
        result.output
      );
    }

    // EXAMPLE ORACLE
    if (this._options.useHuman && result.expectedOutput) {
      result.passedHuman = ExampleOracle.judge(
        result.timeout,
        result.exception,
        result.expectedOutput,
        result.output
      );
    }

    // PROPERTY ORACLE
    if (this._options.useProperty && this._propRunners.length > 0) {
      let validatorJudgments: (Judgment | Error)[];
      try {
        const cancelCheck = getEffectiveCancelFn
          ? getEffectiveCancelFn()
          : undefined;
        validatorJudgments = await this._propertyOracle.judge(
          Object.freeze({
            in: result.input.map((i) => i.value),
            out:
              result.output.length === 0
                ? "timeout or exception"
                : result.output[0].value,
            exception: result.exception,
            timeout: result.timeout,
          }),
          Math.max(this._options.fnTimeout, 0),
          this._getRemainingSuiteTime(),
          cancelCheck
        );
      } catch (e: unknown) {
        if (isError(e) && e.message === "runnerInterrupted") {
          return false;
        }
        throw e;
      }

      validatorJudgments.forEach((j, i) => {
        if (isError(j)) {
          result.passedValidators.push("unknown");
          const fnName = this._validators[i].name;
          if (j.name === "PropertyValidatorTimeout") {
            result.harnessErrors.push({
              kind: "timeout",
              stage: "validator",
              fnName,
              message: `Timeout exceeding ${this._options.fnTimeout} ms`,
              display: `(${fnName} timeout)`,
            });
          } else {
            result.harnessErrors.push({
              kind: "exception",
              stage: "validator",
              fnName,
              message: j.message,
              display: `(${fnName} ${j.name}) ${j.message}`,
              stack: j.stack ?? "<no stack>",
            });
          }
        } else {
          result.passedValidators.push(j);
        }
      });

      result.passedValidator = PropertyOracle.summarize(
        result.passedValidators
      );
    }

    return true;
  } // fn: _evaluateOracles

  /**
   * Stops all runners and performs any necessary cleanup at the end of the fuzzing run.
   *
   * @returns A promise that resolves once all runners have been stopped.
   */
  public async stop(): Promise<void> {
    await Promise.all(this.runners.map((r) => r.onRunEnd()));
  } // fn: stop
}
