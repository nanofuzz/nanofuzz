import { FuzzerFactory } from "./FuzzerFactory";
import { intOptions, floatOptions, initParser } from "./FuzzerTestHelper";

describe("fuzzer: study examples 1-7", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("Fuzz example 01 - minValue", async () => {
    expect(
      (
        await FuzzerFactory(
          "nanofuzz-study/examples/1.ts",
          "minValue",
          intOptions
        ).test()
      ).stats.outcomes.total
    ).toBeGreaterThan(0);
  });

  it("Fuzz example 02 - getSortSetting", async () => {
    expect(
      (
        await FuzzerFactory(
          "nanofuzz-study/examples/2.ts",
          "getSortSetting",
          intOptions
        ).test()
      ).stats.outcomes.total
    ).toBeGreaterThan(0);
  });

  it("Fuzz example 03 - totalDinnerExpenses", async () => {
    expect(
      (
        await FuzzerFactory(
          "nanofuzz-study/examples/3.ts",
          "totalDinnerExpenses",
          floatOptions
        ).test()
      ).stats.outcomes.total
    ).toBeGreaterThan(0);
  });

  it("Fuzz example 04 - maxOfArray", async () => {
    expect(
      (
        await FuzzerFactory("nanofuzz-study/examples/4.ts", "maxOfArray", {
          ...intOptions,
          argDefaults: { ...intOptions.argDefaults, anyDims: 1 },
        }).test()
      ).stats.outcomes.total
    ).toBeGreaterThan(0);
  });

  it("Fuzz example 05 - getRandomNumber", async () => {
    expect(
      (
        await FuzzerFactory(
          "nanofuzz-study/examples/5.ts",
          "getRandomNumber",
          intOptions
        ).test()
      ).stats.outcomes.total
    ).toBeGreaterThan(0);
  });

  it("Fuzz example 06 - getZero", async () => {
    expect(
      (
        await FuzzerFactory(
          "nanofuzz-study/examples/6.ts",
          "getZero",
          intOptions
        ).test()
      ).stats.outcomes.total
    ).toBeGreaterThan(0);
  });

  it("Fuzz example 07 - sortByWinLoss", async () => {
    expect(
      (
        await FuzzerFactory(
          "nanofuzz-study/examples/7.ts",
          "sortByWinLoss",
          intOptions
        ).test()
      ).stats.outcomes.total
    ).toBeGreaterThan(0);
  });
});
