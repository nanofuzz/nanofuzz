import { NamedJudgment, NamedJudgmentHierarchy } from "./Types";

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
  public static judge(jh: NamedJudgmentHierarchy): NamedJudgment {
    const cj: NamedJudgment = {
      name: "CompositeOracle",
      judgment: "unknown",
      trace: jh,
      deciders: [],
    };
    for (const h of jh) {
      const fails: NamedJudgment[] = [];
      const passes: NamedJudgment[] = [];
      for (const j of h) {
        if (j.judgment === "pass") {
          passes.push(j);
        } else if (j.judgment === "fail") {
          fails.push(j);
        }
      }
      if (fails.length && passes.length) {
        return { ...cj, judgment: "unknown", deciders: [...passes, ...fails] }; // disagree
      } else if (fails.length && !passes.length) {
        return { ...cj, judgment: "fail", deciders: fails };
      } else if (!fails.length && passes.length) {
        return { ...cj, judgment: "pass", deciders: passes };
      } else if (!fails.length && !passes.length) {
        // descend to next level of the hierarchy
      }
    }
    return { ...cj, judgment: "pass" }; // default case: no contrary judgments
  } //fn: judge

  /**
   * Getter for default unknown judgment
   */
  public static get unknown(): NamedJudgment {
    return {
      name: "CompositeOracle",
      judgment: "unknown",
      trace: [],
      deciders: [],
    };
  } // property: get unknown
} // class: CompositeOracle
