import { ArgDef } from "./analysis/Typescript";
import { fuzzSetup, fuzz, FuzzOptions, getDefaultFuzzOptions } from "./index";
// !!!
const intOptions: FuzzOptions = getDefaultFuzzOptions();
const floatOptions: FuzzOptions = {
  ...intOptions,
  argOptions: ArgDef.getDefaultFloatOptions(),
};

// !!!
describe("Fuzzer", () => {
  // !!! Missing support for tuple types
  test.skip("Fuzz example 1", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/1.ts", "minValue")).outputs
    ).toStrictEqual([]); // !!!
  });

  test("Fuzz example 2", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/2.ts", "getSortSetting"))
        .outputs
    ).toStrictEqual([]); // !!!
  });

  test("Fuzz example 3", () => {
    expect(
      fuzz(
        fuzzSetup(floatOptions, "./src/examples/3.ts", "totalDinnerExpenses")
      ).outputs
    ).toStrictEqual([]); // !!!
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
      ).outputs
    ).toStrictEqual([]); // !!!
  });

  test("Fuzz example 5", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/5.ts", "getRandomNumber"))
        .outputs
    ).toStrictEqual([]); // !!!
  });

  test("Fuzz example 6", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/6.ts", "getZero")).outputs
    ).toStrictEqual([]); // !!!
  });

  // !!! Missing support for type references
  test.skip("Fuzz example 7", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/7.ts", "sortByWinLoss"))
        .outputs
    ).toStrictEqual([]); // !!!
  });

  test("Fuzz example 8", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/8.ts", "minSalary")).outputs
    ).toStrictEqual([]); // !!!
  });

  // !!! Missing support for string randomization
  test.skip("Fuzz example 9", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/9.ts", "getOffsetOrDefault"))
        .outputs
    ).toStrictEqual([]); // !!!
  });

  // !!! Vector length is randomized here (may not want that)
  test("Fuzz example 10", () => {
    expect(
      fuzz(fuzzSetup(intOptions, "./src/examples/10.ts", "gramSchmidt")).outputs
    ).toStrictEqual([]); // !!!
  });
});
