import { FuzzerFactory } from "./FuzzerFactory";
import { intOptions, initParser } from "./FuzzerTestHelper";
import * as ValueMapper from "./mappers/ValueMapper";
import { FuzzPinnedTest, FuzzStopReason, FuzzTestResult } from "./Types";

describe("fuzzer: python targets", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("Python string input and property test", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "greeting",
      {
        ...intOptions,
        useProperty: true,
        suiteTimeout: 3000,
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

  it("Python timeouts", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "timeouts",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.timeouts).toBeGreaterThan(0);
  });

  it("Python exceptions", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "throws",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.exceptions).toBeGreaterThan(0);
  });

  it("Python valid target in invalid file", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures2.py",
      "valid",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.exceptions).toEqual(
      fuzzResult.stats.outcomes.total
    );
  });

  it("Python invalid target in invalid file", async () => {
    expect(() => {
      FuzzerFactory(
        "./test_fixtures/Fuzzer.testfixtures2.py",
        "invalid",
        intOptions
      ).test();
    }).toThrowError();
  });

  it("Issue #301 (Python) include object members if value is `None`", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "issue301",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(1);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.fail).toEqual(1);
    const firstFailure = fuzzResult.stats.outcomes.firstFailure;
    expect(firstFailure).toBeDefined();
    if (firstFailure) {
      expect(ValueMapper.toLang("python", firstFailure.input[0].value)).toEqual(
        "6"
      );
      expect(
        typeof firstFailure.output[0].value === "object" &&
          firstFailure.output[0].value !== null &&
          "a" in firstFailure.output[0].value &&
          firstFailure.output[0].value["a"] === null
      ).toBeTrue();
      expect(
        ValueMapper.toLang("python", firstFailure.output[0].value)
      ).toEqual(`{"a": None}`);
    }
  });

  it("Python assume statement (skipped tests)", async () => {
    const skips: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "with_assume",
      {
        ...intOptions,
        maxTests: 200, // Make sure we generate enough tests to hit n = 5
      }
    ).test([], { gen: true }, undefined, undefined, (r) => {
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

  it("Python transformer input transformation, skips, and null return", async () => {
    const skips: FuzzTestResult[] = [];
    const passed: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "py_transformed",
      intOptions
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
            "py_transformedTransformer"
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
      expect(coveredFnNames).toContain("py_transformed");
      expect(coveredFnNames).toContain("py_transformedTransformer");
    }
  });

  it("injected (pinned, saved, and human-generated) inputs bypass Python input transformer", async () => {
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
      "./test_fixtures/Fuzzer.testfixtures.py",
      "py_transformed",
      { ...intOptions, maxTests: 0 }
    ).test([injectedInput], { gen: true }, undefined, undefined, (r) =>
      results.push(r)
    );

    expect(results.length).toBe(1);
    const injectedResult = results[0];

    // Verify the injected input was NOT skipped by py_transformedTransformer (which skips n=5)
    expect(injectedResult.skipped).toBeFalse();

    // Verify the input value was NOT transformed (remains 5, not multiplied by 10)
    expect<unknown>(injectedResult.input[0].value).toBe(5);

    // Verify output is py_transformed(5) => 6 (not 50 + 1 => 51)
    expect<unknown>(injectedResult.output[0].value).toBe(6);

    // Verify origin was preserved as user input rather than changed to transformer
    expect(injectedResult.input[0].origin.type).toBe("user");
  });

  it("Python transformer exception", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "py_transformed_exception",
      intOptions
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.categories.failure).toEqual(
      fuzzResult.stats.outcomes.total
    );
    results.forEach((r) => {
      expect(r.harnessErrors.length).toBeGreaterThan(0);
      expect(r.harnessErrors[0].message).toContain("Python transformer error");
      expect(r.category).toBe("failure");
    });
  });

  it("Python transformer timeout", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "py_transformed_timeout",
      {
        ...intOptions,
        maxTests: 2,
      }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.categories.failure).toEqual(
      fuzzResult.stats.outcomes.total
    );
    results.forEach((r) => {
      expect(r.harnessErrors.length).toBeGreaterThan(0);
      expect(r.harnessErrors[0].kind).toBe("timeout");
      expect(r.category).toBe("failure");
    });
  });

  it("Python UserInputGenerator generation, origin tagging, and execution", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "py_user_gen",
      {
        ...intOptions,
        maxTests: 100,
        generators: {
          RandomInputGenerator: { enabled: false },
          MutationInputGenerator: { enabled: false },
          AiInputGenerator: { enabled: false },
          UserInputGenerator: { enabled: true },
        },
      }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    console.log("STOP REASON:", fuzzResult.stopReason);
    console.log("TOTAL OUTCOMES:", fuzzResult.stats.outcomes.total);
    console.log("RESULTS LENGTH:", results.length);
    console.log(
      "GENERATORS STATS:",
      JSON.stringify(fuzzResult.stats.generators, null, 2)
    );

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.categories.ok).toBeGreaterThan(0);
    expect(fuzzResult.stopReason).toBe(FuzzStopReason.MAXTESTS);
    expect(fuzzResult.stats.outcomes.total).toBe(100);

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
      expect(coveredFnNames).toContain("py_user_gen");
      expect(
        coveredFnNames.some(
          (name) => name && name.includes("py_user_genGenerator")
        )
      ).toBeTrue();
    }
  });

  it("Python UserInputGenerator exhaustion", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "py_user_gen_finite",
      {
        ...intOptions,
        maxTests: 50,
        generators: {
          RandomInputGenerator: { enabled: false },
          MutationInputGenerator: { enabled: false },
          AiInputGenerator: { enabled: false },
          UserInputGenerator: { enabled: true },
        },
      }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(results.length).toBe(3);
    expect(fuzzResult.stopReason).toBe("noMoreInputs");
  });

  it("Python UserInputGenerator exception stops testing with crash", async () => {
    let caughtError: unknown;
    try {
      await FuzzerFactory(
        "./test_fixtures/Fuzzer.testfixtures.py",
        "py_user_gen_exception",
        {
          ...intOptions,
          maxTests: 10,
          generators: {
            RandomInputGenerator: { enabled: false },
            MutationInputGenerator: { enabled: false },
            AiInputGenerator: { enabled: false },
            UserInputGenerator: { enabled: true },
          },
        }
      ).test([], { gen: true });
    } catch (e: unknown) {
      caughtError = e;
    }

    expect(caughtError instanceof Error).toBeTrue();
    if (caughtError instanceof Error) {
      expect(caughtError.message).toContain("Python user generator error");
    }
  });

  it("Python UserInputGenerator UnsatisfiedAssumption crashes", async () => {
    let caughtError: unknown;
    try {
      await FuzzerFactory(
        "./test_fixtures/Fuzzer.testfixtures.py",
        "py_user_gen_assumption",
        {
          ...intOptions,
          maxTests: 10,
          generators: {
            RandomInputGenerator: { enabled: false },
            MutationInputGenerator: { enabled: false },
            AiInputGenerator: { enabled: false },
            UserInputGenerator: { enabled: true },
          },
        }
      ).test([], { gen: true });
    } catch (e: unknown) {
      caughtError = e;
    }

    expect(caughtError instanceof Error).toBeTrue();
    if (caughtError instanceof Error) {
      expect(caughtError.message).toContain("UnsatisfiedAssumption");
    }
  });

  it("Python async fuzz target with property validator and coverage", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "async_greeting",
      {
        ...intOptions,
        useProperty: true,
        maxTests: 10,
        suiteTimeout: 5000,
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

  it("Python BigInt target with property validator and pin", async () => {
    const results: FuzzTestResult[] = [];
    const pinned: FuzzPinnedTest = {
      input: [
        {
          name: "n",
          offset: 0,
          value: 42n,
          origin: { type: "user" },
        },
      ],
      output: [],
      pinned: true,
    };
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "test_bigint_target",
      {
        ...intOptions,
        useProperty: true,
        maxTests: 10,
      }
    ).test([pinned], { gen: true }, undefined, undefined, (r) =>
      results.push(r)
    );

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThan(0);
    const pinnedRes = results.find((r) => Number(r.input[0].value) === 42);
    expect(pinnedRes).toBeDefined();
    expect(pinnedRes?.exception).toBeTrue();
  });
});
