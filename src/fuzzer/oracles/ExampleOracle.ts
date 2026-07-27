import { FuzzIoElement } from "../Types";
import { NamedJudgment } from "./Types";
import * as JSON5 from "json5";

export class ExampleOracle {
  public static judge(
    timeout: boolean,
    exception: boolean,
    expectedOutput: FuzzIoElement[],
    outputValue: FuzzIoElement[]
  ): NamedJudgment {
    const j = {
      name: "ExampleOracle",
      trace: [],
      deciders: [],
    };
    if (timeout) {
      return {
        ...j,
        judgment:
          expectedOutput.length > 0 && expectedOutput[0].isTimeout === true
            ? "pass"
            : "fail",
      };
    } else if (exception) {
      return {
        ...j,
        judgment:
          expectedOutput.length > 0 && expectedOutput[0].isException === true
            ? "pass"
            : "fail",
      };
    } else {
      // If we expected a timeout or exception and did not receive one, fail
      if (
        expectedOutput.length > 0 &&
        (expectedOutput[0].isException === true ||
          expectedOutput[0].isTimeout === true)
      ) {
        return { ...j, judgment: "fail" };
      }

      // Compare expected to actual values.
      return {
        ...j,
        judgment:
          JSON5.stringify(
            outputValue.map((output) => ({ value: output.value }))
          ) ===
          JSON5.stringify(
            expectedOutput.map((output) => ({ value: output.value }))
          )
            ? "pass"
            : "fail",
      };
    }
  } // fn: judge

  /**
   * Getter for default unknown judgment
   */
  public static get unknown(): NamedJudgment {
    return {
      name: "ExampleOracle",
      judgment: "unknown",
      trace: [],
      deciders: [],
    };
  } // property: get unknown
} // class: ExampleOracle
