import { Tester } from "./Fuzzer";
import { intOptions, initParser } from "./FuzzerTestHelper";
import * as JSONN from "../Jsonn";

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
      const fuzzResult = await new Tester(
        "./test_fixtures/Fuzzer.testfixtures.ts",
        "testCoverageOneFile",
        {
          ...intOptions,
          useProperty: true,
          seed,
          maxTests: 12000,
          maxFailures: 1,
          argDefaults: {
            ...intOptions.argDefaults,
            strLength: {
              min: 4,
              max: 4,
            },
          },
        }
      ).testSync();

      expect(fuzzResult.results.length).toBeGreaterThan(0);
      expect(
        fuzzResult.results.every((e) => e.passedImplicit === "pass")
      ).toBeTruthy();
      expect(
        fuzzResult.results.some((e) =>
          e.passedValidators.some((v) => v === "pass")
        )
      ).toBeTruthy();

      runs.push({
        seed,
        best: fuzzResult.results.reduce((max, e) => {
          const value = String(e.input[0].value);
          let matched = 0;
          for (let i = 0; i < needle.length; i++) {
            if (value[i] === needle[i]) matched++;
          }
          return Math.max(max, matched);
        }, 0),
        solved: fuzzResult.results.some((e) => e.input[0].value === needle),
        validatorFailed: fuzzResult.results.some((e) =>
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
