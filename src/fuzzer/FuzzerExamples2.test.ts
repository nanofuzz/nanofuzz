import { Tester } from "./Fuzzer";
import { intOptions, initParser } from "./FuzzerTestHelper";

describe("fuzzer: study examples 8-14", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("Fuzz example 08 - minSalary", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/8.ts",
          "minSalary",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 09 - getOffsetOrDefault", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/9.ts",
          "getOffsetOrDefault",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  // TODO: Vector length is randomized here - probably do not want that !!!
  it("Fuzz example 10 - gramSchmidt", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/10.ts",
          "gramSchmidt",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 11 - idMatrix", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/11.ts",
          "idMatrix",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 12 - levenshtein", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/12.ts",
          "levenshtein",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 13 - isSteady", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/13.ts",
          "isSteady",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 14 - modInv", async () => {
    const fuzzResult = await new Tester(
      "nanofuzz-study/examples/14.ts",
      "modInv",
      {
        ...intOptions,
        suiteTimeout: 3000,
      }
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.timeout)).toBe(true);
  });
});
