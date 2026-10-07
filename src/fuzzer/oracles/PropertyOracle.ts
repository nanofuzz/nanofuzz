import { Judgment } from "./Types";
import { HarnessError, Result } from "../Types";
import { isError } from "../Util";
import { AbstractRunner, ValidatorResult } from "../runners/AbstractRunner";

export class PropertyOracle {
  protected _propRunners: AbstractRunner[] = [];

  constructor(propRunners: AbstractRunner[] = []) {
    this._propRunners = [...propRunners];
  }

  /**
   * Translates in-host validator results into judgments and harness errors.
   *
   * @param validatorResults Map of validator function names to their execution results
   * @param validators List of validator function references expected
   * @param fnTimeout Configured per-function timeout in milliseconds
   * @returns Array of judgments and any harness errors encountered
   */
  public static mapJudgments(
    validatorResults: Record<string, ValidatorResult> = {},
    validators: { name: string }[],
    fnTimeout: number
  ): { judgments: Judgment[]; harnessErrors: HarnessError[] } {
    const judgments: Judgment[] = [];
    const harnessErrors: HarnessError[] = [];

    validators.forEach((vRef, i) => {
      const fnName = vRef.name || `validator_${i}`;
      const vOut = validatorResults[fnName];

      if (!vOut) {
        judgments.push("unknown");
        return;
      }

      switch (vOut.tag) {
        case "value":
          switch (vOut.value) {
            case true:
            case "pass":
              judgments.push("pass");
              break;
            case false:
            case "fail":
              judgments.push("fail");
              break;
            case undefined:
            case "unknown":
              judgments.push("unknown");
              break;
            default: {
              judgments.push("unknown");
              harnessErrors.push({
                kind: "exception",
                stage: "validator",
                fnName,
                message:
                  'Property validator did not return: "pass" | "fail" | "unknown"',
                display: `(${fnName} PropertyValidatorReturnValueError) Property validator did not return: "pass" | "fail" | "unknown"`,
                stack: "<no stack>",
              });
              break;
            }
          }
          break;

        case "timeout":
          judgments.push("unknown");
          harnessErrors.push({
            kind: "timeout",
            stage: "validator",
            fnName,
            message: `Timeout exceeding ${fnTimeout} ms`,
            display: `(${fnName} timeout)`,
          });
          break;

        case "skip":
          judgments.push("unknown");
          harnessErrors.push({
            kind: "exception",
            stage: "validator",
            fnName,
            message:
              vOut.message ??
              `property validator "${fnName}" assumption unsatisfied`,
            display: `(${fnName} UnsatisfiedAssumption) ${
              vOut.message ?? "assumption unsatisfied"
            }`,
            stack: "<no stack>",
          });
          break;

        case "error":
          judgments.push("unknown");
          harnessErrors.push({
            kind: "exception",
            stage: "validator",
            fnName,
            message: vOut.message ?? "Property validator error",
            display: `(${fnName} ${vOut.name ?? "PropertyValidatorError"}) ${
              vOut.message ?? "error"
            }`,
            stack: vOut.stack ?? "<no stack>",
          });
          break;
      }
    });

    return { judgments, harnessErrors };
  } // fn: mapJudgments

  /**
   * Judge an execution result of a program using property validators
   *
   * @param `result` result of executing the program
   * @param `timeout` time in ms before cancelling a property validator
   * @returns one judgment or one exception for each property validator
   */
  public async judge(
    result: Result,
    timeout: number | undefined = 0,
    remainingSuiteTime: number = Infinity,
    cancelFn?: () => boolean
  ): Promise<(Judgment | Error)[]> {
    return (
      await Promise.allSettled(
        this._propRunners.map((r) =>
          r.runWithInterrupt(
            () => r.run([result], timeout),
            remainingSuiteTime,
            cancelFn
          )
        )
      )
    ).map((result, runnerId) => {
      const runner = this._propRunners[runnerId];
      if (result.status === "fulfilled") {
        const vOut = result.value;
        switch (vOut.result.tag) {
          case "error": {
            const err = new Error(
              vOut.result.message ?? "Property validator error"
            );
            err.name = vOut.result.name ?? "PropertyValidatorError";
            if (vOut.result.stack) {
              err.stack = vOut.result.stack;
            }
            return err;
          }
          case "timeout": {
            const err = new Error(
              `property validator "${runner.name}" timed out`
            );
            err.name = "PropertyValidatorTimeout";
            return err;
          }
          case "skip": {
            const err = new Error(
              `property validator "${runner.name}" assumption unsatisfied`
            );
            err.name = "UnsatisfiedAssumption";
            return err;
          }
          case "value":
            switch (vOut.result.value) {
              case true: // v0.3
              case "pass": // v0.4
                return "pass";
              case false: // v0.3
              case "fail": // v0.4
                return "fail";
              case undefined: // v0.3
              case "unknown": // v0.4
                return "unknown";
              default: {
                const err = new Error(
                  `Property validator did not return: "pass" | "fail" | "unknown"`
                );
                err.name = "PropertyValidatorReturnValueError";
                return err;
              }
            }
        }
      } else {
        if (
          isError(result.reason) &&
          result.reason.message === "runnerInterrupted"
        ) {
          throw result.reason;
        }
        return isError(result.reason)
          ? result.reason
          : new Error(
              `Property validator threw exception that is not an Error`,
              { cause: result.reason }
            );
      }
    });
  } // fn: judge

  /**
   * Summarizes a judgment from multiple propert-based judgments.
   *
   * Ignore "unknown" judgements. Return:
   *  --> "pass" if there is at least one "pass" and no "fail"s
   *  --> "fail" if there are any fails
   *  --> "unknown" otherwise
   *
   * @param `judgments` array of individual property-based judgments
   * @returns summarized judgment
   */
  public static summarize(judgments: Judgment[]): Judgment {
    let summary: Judgment = "unknown";
    for (const j of judgments) {
      if (summary === "unknown" && j === "pass") {
        summary = "pass";
      } else if (j === "fail") {
        return "fail";
      }
    }
    return summary;
  } // fn: summarize
}
