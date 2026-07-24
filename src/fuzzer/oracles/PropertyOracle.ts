import { Judgment } from "./Types";
import { Result } from "../Types";
import { isError } from "../Util";
import { AbstractRunner } from "../runners/AbstractRunner";

export class PropertyOracle {
  protected _propRunners: AbstractRunner[] = [];

  constructor(propRunners: AbstractRunner[]) {
    this._propRunners = [...propRunners];
  }

  /**
   * Judge an execution result of a program using property validators
   *
   * @param `result` result of executing the program
   * @param `timeout` time in ms before cancelling a property validator
   * @returns one judgment or one exception for each property validator
   */
  public async judge(
    result: Result,
    timeout: number | undefined = 0
  ): Promise<(Judgment | Error)[]> {
    const promises = this._propRunners.map((r) => r.run([result], timeout));
    const results = await Promise.allSettled(promises);
    return results.map((result, runnerId) => {
      const runner = this._propRunners[runnerId];
      if (result.status === "fulfilled") {
        const vOut = result.value;
        switch (vOut.result.tag) {
          case "error":
            return { ...vOut.result };
          case "timeout":
            return {
              name: `PropertyValidatorTimeout`,
              message: `property validator "${runner.name} timed out`,
            };
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
              default:
                return new Error(
                  `Property validator did not return: "pass" | "fail" | "unknown"`
                );
            }
        }
      } else {
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
