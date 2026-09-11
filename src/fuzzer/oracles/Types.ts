export type Judgment = "fail" /* -1 */ | "unknown" /* 0 */ | "pass" /* 1 */;

export type NamedJudgment = {
  judgment: Judgment;
  error?: Error;
  deciders: NamedJudgment[]; // subordinate judgments that decided `judgment`
} & (
  | {
      name: "CompositeOracle";
      trace: NamedJudgment[][]; // all subordinate judgments
    }
  | {
      name: string;
      trace: NamedJudgment[]; // all subordinate judgments
    }
);

export type NamedJudgmentHierarchy = NamedJudgment[][];
