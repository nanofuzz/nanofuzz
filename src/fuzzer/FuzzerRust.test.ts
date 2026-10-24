import { FuzzerFactory } from "./FuzzerFactory";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { FuzzPinnedTest, FuzzStopReason, FuzzTestResult } from "./Types";
import { isKeyedObject } from "../Util";

describe("fuzzer: rust targets", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("Rust string input and property test", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.rs",
      "greeting",
      {
        ...intOptions,
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

    // Check code coverage includes both PUT and validator functions
    const covStats = await fuzzResult.stats.measures.CodeCoverageMeasure?.();
    expect(covStats).toBeDefined();
    if (covStats && covStats.files.length) {
      const fileStats = covStats.files[0];
      const coveredFnNames = Object.keys(fileStats.fileMap.f).map(
        (idx) => fileStats.fileMap.fnMap[idx]?.name
      );
      expect(coveredFnNames).toContain("greeting");
      expect(
        coveredFnNames.some(
          (name) => name && name.includes("greetingValidator")
        )
      ).toBeTrue();
    }
  });

  it("Rust timeouts", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.rs",
      "timeouts",
      {
        ...intOptions,
        suiteTimeout: 10000,
      }
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.timeouts).toBeGreaterThan(0);
  });

  it("Rust panics/exceptions", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.rs",
      "throws",
      {
        ...intOptions,
        suiteTimeout: 10000,
      }
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.exceptions).toBeGreaterThan(0);
  });

  it("Rust assume macro (skipped tests)", async () => {
    const pinned: FuzzPinnedTest = {
      input: [
        {
          name: "n",
          offset: 0,
          value: 5,
          origin: { type: "user" },
        },
      ],
      output: [],
      pinned: true,
    };

    const skips: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.rs",
      "with_assume",
      {
        ...intOptions,
        maxTests: 20,
        suiteTimeout: 10000,
      }
    ).test([pinned], { gen: true }, undefined, undefined, (r) => {
      if (r.category === "skip") skips.push(r);
    });

    expect(fuzzResult.stats.outcomes.categories.skip).toBeGreaterThan(0);
    expect(skips.length).toBeGreaterThan(0);
    skips.forEach((r) => {
      expect(r.skipped).toBeTrue();
      expect(r.passedImplicit).toBe("unknown");
      expect(r.skipReason).toContain("n cannot be 5");
    });
  });

  it("Rust transformer input transformation and skips", async () => {
    const skips: FuzzTestResult[] = [];
    const passed: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.rs",
      "rs_transformed",
      {
        ...intOptions,
        suiteTimeout: 10000,
      }
    ).test([], { gen: true }, undefined, undefined, (r) => {
      if (r.category === "skip") skips.push(r);
      if (r.category === "ok") passed.push(r);
    });

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.categories.skip).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.categories.ok).toBeGreaterThan(0);

    expect(skips.length).toBeGreaterThan(0);
    skips.forEach((r) => {
      expect(r.skipped).toBeTrue();
    });

    expect(passed.length).toBeGreaterThan(0);
    passed.forEach((r) => {
      const transformedInput = Number(r.input[0].value);
      const actualOutput: unknown = r.output[0].value;
      expect(actualOutput).toBe(transformedInput + 1);

      if (transformedInput !== 0) {
        expect(r.input[0].origin.type).toBe("transformer");
        if (r.input[0].origin.type === "transformer") {
          expect(r.input[0].origin.transformer).toBe(
            "rs_transformedTransformer"
          );
          expect(r.input[0].origin.basis.source.type).toBe("generator");
        }
      }
    });

    // Check code coverage includes both PUT and transformer functions
    const covStats = await fuzzResult.stats.measures.CodeCoverageMeasure?.();
    expect(covStats).toBeDefined();
    if (covStats && covStats.files.length) {
      const fileStats = covStats.files[0];
      const coveredFnNames = Object.keys(fileStats.fileMap.f).map(
        (idx) => fileStats.fileMap.fnMap[idx]?.name
      );
      expect(coveredFnNames).toContain("rs_transformed");
      expect(coveredFnNames).toContain("rs_transformedTransformer");
    }
  });

  it("injected inputs bypass Rust input transformer", async () => {
    const injectedInput: FuzzPinnedTest = {
      input: [
        {
          name: "n",
          offset: 0,
          value: 5,
          origin: { type: "user" },
        },
      ],
      output: [],
      pinned: true,
    };

    const results: FuzzTestResult[] = [];
    await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.rs",
      "rs_transformed",
      { ...intOptions, maxTests: 0, suiteTimeout: 10000 }
    ).test([injectedInput], { gen: true }, undefined, undefined, (r) =>
      results.push(r)
    );

    expect(results.length).toBe(1);
    const injectedResult = results[0];

    // Verify injected input was NOT skipped by transformer
    expect(injectedResult.skipped).toBeFalse();

    // Verify input value was NOT transformed (remains 5)
    expect<unknown>(injectedResult.input[0].value).toBe(5);

    // Verify output is rs_transformed(5) => 6
    expect<unknown>(injectedResult.output[0].value).toBe(6);

    // Verify origin was preserved as user input
    expect(injectedResult.input[0].origin.type).toBe("user");
  });

  it("Rust UserInputGenerator generation, origin tagging, and execution", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.rs",
      "rs_user_gen",
      {
        ...intOptions,
        maxTests: 20,
        suiteTimeout: 10000,
        generators: {
          RandomInputGenerator: { enabled: false },
          MutationInputGenerator: { enabled: false },
          AiInputGenerator: { enabled: false },
          UserInputGenerator: { enabled: true },
        },
      }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBe(20);
    expect(fuzzResult.stats.outcomes.categories.ok).toBe(20);
    expect(fuzzResult.stopReason).toBe(FuzzStopReason.MAXTESTS);

    results.forEach((r) => {
      expect(r.input[0].origin.type).toBe("generator");
      if (r.input[0].origin.type === "generator") {
        expect(r.input[0].origin.generator).toBe("UserInputGenerator");
      }
      expect<unknown>(r.input[1].value).toBe("custom");
      expect<unknown>(r.output[0].value).toBe(`custom:${r.input[0].value}`);
    });

    const covStats = await fuzzResult.stats.measures.CodeCoverageMeasure?.();
    expect(covStats).toBeDefined();
    if (covStats && covStats.files.length) {
      const fileStats = covStats.files[0];
      const coveredFnNames = Object.keys(fileStats.fileMap.f).map(
        (idx) => fileStats.fileMap.fnMap[idx]?.name
      );
      expect(coveredFnNames).toContain("rs_user_gen");
      expect(
        coveredFnNames.some(
          (name) => name && name.includes("rs_user_genGenerator")
        )
      ).toBeTrue();
    }
  });

  it("Rust async fuzz target with property validator and coverage", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.rs",
      "async_greeting",
      {
        ...intOptions,
        useProperty: true,
        maxTests: 10,
        suiteTimeout: 10000,
      }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThan(0);

    results.forEach((r) => {
      expect(r.output.length).toBeGreaterThan(0);
      if (!r.exception) {
        expect(typeof r.output[0].value).toBe("string");
        expect(String(r.output[0].value).startsWith("Hello ")).toBeTrue();
      }
      expect(r.passedValidator).toBe("pass");
    });

    const covStats = await fuzzResult.stats.measures.CodeCoverageMeasure?.();
    expect(covStats).toBeDefined();
    if (covStats && covStats.files.length) {
      const fileStats = covStats.files[0];
      const coveredFnNames = Object.keys(fileStats.fileMap.f).map(
        (idx) => fileStats.fileMap.fnMap[idx]?.name
      );
      expect(coveredFnNames).toContain("async_greeting");
      expect(
        coveredFnNames.some(
          (name) => name && name.includes("async_greetingValidator")
        )
      ).toBeTrue();
    }
  });

  it("Rust unexported function fuzzing via __nanofuzz_get__ shim", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.rs",
      "unexported_helper",
      {
        ...intOptions,
        maxTests: 10,
        suiteTimeout: 10000,
      }
    ).test(
      [
        {
          input: [
            { name: "x", offset: 0, value: 21, origin: { type: "user" } },
          ],
          output: [],
          pinned: true,
        },
      ],
      { gen: true },
      undefined,
      undefined,
      (r) => results.push(r)
    );

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThan(0);
    const pinnedResult = results.find(
      (r) => r.input.length > 0 && r.input[0].origin.type === "user"
    );
    expect(pinnedResult).toBeDefined();
    const outputVal: unknown = pinnedResult?.output[0]?.value;
    expect(outputVal).toBe(42);

    const covStats = await fuzzResult.stats.measures.CodeCoverageMeasure?.();
    expect(covStats).toBeDefined();
    if (covStats && covStats.files.length) {
      const fileStats = covStats.files[0];
      const coveredFnNames = Object.keys(fileStats.fileMap.f).map(
        (idx) => fileStats.fileMap.fnMap[idx]?.name
      );
      expect(coveredFnNames).toContain("unexported_helper");
    }
  });

  it("Rust struct fuzz target with Random and Mutation generators", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.rs",
      "shift_point",
      {
        ...intOptions,
        maxTests: 20,
        suiteTimeout: 10000,
      }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBe(20);
    expect(fuzzResult.stats.outcomes.categories.ok).toBe(20);
    expect(results.length).toBe(20);
    for (const r of results) {
      expect(r.input.length).toBe(1);
      const inVal = r.input[0].value;
      const outVal = r.output[0].value;
      if (
        isKeyedObject(inVal) &&
        isKeyedObject(outVal) &&
        typeof inVal.x === "number" &&
        typeof inVal.y === "number" &&
        typeof outVal.x === "number" &&
        typeof outVal.y === "number"
      ) {
        expect(outVal.x).toBe(inVal.x + 1);
        expect(outVal.y).toBe(inVal.y - 1);
      } else {
        fail("Expected inVal and outVal to be objects with numeric x and y");
      }
    }
  });
});
