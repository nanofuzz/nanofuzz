import { Tester } from "./Fuzzer";
import { intOptions, floatOptions, initParser } from "./FuzzerTestHelper";

describe("fuzzer: study examples 1-7", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("Fuzz example 01 - minValue", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/1.ts",
          "minValue",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 02 - getSortSetting", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/2.ts",
          "getSortSetting",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 03 - totalDinnerExpenses", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/3.ts",
          "totalDinnerExpenses",
          floatOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 04 - maxOfArray", async () => {
    expect(
      (
        await new Tester("nanofuzz-study/examples/4.ts", "maxOfArray", {
          ...intOptions,
          argDefaults: { ...intOptions.argDefaults, anyDims: 1 },
        }).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 05 - getRandomNumber", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/5.ts",
          "getRandomNumber",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 06 - getZero", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/6.ts",
          "getZero",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 07 - sortByWinLoss", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/7.ts",
          "sortByWinLoss",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });
});
