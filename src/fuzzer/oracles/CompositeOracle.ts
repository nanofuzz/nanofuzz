/**
 * An implementation of the Composite Oracle described in:
 *
 * TerzoN: Human-in-the-Loop Software Testing with a Composite Oracle
 * https://doi.org/10.1145/3580446
 *
 * The Composite Oracle produces a single judgment from a hierarchy of
 * various judgements by various oracles.
 */
export class CompositeOracle {
  public static judge(jh: JudgmentHierarchy): Judgment {
    for (const h of jh) {
      let fails = false;
      let passes = false;
      for (const j of h) {
        if (j === "pass") {
          passes = true;
        } else if (j === "fail") {
          fails = true;
        }
      }
      if (fails && passes) {
        return "unknown"; // disagree
      } else if (fails && !passes) {
        return "fail";
      } else if (!fails && passes) {
        return "pass";
      } else if (!fails && !passes) {
        // descend to next level of the hierarchy
      }
    }
    return "pass"; // default case: no contrary judgments
  }
}

export type Judgment = "fail" /* -1 */ | "unknown" /* 0 */ | "pass" /* 1 */;

export type JudgmentHierarchy = Judgment[][];
