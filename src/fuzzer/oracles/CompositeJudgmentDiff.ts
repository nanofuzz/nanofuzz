import * as JSON5 from "json5";
import { Judgment, Result } from "../Types";
import { CompositeOracle } from "./CompositeOracle";
import { PropertyOracle } from "./PropertyOracle";
import { AbstractRunner } from "../runners/AbstractRunner";
import { isError } from "../../Util";

/**
 * Generates diffs that show how adding particular property
 * assertions to the test suite would change the test suite's
 * judgments.
 *
 *
 */
export class CompositeJudgmentDiff {
  protected _runId: string;
  protected _examples: readonly JudgedExample[];
  protected _props = new Map<
    string, // name
    true // placeholder
  >();

  constructor(
    runId: string,
    examples: JudgedExample[],
    props: { name: string; runner: AbstractRunner }[] = []
  ) {
    this._runId = runId;
    for (const e of examples) {
      if (e.source.runId !== runId) {
        throw new Error(
          `Not all examples are from run ${runId}. E.g., ${JSON5.stringify(e, null, 2)}`
        );
      }
    }
    this._examples = Object.freeze(examples);
    for (const p of props) {
      this._addProperty(p.name, p.runner);
    }
  }

  /**
   * Adds a prospective property assertion by calculating its judgements
   * for the given set of example executions.
   *
   * @param `name` name of the property to add
   * @param `runner` runner for the property
   */
  protected _addProperty(name: string, runner: AbstractRunner): void {
    if (this._props.has(name)) {
      throw new Error(`Property was previously added: ${name}`);
    }
    console.debug(`Running judgments for property: ${name}`); // !!!!!!!!!!

    // Evaluate the property across the set of examples
    const propOracle = new PropertyOracle([runner]);
    for (const e of this._examples) {
      e.addlJudgments[name] = propOracle.judge(e.example)[0];
    }

    this._props.set(name, true);
    console.debug(`Done w/judgments for property: ${name}`); // !!!!!!!!!!
  } // fn: _addProperty

  /**
   * Calculates how adding the given subset of property assertions to the
   * test suite would change its judgments for specific examples.
   *
   * @param `props` a subset of the property judgments previously provided.
   * @returns a detailed `JudgmentDiff` showing how adding the properties
   * would affect the specific judgements of the test suite for the previously-
   * given set of execution examples.
   */
  public diffFor(props: string[]): JudgmentDiff {
    for (const name of props) {
      if (!this._props.has(name)) {
        throw new Error(`Unknown property: ${name}`);
      }
    }

    const counters: JudgmentDiff["detail"] = {
      exceptions: [],
      falseFailures: [],
      falsePasses: [],
      trueFailures: [],
      truePasses: [],
      prospectiveFailures: [],
    };

    // Re-determine the test suite's judgement for each execution
    // example as if the prospective properties were already accepted
    // into the test suite. Compare this judgment with the original
    // judgment of the test suite according to the groupings below.
    for (const e of this._examples) {
      const oldJudgment = e.judgments.composite; // !!!!!!!!!! how are we handling exceptions here?
      let exceptions = false;
      const newJudgment = CompositeOracle.judge([
        [
          PropertyOracle.summarize([
            ...e.judgments.propertyDetail,
            ...props.map((p) => {
              const j = e.addlJudgments[p];
              if (isError(j)) {
                exceptions = true;
              }
              return isError(j) ? "unknown" : j;
            }),
          ]),
          e.judgments.example,
        ],
        [e.judgments.implicit],
      ]);
      const rejudgment = { ...e, rejudgment: newJudgment };
      /**
       * Exceptions.
       */
      if (exceptions) {
        counters.exceptions.push(rejudgment);
      } else if (
        /**
         * False Pass. A test execution where the existing test suite fails the test execution,
         * but the same test execution no longer fails when the candidate assertion is added to
         * the test suite.
         */
        oldJudgment === "fail" &&
        newJudgment !== "fail"
      ) {
        counters.falsePasses.push(rejudgment);
      } else if (
        /**
         * False Failure. A test execution where the expected output is known, and the existing
         * test suite passes the test execution, but the test execution no longer passes when the
         * candidate assertion is added to the existing test suite.
         */
        e.judgments.example !== "unknown" &&
        oldJudgment === "pass" &&
        newJudgment !== "pass"
      ) {
        counters.falseFailures.push(rejudgment);
      } else if (
        /**
         * True Pass. A test execution where the expected output is known, and the test execution
         * passes before and after adding the candidate test assertion to the existing test suite.
         */
        e.judgments.example !== "unknown" &&
        oldJudgment === "pass" &&
        newJudgment === "pass"
      ) {
        counters.truePasses.push(rejudgment);
      } else if (
        /**
         * True Failure. A test execution where the expected output is known, and the test
         * execution fails before and after adding the candidate test assertion to the existing
         * test suite.
         */
        e.judgments.example !== "unknown" &&
        oldJudgment === "fail" &&
        newJudgment === "fail"
      ) {
        counters.trueFailures.push(rejudgment);
      } else if (
        /**
         * Prospective Failure. The same as a false failure, except that the expected output
         * is unknown.
         */
        e.judgments.example === "unknown" &&
        oldJudgment === "pass" &&
        newJudgment !== "pass"
      ) {
        counters.prospectiveFailures.push(rejudgment);
      }
    }

    return {
      runId: this._runId,
      priority: CompositeJudgmentDiff.prioritize(counters),
      detail: counters,
      summary: CompositeJudgmentDiff.summarize(counters),
    };
  } // fn: statsFor

  /**
   * Returns a "five squares diff" summarizing how a new assertions affects
   * the judgments of the existing test suite. Each square represents ~1/5th
   * of changed test suite judgments.
   *
   * Green indicates prospective failures---possible bugs not previously detected.
   * Red indicates false failues and false passes---contradicting the test suite.
   * Gray indicates neutral, such as when no judgements changed.
   *
   * @param `diff` the JudgmentDiff to summarize
   * @returns a five squares diff showing the impact of the prospective judgements
   */
  protected static summarize(
    diff: JudgmentDiff["detail"]
  ): JudgmentDiffSummary {
    const greens = diff.prospectiveFailures.length;
    const reds = diff.falseFailures.length + diff.falsePasses.length;
    const total = greens + reds;

    const squareThresh = total / 5;
    let greenSquares = total ? Math.floor(greens / squareThresh) : 0;
    let redSquares = total ? Math.floor(reds / squareThresh) : 0;
    if (greenSquares === 0 && redSquares < 5 && greens > 0) {
      greenSquares = 1;
    }
    if (redSquares === 0 && greenSquares < 5 && reds > 0) {
      redSquares = 1;
    }
    const graySquares = 5 - greenSquares - redSquares;

    const squares: ColorSquare[] = [];
    if (greenSquares) {
      squares.push(...new Array(greenSquares).fill("green"));
    }
    if (redSquares) {
      squares.push(...new Array(redSquares).fill("red"));
    }
    if (graySquares) {
      squares.push(...new Array(graySquares).fill("gray"));
    }

    return {
      greens,
      reds,
      squares,
    };
  } // fn: summarize

  /**
   * Assertion Priority is a numeric value where higher numbers are given to
   * groups of candidate property assertions that have higher agreement with
   * the existing test suite (true passes and true failures), prospectively
   * detect more failures that are neither detected by nor contradicted by the
   * existing test suite (prospective failures), and that do not contradict
   * the human-verified judgments of the existing test suite (no false
   * failures and no false passes).
   *
   * Higher numbers are better.
   *
   * @param `diff` Composite Judgment Diff to prioritize
   */
  protected static prioritize(diff: JudgmentDiff["detail"]): number {
    const negativeAspects = diff.falseFailures.length + diff.falsePasses.length;
    const neutralAspects = diff.trueFailures.length + diff.truePasses.length;
    const positiveAspects = diff.prospectiveFailures.length;

    const total = negativeAspects + neutralAspects + positiveAspects;
    const factor = 100 / total;

    if (negativeAspects) {
      return (
        ((negativeAspects / factor) * (neutralAspects / factor) * -1) / factor
      );
    } else {
      return (positiveAspects / factor) * (neutralAspects / factor);
    }
  } // fn: prioritize
} // class: CompositeJudgmentDiff

export type JudgedExample = {
  example: Result;
  source: {
    runId: string;
    testId: number;
  };
  judgments: {
    composite: Judgment;
    example: Judgment;
    implicit: Judgment;
    property: Judgment;
    propertyDetail: Judgment[];
  };
  addlJudgments: { [k: string]: Judgment | Error };
};

export type RejudgedExample = JudgedExample & { rejudgment: Judgment };

export type JudgmentDiff = {
  runId: string;
  priority: number;
  summary: JudgmentDiffSummary;
  detail: {
    exceptions: RejudgedExample[];
    falsePasses: RejudgedExample[];
    falseFailures: RejudgedExample[];
    truePasses: RejudgedExample[];
    trueFailures: RejudgedExample[];
    prospectiveFailures: RejudgedExample[];
  };
};

export type JudgmentDiffSummary = {
  greens: number;
  reds: number;
  squares: ColorSquare[]; // five elements
};
export type ColorSquare = "red" | "green" | "gray";
