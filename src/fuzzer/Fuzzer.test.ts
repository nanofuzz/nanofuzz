import {
  ArgDef,
  setup,
  fuzz,
  FuzzOptions,
  getDefaultFuzzOptions,
  implicitOracle,
} from "./Fuzzer";

/**
 * Fuzzer option for integer arguments and a seed for deterministic test execution.
 */
const intOptions: FuzzOptions = {
  ...getDefaultFuzzOptions(),
  seed: "qwertyuiop",
};

/**
 * Fuzzer option for float arguments and a seed for deterministic test execution.
 */
const floatOptions: FuzzOptions = {
  ...intOptions,
  argDefaults: ArgDef.getDefaultFloatOptions(),
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
      await fuzz(await setup(intOptions, "examples/1.ts", "minValue"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 2", async () => {
    const results = (
      await fuzz(await setup(intOptions, "examples/2.ts", "getSortSetting"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 3", async () => {
    const results = (
      await fuzz(
        await setup(floatOptions, "examples/3.ts", "totalDinnerExpenses")
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 4", async () => {
    const results = (
      await fuzz(
        await setup(
          {
            ...intOptions,
            argDefaults: { ...intOptions.argDefaults, anyDims: 1 },
          },
          "examples/4.ts",
          "maxOfArray"
        )
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 5", async () => {
    const results = (
      await fuzz(await setup(intOptions, "examples/5.ts", "getRandomNumber"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 6", async () => {
    const results = (
      await fuzz(await setup(intOptions, "examples/6.ts", "getZero"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 7", async () => {
    const results = (
      await fuzz(await setup(intOptions, "examples/7.ts", "sortByWinLoss"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 8", async () => {
    const results = (
      await fuzz(await setup(intOptions, "examples/8.ts", "minSalary"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 9", async () => {
    const results = (
      await fuzz(await setup(intOptions, "examples/9.ts", "getOffsetOrDefault"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  // TODO: Vector length is randomized here - probably do not want that !!!
  test("Fuzz example 10", async () => {
    const results = (
      await fuzz(await setup(intOptions, "examples/10.ts", "gramSchmidt"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 11", async () => {
    const results = (
      await fuzz(await setup(intOptions, "examples/11.ts", "idMatrix"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 12", async () => {
    const results = (
      await fuzz(await setup(intOptions, "examples/12.ts", "levenshtein"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 13", async () => {
    const results = (
      await fuzz(await setup(intOptions, "examples/13.ts", "isSteady"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 14", async () => {
    const results = (
      await fuzz(await setup(intOptions, "examples/14.ts", "modInv"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });
});
