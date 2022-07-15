import { ArgDef } from "./analysis/Typescript";
import { fuzzSetup, fuzz, FuzzOptions, getDefaultFuzzOptions } from "./index";

/**
 * These are not real tests, but they are useful for debugging
 * TODO: Create real tests
 */

// !!!
const intOptions: FuzzOptions = {
  ...getDefaultFuzzOptions(),
  seed: "qwertyuiop",
  outFile: "fuzzedGen.json",
};
const floatOptions: FuzzOptions = {
  ...intOptions,
  argOptions: ArgDef.getDefaultFloatOptions(),
};

// !!!
describe("Fuzzer", () => {
  // !!! Missing support for tuple types
  test.skip("Fuzz example 1", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/1.ts", "minValue")).results
        .length
    ).not.toStrictEqual(0);
  });

  test("Fuzz example 2", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/2.ts", "getSortSetting"))
        .results.length
    ).not.toStrictEqual(0);
  });

  test("Fuzz example 3", () => {
    expect(
      fuzz(
        fuzzSetup(floatOptions, "./src/examples/3.ts", "totalDinnerExpenses")
      ).results.length
    ).not.toStrictEqual(0);
  });

  test("Fuzz example 4", () => {
    expect(
      fuzz(
        fuzzSetup(
          {
            ...intOptions,
            argOptions: { ...intOptions.argOptions, anyDims: 1 },
          },
          "./src/examples/4.ts",
          "maxOfArray"
        )
      ).results.length
    ).not.toStrictEqual(0);
  });

  test("Fuzz example 5", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/5.ts", "getRandomNumber"))
        .results.length
    ).not.toStrictEqual(0);
  });

  test("Fuzz example 6", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/6.ts", "getZero")).results
        .length
    ).not.toStrictEqual(0);
  });

  // !!! Missing support for type references
  test.skip("Fuzz example 7", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/7.ts", "sortByWinLoss"))
        .results.length
    ).not.toStrictEqual(0);
  });

  test("Fuzz example 8", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/8.ts", "minSalary")).results
        .length
    ).not.toStrictEqual(0);
  });

  // !!! Missing support for string randomization
  test.skip("Fuzz example 9", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/9.ts", "getOffsetOrDefault"))
        .results.length
    ).not.toStrictEqual(0);
  });

  // !!! Vector length is randomized here (probably do not want that)
  test("Fuzz example 10", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/10.ts", "gramSchmidt")).results
        .length
    ).not.toStrictEqual(0);
  });

  // !!! Probably no bug to find in 11
  test("Fuzz example 11", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/11.ts", "josephus")).results
        .length
    ).not.toStrictEqual(0); // !!!
  });
});
