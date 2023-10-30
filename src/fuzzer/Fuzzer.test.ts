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
  maxFailures: 0,
  onlyFailures: false,
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
});
