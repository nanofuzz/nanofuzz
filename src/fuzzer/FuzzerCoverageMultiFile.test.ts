import { Tester } from "./Fuzzer";
import { intOptions, initParser } from "./FuzzerTestHelper";

describe("fuzzer: coverageMultiFile benchmark", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("Fuzz example 16 - coverageMultiFile", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testCoverageMultiFile",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.every((e) => e.passedImplicit === "pass")
    ).toBeTruthy();
    expect(fuzzResult.stats.measures.CodeCoverageMeasure).toBeDefined();
    if (fuzzResult.stats.measures.CodeCoverageMeasure) {
      const coverageStats =
        await fuzzResult.stats.measures.CodeCoverageMeasure();
      expect(coverageStats.files.length).toBeGreaterThan(1);
      expect(coverageStats.counters.functionsCovered).toBe(2);
      expect(coverageStats.counters.statementsCovered).toBeGreaterThan(1);
      expect(coverageStats.counters.branchesCovered).toBeGreaterThan(0);
    }
  });
});
