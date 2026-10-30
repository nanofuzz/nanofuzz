import { FuzzerFactory } from "./FuzzerFactory";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { FuzzPinnedTest, FuzzStopReason, FuzzTestResult } from "./Types";

describe("fuzzer: go targets", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("Go string input and property test", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.go",
      "Greeting",
      {
        ...intOptions,
        maxTests: 25,
        fnTimeout: 2000,
        useProperty: true,
        suiteTimeout: 10000,
      }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toEqual(
      fuzzResult.stats.outcomes.total
    );
    expect(
      results.every(
        (e) =>
          e.output.length &&
          typeof e.output[0].value === "string" &&
          e.input.length &&
          typeof e.input[0].value === "string" &&
          e.output[0].value.endsWith(e.input[0].value)
      )
    ).toBeTrue();

    // Check property test results
    expect(fuzzResult.env.validators.length).toEqual(1);
    expect(fuzzResult.stats.outcomes.oracles.property.pass).toEqual(
      fuzzResult.stats.outcomes.total
    );
    results.forEach((r) => {
      expect(r.passedValidators.length).toBe(1);
      expect(r.harnessErrors.length).toBe(0);
      expect(r.passedValidator).toBe("pass");
    });
  });

  it("Go panics and exceptions", async () => {
    const pinned: FuzzPinnedTest[] = [
      {
        input: [{ name: "n", offset: 0, value: 5, origin: { type: "user" } }],
        output: [],
        pinned: true,
      },
      {
        input: [{ name: "n", offset: 0, value: 15, origin: { type: "user" } }],
        output: [],
        pinned: true,
      },
    ];

    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.go",
      "Throws",
      {
        ...intOptions,
        maxTests: 2,
        fnTimeout: 2000,
        suiteTimeout: 10000,
      }
    ).test(pinned, {});

    expect(fuzzResult.stats.outcomes.total).toBe(2);
    expect(fuzzResult.stats.outcomes.exceptions).toBe(1);
  });

  it("Go timeouts", async () => {
    const pinned: FuzzPinnedTest[] = [
      {
        input: [{ name: "n", offset: 0, value: 0, origin: { type: "user" } }],
        output: [],
        pinned: true,
      },
      {
        input: [{ name: "n", offset: 0, value: 1, origin: { type: "user" } }],
        output: [],
        pinned: true,
      },
    ];

    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.go",
      "Timeouts",
      {
        ...intOptions,
        maxTests: 2,
        fnTimeout: 100,
        suiteTimeout: 2000,
      }
    ).test(pinned, {});

    expect(fuzzResult.stats.outcomes.total).toBe(2);
    expect(fuzzResult.stats.outcomes.timeouts).toBe(1);
  });

  it("Go with assume filtering", async () => {
    const pinned: FuzzPinnedTest[] = [
      {
        input: [{ name: "n", offset: 0, value: 5, origin: { type: "user" } }],
        output: [],
        pinned: true,
      },
      {
        input: [{ name: "n", offset: 0, value: 2, origin: { type: "user" } }],
        output: [],
        pinned: true,
      },
    ];

    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.go",
      "WithAssume",
      {
        ...intOptions,
        maxTests: 2,
        fnTimeout: 2000,
        suiteTimeout: 10000,
      }
    ).test(pinned, {});

    expect(fuzzResult.stats.outcomes.total).toBe(1);
    expect(fuzzResult.stats.outcomes.exceptions).toBe(0);
  });

  it("Go input transformer", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.go",
      "Transformed",
      {
        ...intOptions,
        useTransformer: true,
        maxTests: 25,
        suiteTimeout: 10000,
      }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.env.transformers.length).toBe(1);
    expect(fuzzResult.stats.outcomes.exceptions).toBe(0);

    const skipResult = results.find((r) => r.skipped);
    expect(skipResult).toBeDefined();
    if (skipResult) {
      expect(skipResult.category).toBe("skip");
      expect(skipResult.skipReason).toContain("Transformer skipped");
      expect(skipResult.harnessErrors.length).toBe(0);
    }

    for (const r of results) {
      if (r.category === "ok") {
        const inVal = r.input[0].value;
        const outVal = r.output[0].value;
        if (typeof inVal === "number" && typeof outVal === "number") {
          expect(outVal).toBe(inVal + 1);
        }
      }
    }
  });

  it("Go user input generator", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.go",
      "UserGen",
      {
        ...intOptions,
        maxTests: 15,
        suiteTimeout: 10000,
        generators: {
          RandomInputGenerator: { enabled: false },
          MutationInputGenerator: { enabled: false },
          AiInputGenerator: { enabled: false },
          UserInputGenerator: { enabled: true },
        },
      }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBe(15);
    expect(fuzzResult.stats.outcomes.categories.ok).toBe(15);
    expect(fuzzResult.stopReason).toBe(FuzzStopReason.MAXTESTS);
    expect(fuzzResult.env.userGenerators.length).toBe(1);
    expect(results.length).toBe(15);

    results.forEach((r) => {
      expect(r.input[0].origin.type).toBe("generator");
      if (r.input[0].origin.type === "generator") {
        expect(r.input[0].origin.generator).toBe("UserInputGenerator");
      }
      expect<unknown>(r.input[1].value).toBe("custom");
      expect<unknown>(r.output[0].value).toBe(`custom:${r.input[0].value}`);
    });
  });
});
