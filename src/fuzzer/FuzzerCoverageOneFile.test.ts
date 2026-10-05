import { FuzzerFactory } from "./FuzzerFactory";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { FuzzTestResult } from "./Types";

const coverageSearchSeeds = [
  "qwertyuiop" /*, "coverage", "needle", "mutation"*/,
];
const coverageSearchMinSolved = 1;

describe("fuzzer: coverageOneFile benchmark", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("Fuzz example 15 - coverageOneFile", async () => {
    const needle = "bugs";
    const near = needle.length - 1;
    const runs: {
      seed: string;
      best: number;
      solved: boolean;
      validatorFailed: boolean;
    }[] = [];

    for (const seed of coverageSearchSeeds) {
      const capturedResults: FuzzTestResult[] = [];
      const fuzzResult = await FuzzerFactory(
        "./test_fixtures/Fuzzer.testfixtures.ts",
        "testCoverageOneFile",
        {
          ...intOptions,
          useProperty: true,
          seed,
          maxTests: 12000,
          maxFailures: 1,
          fnTimeout: 2000,
          argDefaults: {
            ...intOptions.argDefaults,
            strLength: {
              min: 4,
              max: 4,
            },
          },
        }
      ).test([], { gen: true }, undefined, undefined, (r) =>
        capturedResults.push(r)
      );

      expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
      expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toEqual(
        fuzzResult.stats.outcomes.total
      );
      expect(fuzzResult.stats.outcomes.oracles.property.pass).toBeGreaterThan(
        0
      );

      runs.push({
        seed,
        best: capturedResults.reduce((max, e) => {
          const value = String(e.input[0].value);
          let matched = 0;
          for (let i = 0; i < needle.length; i++) {
            if (value[i] === needle[i]) matched++;
          }
          return Math.max(max, matched);
        }, 0),
        solved: capturedResults.some((e) => e.input[0].value === needle),
        validatorFailed: capturedResults.some((e) =>
          e.passedValidators.some((v) => v === "fail")
        ),
      });
    }

    expect(
      runs.filter((r) => r.best < near).map((r) => `${r.seed}:${r.best}`)
    ).toEqual([]);

    expect(runs.filter((r) => r.solved).length)
      .withContext(
        `seeds solving "${needle}" of [${coverageSearchSeeds.join(", ")}]`
      )
      .toBeGreaterThanOrEqual(coverageSearchMinSolved);

    expect(
      runs.filter((r) => r.solved && !r.validatorFailed).map((r) => r.seed)
    ).toEqual([]);
  }, 600000);
});
