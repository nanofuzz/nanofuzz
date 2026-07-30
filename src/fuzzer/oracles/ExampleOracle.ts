import { FuzzIoElement } from "../Types";
import { Judgment } from "./Types";
import * as JSONN from "../../Jsonn";

export class ExampleOracle {
  public static judge(
    timeout: boolean,
    exception: boolean,
    expectedOutput: FuzzIoElement[],
    outputValue: FuzzIoElement[]
  ): Judgment {
    if (timeout) {
      return expectedOutput.length > 0 && expectedOutput[0].isTimeout === true
        ? "pass"
        : "fail";
    } else if (exception) {
      return expectedOutput.length > 0 && expectedOutput[0].isException === true
        ? "pass"
        : "fail";
    } else {
      // If we expected a timeout or exception and did not receive one, fail
      if (
        expectedOutput.length > 0 &&
        (expectedOutput[0].isException === true ||
          expectedOutput[0].isTimeout === true)
      ) {
        return "fail";
      }

      // Compare expected to actual values.
      return JSONN.stringify(
        outputValue.map((output) => {
          return { value: output.value };
        })
      ) ===
        JSONN.stringify(
          expectedOutput.map((output) => {
            return { value: output.value };
          })
        )
        ? "pass"
        : "fail";
    }
  } // fn: judge
} // class: ExampleOracle
