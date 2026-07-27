import { NamedJudgment } from "./Types";
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
  public judge(result: Result): NamedJudgment[] {
    const jj: NamedJudgment[] = [];
    for (const r of this._propRunners) {
      const j = {
        name: r.name,
        trace: [],
        deciders: [],
      };
      try {
        const validatorOut = r.run([result])[0];
        switch (validatorOut) {
          case true: // v0.3
          case "pass": // v0.4
            jj.push({ ...j, judgment: "pass" });
            break;
          case false: // v0.3
          case "fail": // v0.4
            jj.push({ ...j, judgment: "fail" });
            break;
          case undefined: // v0.3
          case "unknown": // v0.4
            jj.push({ ...j, judgment: "unknown" });
            break;
          default:
            jj.push({
              ...j,
              judgment: "unknown",
              error: {
                name: `InvalidJudgmentException`,
                message: `Property validator did not return: "pass" | "fail" | "unknown"`,
              },
            });
        }
      } catch (e: unknown) {
        jj.push({
          ...j,
          judgment: "unknown",
          error: JSON.parse(
            JSON.stringify(
              isError(e)
                ? {
                    name: e.name,
                    message: e.message,
                    stack: e.stack,
                  }
                : {
                    name: `UnknownException`,
                    message: `Property validator threw exception that is not an Error`,
                    cause: e,
                  }
            )
          ),
        });
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
  public static summarize(judgments: NamedJudgment[]): NamedJudgment {
    const summary: NamedJudgment = {
      name: "PropertyOracle",
      judgment: "unknown",
      trace: [...judgments],
      deciders: [],
    };
    for (const j of judgments) {
      if (j.error) {
        return {
          ...summary,
          error: { ...j.error },
          judgment: "unknown",
          deciders: [j],
        };
      } else if (j.judgment === "pass") {
        summary.judgment = "pass";
        summary.deciders.push(j);
      } else if (j.judgment === "fail") {
        return { ...summary, judgment: "fail", deciders: [j] };
      }
    }
    return summary;
  } // fn: summarize

  /**
   * Getter for default unknown judgment
   */
  public static get unknown(): NamedJudgment {
    return {
      name: "PropertyOracle",
      judgment: "unknown",
      trace: [],
      deciders: [],
    };
  } // property: get unknown
} // class: PropertyOracle
