import { FuzzIoElement } from "fuzzer/Types";
import { Judgment } from "./Types";

/**
 * The implicit oracle only passes when:
 *  - the value contains no nulls, undefineds, NaNs, or Infinity values
 *  - the function did not throw an exception or timeout
 *  - if a void return function, output is `undefined`
 */
export class ImplicitOracle {
  public static judge(
    timeout: boolean,
    exception: boolean,
    isVoidFn: boolean,
    outputValue: FuzzIoElement[]
  ): Judgment {
    if (exception || timeout) {
      // Exceptions and timeouts fail the implicit oracle
      return "fail";
    } else if (isVoidFn) {
      // Functions with a void return type should only return undefined
      return outputValue.some((e) => e.value !== undefined) ? "fail" : "pass";
    } else {
      // Non-void functions should not output disallowed values
      return outputValue.some((e) => !implicitOracle(e.value))
        ? "fail"
        : "pass";
    }
  } // fn: judge
} // class: ImplicitOracle

/**
 * Judges a value. Fails undefined, null, Infinity, -Infinity.
 *
 * Note: We define this function this particular way because
 * JestAdapter .toStrings the function for inclusion in unit tests.
 *
 * @param `x` value to judge
 * @returns `true` if passed; `false` if failed.
 */
export const implicitOracle: (x: unknown) => boolean = (x) => {
  if (Array.isArray(x)) return !x.flat().some((e) => !implicitOracle(e));
  if (typeof x === "number")
    return !(isNaN(x) || x === Infinity || x === -Infinity);
  else if (x === null || x === undefined) return false;
  else if (typeof x === "object")
    return !Object.values(x).some((e) => !implicitOracle(e));
  else return true;
}; // fn: implicitOracle
