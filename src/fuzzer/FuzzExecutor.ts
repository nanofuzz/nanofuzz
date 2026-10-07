import { FunctionDef } from "./analysis/FunctionDef";
import { FunctionRef } from "./analysis/Types";
import { isArgValueType } from "./analysis/Util";
import { CompositeInputGenerator } from "./generators/CompositeInputGenerator";
import { AbstractMeasure } from "./measures/AbstractMeasure";
import { AbstractCoverageMeasure } from "./measures/AbstractCoverageMeasure";
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
import { categorizeResult, getIoKey, isError } from "./Util";

/**
 * Encapsulates the execution runners for an isolated worker pipeline.
 */
export interface FuzzWorkerContext {
  id: number;
  runner: AbstractRunner;
  propRunners: AbstractRunner[];
  propertyOracle?: PropertyOracle;
}

/**
 * Output from executing a single test on a worker.
 */
export interface FuzzExecutionOutput {
  result: FuzzTestResult;
  exeOutput?: RunnerResult;
  valTime: number;
  runTime: number;
}

/**
 * FuzzExecutor manages the single-test and multi-worker execution pipeline:
 * target execution, transformer handling, oracle judgments,
 * measurements, and feedback to the input generator.
 */
export class FuzzExecutor {
  protected _workers: FuzzWorkerContext[];
  protected _transformRunner?: AbstractRunner;
  protected _userGenRunner?: AbstractRunner;
  protected _measures: AbstractMeasure[];
  protected _options: FuzzOptions;
  protected _function: FunctionDef;
  protected _validators: FunctionRef[];
  protected _injectMap: Map<string, FuzzPinnedTest>;
  protected _getRemainingSuiteTime: () => number;

  public constructor(
    workers: FuzzWorkerContext[],
    transformRunner: AbstractRunner | undefined,
    userGenRunner: AbstractRunner | undefined,
    measures: AbstractMeasure[],
    options: FuzzOptions,
    functionDef: FunctionDef,
    validators: FunctionRef[],
    injectMap: Map<string, FuzzPinnedTest>,
    getRemainingSuiteTime: () => number
  ) {
    this._workers = workers;
    this._transformRunner = transformRunner;
    this._userGenRunner = userGenRunner;
    this._measures = measures;
    this._options = options;
    this._function = functionDef;
    this._validators = validators;
    this._injectMap = injectMap;
    this._getRemainingSuiteTime = getRemainingSuiteTime;
  } // constructor

  /**
   * Retrieves the list of worker contexts.
   */
  public get workers(): readonly FuzzWorkerContext[] {
    return this._workers;
  } // get: workers

  /**
   * Retrieves the centralized transformer runner, if configured.
   */
  public get transformRunner(): AbstractRunner | undefined {
    return this._transformRunner;
  } // get: transformRunner

  /**
   * Retrieves the centralized user generator runner, if configured.
   */
  public get userGenRunner(): AbstractRunner | undefined {
    return this._userGenRunner;
  } // get: userGenRunner

  /**
   * Retrieves the list of all runners involved in the fuzzing execution pipeline.
   *
   * @returns An array of all active runners.
   */
  public get runners(): AbstractRunner[] {
    return [
      ...this._workers.flatMap((w) => [w.runner, ...w.propRunners]),
      this._transformRunner,
      this._userGenRunner,
    ].filter((r): r is AbstractRunner => r !== undefined);
  } // get: runners

  /**
   * Starts all active runner processes in parallel.
   */
  public async onRunStart(): Promise<void> {
    await Promise.all(this.runners.map((r) => r.onRunStart()));
  } // fn: onRunStart

  /**
   * Stops all active runner processes in parallel.
   */
  public async stop(): Promise<void> {
    await Promise.all(this.runners.map((r) => r.onRunEnd()));
  } // fn: stop

  /**
   * Prepares measures before input generation / transformation begins.
   *
   * @returns elapsed preparation time in ms
   */
  public prepareMeasures(): number {
    const startMeasTime = performance.now();
    this._measures.forEach((m) => {
      m.onBeforeNextTestExecution();
    });
    return performance.now() - startMeasTime;
  } // fn: prepareMeasures

  /**
   * Executes a single test input candidate on a specific worker:
   * transformer check -> PUT run on worker runner -> oracle evaluation on worker.
   *
   * @param candidate the transformed input and source
   * @param worker the worker context executing this test
   * @param genTime time taken to generate the input
   * @param transformTime time spent transforming the input
   * @param cancelFn cancellation check function
   * @returns FuzzExecutionOutput or undefined if interrupted
   */
  public async runTestOnWorker(
    candidate: TransformedInputAndSource,
    worker: FuzzWorkerContext,
    genTime: number = 0,
    transformTime: number = 0,
    cancelFn?: () => boolean
  ): Promise<FuzzExecutionOutput | undefined> {
    const result: FuzzTestResult = this._createInitialResult(
      candidate,
      genTime,
      transformTime
    );

    // 1. Handle transformer result if candidate was skipped/errored by transformer
    if (candidate.transformerResult && this._transformRunner) {
      this._handleTransformerResult(
        candidate.transformerResult,
        result,
        this._transformRunner.name
      );
    }

    if (result.skipped || result.harnessErrors.length > 0) {
      return { result, valTime: 0, runTime: 0 };
    }

    // 2. Call the PUT via the worker runner
    const startRunTime = performance.now();
    let exeOutput: RunnerResult;
    try {
      const cancelCheck =
        cancelFn && !candidate.injected ? cancelFn : undefined;
      exeOutput = await worker.runner.runWithInterrupt(
        () =>
          worker.runner.run(
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
    const runTime = result.timers.run;

    this._applyRunnerOutput(exeOutput, result);

    // 3. Evaluate oracles
    let valTime = 0;
    if (!result.skipped) {
      const startValTime = performance.now();
      const cancelCheck =
        cancelFn && !candidate.injected ? cancelFn : undefined;
      const oracleSuccess = await this._evaluateOracles(
        result,
        worker.propertyOracle,
        worker.propRunners,
        cancelCheck
      );
      if (!oracleSuccess) {
        return undefined; // interrupted
      }
      valTime = performance.now() - startValTime;
    }

    return {
      result,
      exeOutput,
      valTime,
      runTime,
    };
  } // fn: runTestOnWorker

  /**
   * Synchronously categorizes the result, records coverage hits, and provides feedback to generator.
   *
   * @param result the fuzz test result
   * @param candidate the transformed input candidate
   * @param activeRunners runners whose coverage should be ingested
   * @param generator the composite input generator
   * @returns measurement timing information
   */
  public recordTestFeedback(
    result: FuzzTestResult,
    candidate: TransformedInputAndSource,
    activeRunners: AbstractRunner[],
    generator: CompositeInputGenerator
  ): { measureTime: number } {
    result.category = categorizeResult(result);

    this.prepareMeasures();
    for (const r of activeRunners) {
      if (r.lastRunCoverage) {
        this._measures.forEach((m) => {
          if (m instanceof AbstractCoverageMeasure) {
            m.recordHits(r.lastRunCoverage);
          }
        });
      }
    }

    const startMeasureFeedbackTime = performance.now();
    const measurements = this._measures.map((e) =>
      e.measure(candidate, result)
    );

    result.interestingReasons = generator.onInputFeedback(
      measurements,
      result.timers.run + result.timers.gen,
      candidate
    );
    const measureTime = performance.now() - startMeasureFeedbackTime;
    return { measureTime };
  } // fn: recordTestFeedback

  /**
   * Executes a single test input candidate through the pipeline sequentially on worker 0.
   * (Maintains synchronous compatibility for FuzzerV2).
   *
   * @param candidate the transformed input and source
   * @param genTime time taken to generate the input
   * @param generator the composite input generator
   * @param getEffectiveCancelFn cancellation check function
   * @param initMeasTime time spent preparing measures before generation
   * @returns FuzzExecutionOutput or undefined if interrupted
   */
  public async execute(
    candidate: TransformedInputAndSource,
    genTime: number,
    generator: CompositeInputGenerator,
    getEffectiveCancelFn?: () => (() => boolean) | undefined,
    initMeasTime: number = 0
  ): Promise<
    { result: FuzzTestResult; valTime: number; measureTime: number } | undefined
  > {
    const worker0 = this._workers[0];
    const cancelFn = getEffectiveCancelFn ? getEffectiveCancelFn() : undefined;
    const exec = await this.runTestOnWorker(
      candidate,
      worker0,
      genTime,
      0,
      cancelFn
    );
    if (!exec) {
      return undefined;
    }

    const runnersToRecord: AbstractRunner[] = [
      worker0.runner,
      ...worker0.propRunners,
    ];
    if (this._transformRunner && candidate.source.type === "transformer") {
      runnersToRecord.push(this._transformRunner);
    }
    if (
      this._userGenRunner &&
      candidate.source.type === "generator" &&
      candidate.source.generator === "UserInputGenerator"
    ) {
      runnersToRecord.push(this._userGenRunner);
    }

    const { measureTime } = this.recordTestFeedback(
      exec.result,
      candidate,
      runnersToRecord,
      generator
    );

    return {
      result: exec.result,
      valTime: exec.valTime,
      measureTime: measureTime + initMeasTime,
    };
  } // fn: execute

  /**
   * Creates the initial fuzz test result object based on the generated input and its associated metadata.
   *
   * @param candidate The transformed input and source information for the test case.
   * @param genTime The time taken to generate the input.
   * @param transformTime Time taken for input transformation.
   * @returns The initial fuzz test result object.
   */
  protected _createInitialResult(
    candidate: TransformedInputAndSource,
    genTime: number,
    transformTime: number = 0
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
        transform: transformTime,
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
   * @param transformerName The name of the transformer function.
   */
  protected _handleTransformerResult(
    transformerResult: NonNullable<
      TransformedInputAndSource["transformerResult"]
    >,
    result: FuzzTestResult,
    transformerName: string = "transformer"
  ): void {
    const fnName = transformerName;
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
   * @param propertyOracle Property oracle to evaluate.
   * @param propRunners Property validator runners.
   * @param cancelCheck Optional cancellation check function.
   * @returns A promise that resolves to a boolean indicating whether evaluation completed without interruption.
   */
  protected async _evaluateOracles(
    result: FuzzTestResult,
    propertyOracle?: PropertyOracle,
    propRunners: AbstractRunner[] = [],
    cancelCheck?: () => boolean
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
    if (this._options.useProperty && propertyOracle && propRunners.length > 0) {
      let validatorJudgments: (Judgment | Error)[];
      try {
        validatorJudgments = await propertyOracle.judge(
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
          const fnName = this._validators[i]?.name ?? `validator_${i}`;
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
} // class: FuzzExecutor
