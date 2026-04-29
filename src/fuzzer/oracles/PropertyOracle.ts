import { Judgment } from "./Types";

export class PropertyOracle {
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
  }
}
