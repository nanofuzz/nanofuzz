import { Judgment } from "./Types";
import { Result } from "../Types";
import { isError } from "../../Util";
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
   * @returns one judgment or one exception for each property validator
   */
  public judge(result: Result): (Judgment | Error)[] {
    const jj: (Judgment | Error)[] = [];
    for (const r of this._propRunners) {
      try {
        const validatorOut = r.run([result])[0];
        switch (validatorOut) {
          case true: // v0.3
          case "pass": // v0.4
            jj.push("pass");
            break;
          case false: // v0.3
          case "fail": // v0.4
            jj.push("fail");
            break;
          case undefined: // v0.3
          case "unknown": // v0.4
            jj.push("unknown");
            break;
          default:
            jj.push(
              new Error(
                `Property validator did not return: "pass" | "fail" | "unknown"`
              )
            );
        }
      } catch (e: unknown) {
        jj.push(
          isError(e)
            ? e
            : new Error(
                `Property validator threw exception that is not an Error`,
                { cause: e }
              )
        );
      }
    }
    return jj;
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
