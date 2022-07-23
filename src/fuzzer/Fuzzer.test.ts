import { ArgDef } from "./analysis/Typescript";
import { setup, fuzz, FuzzOptions, getDefaultFuzzOptions } from "./Fuzzer";

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
  argOptions: ArgDef.getDefaultFloatOptions(),
};

/**
 * These tests currently just ensure that the fuzzer runs and produces output
 * for each example. TODO: Add tests that check the fuzzer output.
 */
describe("Fuzzer", () => {
  test("Fuzz example 1", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/1.ts", "minValue"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 2", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/2.ts", "getSortSetting"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 3", async () => {
    const results = (
      await fuzz(
        setup(floatOptions, "./src/examples/3.ts", "totalDinnerExpenses")
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
            argOptions: { ...intOptions.argOptions, anyDims: 1 },
          },
          "./src/examples/4.ts",
          "maxOfArray"
        )
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 5", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/5.ts", "getRandomNumber"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 6", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/6.ts", "getZero"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  // TODO: Add support for type references
  test.skip("Fuzz example 7", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/7.ts", "sortByWinLoss"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 8", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/8.ts", "minSalary"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 9", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/9.ts", "getOffsetOrDefault"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  // TODO: Vector length is randomized here - probably do not want that !!!
  test("Fuzz example 10", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/10.ts", "gramSchmidt"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 11", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/11.ts", "idMatrix"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 12", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/12.ts", "levenshtein"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 13", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/13.ts", "isSteady"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 14", async () => {
    const results = (
      await fuzz(setup(intOptions, "./src/examples/14.ts", "modInv"))
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });
});
