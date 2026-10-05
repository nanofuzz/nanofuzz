import { FuzzerFactory } from "./FuzzerFactory";
import { intOptions, initParser } from "./FuzzerTestHelper";

describe("fuzzer: coverageMultiFile benchmark", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("Fuzz example 16 - coverageMultiFile", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testCoverageMultiFile",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBe(
      fuzzResult.stats.outcomes.total
    );
    expect(fuzzResult.stats.measures.CodeCoverageMeasure).toBeDefined();
    if (fuzzResult.stats.measures.CodeCoverageMeasure) {
      const coverageStats =
        await fuzzResult.stats.measures.CodeCoverageMeasure();
      expect(coverageStats.files.length).toBeGreaterThan(1);
      expect(coverageStats.counters.functionsCovered).toBeGreaterThanOrEqual(2);
      expect(coverageStats.counters.statementsCovered).toBeGreaterThan(1);
      expect(coverageStats.counters.branchesCovered).toBeGreaterThan(0);
    }
  });
});
