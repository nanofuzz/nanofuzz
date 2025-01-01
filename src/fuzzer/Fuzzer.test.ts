import { ArgDef, setup, fuzz, implicitOracle } from "./Fuzzer";
import { FuzzOptions } from "./Types";

/**
 * Fuzzer option for integer arguments and a seed for deterministic test execution.
 */
const intOptions: FuzzOptions = {
  argDefaults: ArgDef.getDefaultOptions(),
  maxTests: 1000,
  fnTimeout: 100,
  suiteTimeout: 3000,
  seed: "qwertyuiop",
  maxDupeInputs: 1000,
  maxFailures: 0,
  onlyFailures: false,
  useImplicit: true,
  useHuman: true,
  useProperty: false,
};

/**
 * Fuzzer option for float arguments and a seed for deterministic test execution.
 */
const floatOptions: FuzzOptions = {
  ...intOptions,
  argDefaults: ArgDef.getDefaultFloatOptions(),
};

/**
 * Fuzzer options for counter-example mode
 */
const counterExampleOptions: FuzzOptions = {
  ...intOptions,
  maxFailures: 1,
  onlyFailures: true,
};

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
 * These tests currently just ensure that the fuzzer runs and produces output
 * for each example. TODO: Add tests that check the fuzzer output.
 */
describe("Fuzzer", () => {
  test("Implicit Oracle - NaN", () => {
    expect(implicitOracle(NaN)).toBe(false);
  });

  test("Implicit Oracle - +Infinity", () => {
    expect(implicitOracle(Infinity)).toBe(false);
  });

  test("Implicit Oracle - -Infinity", () => {
    expect(implicitOracle(-Infinity)).toBe(false);
  });

  test("Implicit Oracle - null", () => {
    expect(implicitOracle(null)).toBe(false);
  });

  test("Implicit Oracle - undefined", () => {
    expect(implicitOracle(undefined)).toBe(false);
  });

  test("Implicit Oracle - ''", () => {
    expect(implicitOracle("")).toBe(true);
  });

  test("Implicit Oracle - 0", () => {
    expect(implicitOracle(0)).toBe(true);
  });

  test("Implicit Oracle - -1", () => {
    expect(implicitOracle(-1)).toBe(true);
  });

  test("Implicit Oracle - 1", () => {
    expect(implicitOracle(1)).toBe(true);
  });

  test("Implicit Oracle - 'xyz'", () => {
    expect(implicitOracle("xyz")).toBe(true);
  });

  test("Implicit Oracle - []", () => {
    expect(implicitOracle([])).toBe(true);
  });

  test("Implicit Oracle - [1]", () => {
    expect(implicitOracle([1])).toBe(true);
  });

  test("Implicit Oracle - [[]]", () => {
    expect(implicitOracle([[]])).toBe(true);
  });

  test("Implicit Oracle - [[1]]", () => {
    expect(implicitOracle([[]])).toBe(true);
  });

  test("Implicit Oracle - [null,1]", () => {
    expect(implicitOracle([null, 1])).toBe(false);
  });

  test("Implicit Oracle - [1,undefined]", () => {
    expect(implicitOracle([1, undefined])).toBe(false);
  });

  test("Implicit Oracle - [NaN,1]", () => {
    expect(implicitOracle([NaN, 1])).toBe(false);
  });

  test("Implicit Oracle - [1,Infinity]", () => {
    expect(implicitOracle([1, Infinity])).toBe(false);
  });

  test("Implicit Oracle - [-Infinity,1]", () => {
    expect(implicitOracle([-Infinity, 1])).toBe(false);
  });

  test("Implicit Oracle - [[null,1],1]", () => {
    expect(implicitOracle([[null, 1], 1])).toBe(false);
  });

  test("Implicit Oracle - [1,[undefined,1]]", () => {
    expect(implicitOracle([1, [undefined, 1]])).toBe(false);
  });

  test("Implicit Oracle - [[NaN,1],1]", () => {
    expect(implicitOracle([[NaN, 1], 1])).toBe(false);
  });

  test("Implicit Oracle - [1,[1,Infinity]]", () => {
    expect(implicitOracle([1, [1, Infinity]])).toBe(false);
  });

  test("Implicit Oracle - [[1,-Infinity],1]", () => {
    expect(implicitOracle([[1, -Infinity], 1])).toBe(false);
  });

  test("Implicit Oracle - {}", () => {
    expect(implicitOracle({})).toBe(true);
  });

  test("Implicit Oracle - {a: 'abc', b: 123}", () => {
    expect(implicitOracle({ a: "abc", b: 123 })).toBe(true);
  });

  test("Implicit Oracle - {a:null, b:1}", () => {
    expect(implicitOracle({ a: null, b: 1 })).toBe(false);
  });

  test("Implicit Oracle - {a:1, b:undefined}", () => {
    expect(implicitOracle({ a: 1, b: undefined })).toBe(false);
  });

  test("Implicit Oracle - {a:1, b:NaN}", () => {
    expect(implicitOracle({ a: 1, b: NaN })).toBe(false);
  });

  test("Implicit Oracle - {a:1, b:Infinity}", () => {
    expect(implicitOracle({ a: 1, b: Infinity })).toBe(false);
  });

  test("Implicit Oracle - {a:-Infinity, b:1}", () => {
    expect(implicitOracle({ a: -Infinity, b: 1 })).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:null}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: null }], b: 1 }])).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:NaN}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: NaN }], b: 1 }])).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:Infinity}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: Infinity }], b: 1 }])).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:-Infinity}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: -Infinity }], b: 1 }])).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:undefined}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: undefined }], b: 1 }])).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:2}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: 2 }], b: 1 }])).toBe(true);
  });

  test("Fuzz example 1", async () => {
    const results = (
      await fuzz(setup(intOptions, "nanofuzz-study/examples/1.ts", "minValue"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 2", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "nanofuzz-study/examples/2.ts", "getSortSetting")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 3", async () => {
    const results = (
      await fuzz(
        setup(
          floatOptions,
          "nanofuzz-study/examples/3.ts",
          "totalDinnerExpenses"
        )
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 4", async () => {
    const results = (
      await fuzz(
        setup(
          {
            ...intOptions,
            argDefaults: { ...intOptions.argDefaults, anyDims: 1 },
          },
          "nanofuzz-study/examples/4.ts",
          "maxOfArray"
        )
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 5", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "nanofuzz-study/examples/5.ts", "getRandomNumber")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 6", async () => {
    const results = (
      await fuzz(setup(intOptions, "nanofuzz-study/examples/6.ts", "getZero"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 7", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "nanofuzz-study/examples/7.ts", "sortByWinLoss")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 8", async () => {
    const results = (
      await fuzz(setup(intOptions, "nanofuzz-study/examples/8.ts", "minSalary"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 9", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "nanofuzz-study/examples/9.ts", "getOffsetOrDefault")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  // TODO: Vector length is randomized here - probably do not want that !!!
  test("Fuzz example 10", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "nanofuzz-study/examples/10.ts", "gramSchmidt")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 11", async () => {
    const results = (
      await fuzz(setup(intOptions, "nanofuzz-study/examples/11.ts", "idMatrix"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 12", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "nanofuzz-study/examples/12.ts", "levenshtein")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 13", async () => {
    const results = (
      await fuzz(setup(intOptions, "nanofuzz-study/examples/13.ts", "isSteady"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 14", async () => {
    const results = (
      await fuzz(setup(intOptions, "nanofuzz-study/examples/14.ts", "modInv"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Counter-example mode 01", async () => {
    const results = (
      await fuzz(
        setup(counterExampleOptions, "nanofuzz-study/examples/14.ts", "modInv")
      )
    ).results;
    expect(results.length).toStrictEqual(1);
    expect(results[0].category).not.toStrictEqual("ok");
  });

  /**
   * Ensure fuzz targets that mutate their inputs cannot alter
   * the input the fuzzer recorded for the function.
   */
  test("Fuzz target cannot change fuzzer input record", async () => {
    const results = (
      await fuzz(setup(intOptions, "./Fuzzer.test.ts", "testChangeInput"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
    expect(results[0].input[0].value.b).toBeUndefined();
  });

  /**
   * Test that `void` functions (standard and arrow) fail the implicit
   * oracle in the case that they return values other than `undefined`
   */
  test("Standard fn void fuzz target fails if return is !==undefined", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "./Fuzzer.test.ts", "testStandardVoidReturnNumber")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
    expect(results.some((e) => e.passedImplicit)).toBeFalsy();
  });
  test("Arrow fn void fuzz target fails if return is !==undefined", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "./Fuzzer.test.ts", "testArrowVoidReturnNumber")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
    expect(results.some((e) => e.passedImplicit)).toBeFalsy();
  });

  /**
   * Test that `void` functions (standard and arrow) pass the implicit
   * oracle in the case that they only return `undefined`
   */
  test("Standard fn void fuzz target passes if return is undefined", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "./Fuzzer.test.ts", "testStandardVoidReturnUndefined")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
    expect(results.some((e) => e.passedImplicit)).toBeTruthy();
  });
  test("Arrow fn void fuzz target passes if return is undefined", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "./Fuzzer.test.ts", "testArrowVoidReturnUndefined")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
    expect(results.some((e) => e.passedImplicit)).toBeTruthy();
  });

  /**
   * Test that `void` functions (standard and arrow) fail the implicit
   * oracle when they throw an exception.
   */
  test("Standard fn void fuzz target fails if exception is thrown", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "./Fuzzer.test.ts", "testStandardVoidReturnException")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
    expect(results.some((e) => e.passedImplicit)).toBeFalsy();
    expect(results.every((e) => e.exception)).toBeTruthy();
  });
  test("Arrow fn void fuzz target fails if exception is thrown", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "./Fuzzer.test.ts", "testArrowVoidReturnException")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
    expect(results.some((e) => e.passedImplicit)).toBeFalsy();
    expect(results.every((e) => e.exception)).toBeTruthy();
  });

  /**
   * Test that `void` functions w/literal arguments (standard and arrow) pass
   * when they return undefined.
   */
  test("Standard void literal arg fuzz target", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "./Fuzzer.test.ts", "testStandardVoidLiteralArgs")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
    expect(results.some((e) => e.passedImplicit)).toBeTruthy();
  });
  test("Arrow void literal arg fuzz target", async () => {
    const results = (
      await fuzz(
        setup(intOptions, "./Fuzzer.test.ts", "testArrowVoidLiteralArgs")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
    expect(results.some((e) => e.passedImplicit)).toBeTruthy();
  });
});
