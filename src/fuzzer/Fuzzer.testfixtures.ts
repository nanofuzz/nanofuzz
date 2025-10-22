import { testCoverageMultiFile2 } from "./Fuzzer.textfixturees2";

/**
 * Fuzz target that alters its input - used to verify
 * that recorded fuzzer input is not altered by the target
 */
export function testChangeInput(obj: { a: number }) {
  (obj as any).b = 1;
}

/**
 * Fuzz targets with return type `void` that returns undefined
 */
export function testStandardVoidReturnUndefined(x: number): void {
  const y = x - 1;
}
export const testArrowVoidReturnUndefined = (x: number): void => {
  const y = x - 1;
};

/**
 * Fuzz targets with return type `void` that returns number
 */
export function testStandardVoidReturnNumber(x: number): void {
  if (x % 2) {
    x;
  }
  if (x % 3) {
    x;
  }
  if (x % 5) {
    x;
  }
  const y: unknown = x;
  return y as void;
}
export const testArrowVoidReturnNumber = (x: number): void => {
  const y: unknown = x;
  return y as void;
};

/**
 * Fuzz targets with return type `void` that throw an exception
 */
export function testStandardVoidReturnException(x: number): void {
  throw new Error("Random error");
}
export const testArrowVoidReturnException = (x: number): void => {
  throw new Error("Random error");
};

/**
 * Fuzz targets with literal arguments
 */
export function testStandardVoidLiteralArgs(n: 5, n2: 5[]): void {
  return;
}
export const testArrowVoidLiteralArgs = (n: 5, n2: 5[]): void => {
  return;
};

/**
 * Fuzz targets with union arguments
 */
type hellos = "hello" | "bonjour" | "olá" | "ciao" | "hej";
type stringOrNumber = string | number;
type maybeBool = boolean | undefined;
export function testStandardUnionArgs(
  a: stringOrNumber,
  b: maybeBool[]
): boolean | undefined {
  return;
}
export const testArrowUnionArgs = (
  a: stringOrNumber,
  b: maybeBool[]
): boolean | undefined => {
  return;
};
export function testBoolean(a?: boolean): boolean {
  return true;
}

/**
 * Tests coverage guidance. Adapted from lecture:
 * https://swen90006.github.io/Coverage-Guided-Fuzzing.html
 *
 * @param s is a string of length 4 of 256 1-byte characters
 * @returns `true` if `s` begins with 'z '
 *          `true` if `s` in {"bug!" ,"moth"}
 *          `false` otherwise
 **/
export function testCoverageOneFile(s: string): boolean {
  if (s.length !== 4) return false;
  if (s[0] === "z") return true;
  let count: number = 0;
  if (s[0] === "b") count++;
  if (s[1] === "u") count++;
  if (s[2] === "g") count++;
  if (s[3] === "s") count++;
  if (count > 3) return true;
  if (s === "moths") return true;
  return false;
}
export function testCoverageOneFileValidator(
  r: FuzzTestResult
): boolean | undefined {
  const s: string = r.in[0]; // the PUT's input
  const out: boolean = r.out; // the PUT's output

  if (s[0] === "z" || s === "bug!" || s === "moth") {
    if (!out) console.debug(` - Property test failed input: ${s}`);
    return !!out; // expected : out === true
  } else {
    if (!!out) console.debug(` - Property test failed input: ${s}`);
    return !out; // expected : out === false
  }
}

/**
 * Function for testing code coverage across two source files.
 *
 * @param `str` input string of length 3 characters A-Z,a-z
 * @returns `true` if `str`===`NaN`, `false` otherwise
 */
export function testCoverageMultiFile(str: string): boolean {
  return testCoverageMultiFile2(str);
}

export type FuzzTestResult = {
  in: any[];
  out: any;
  exception: boolean;
  timeout: boolean;
};
