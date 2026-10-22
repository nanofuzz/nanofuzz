import { FuzzerFactory } from "./FuzzerFactory";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { ArgDefValidator } from "./analysis/ArgDefValidator";
import * as ValueMapper from "./mappers/ValueMapper";
import { FuzzPinnedTest, FuzzTestResult } from "./Types";

describe("fuzzer: typescript targets", () => {
  beforeAll(async () => {
    await initParser();
  });

  /**
   * Ensure that chains of dimensioned typerefs have the correct number
   * of dimensions, including both local and imported typerefs. As an
   * end-to-end test, this also tests the input generator.
   */
  it("Fuzz example 17 - dimensioned typerefs", async () => {
    const tester = FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testDimensionedTypeRefs",
      {
        ...intOptions,
        argDefaults: {
          ...intOptions.argDefaults,
          dftDimLength: { min: 0, max: 1 },
        },
      }
    );
    const args = tester.env.function.getArgDefs();
    expect(args.length).toBe(2);
    expect(args[0].getDim()).toBe(3);
    expect(args[1].getDim()).toBe(3);

    const results: FuzzTestResult[] = [];
    const fuzzResult = await tester.test(
      [],
      { gen: true },
      undefined,
      undefined,
      (r) => results.push(r)
    );
    const validator = new ArgDefValidator(args);
    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(results.length).not.toBe(0); // Ensure we have results
    results.forEach((result) => {
      const input = result.input.map((i) => i.value);
      expect(
        validator.validate(
          result.input.map((i) => {
            return {
              tag: "ArgValueTypeWrapped",
              value: i.value,
            };
          })
        )
      ).toBeTrue();
      expect(input.length).toBe(2);
      expect(
        ["[]", "[[]]", "[[[]]]", `[[["hello"]]]`].includes(
          ValueMapper.toLang("typescript", input[0])
        )
      ).toBeTrue();
      expect(
        ["[]", "[[]]", "[[[]]]", `[[["goodbye"]]]`].includes(
          ValueMapper.toLang("typescript", input[1])
        )
      ).toBeTrue();
    });
  });

  /**
   * Ensure fuzz targets that mutate their inputs cannot alter
   * the input the fuzzer recorded for the function.
   */
  it("Fuzz target cannot change fuzzer input record", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testChangeInput",
      intOptions
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(results.length).not.toBe(0);
    const resultValue = results[0].input[0].value;
    expect(
      resultValue !== undefined &&
        typeof resultValue === "object" &&
        resultValue !== null &&
        !("b" in resultValue)
    ).toBeTruthy();
  });

  /**
   * Test that `void` functions (standard and arrow) fail the implicit
   * oracle in the case that they return values other than `undefined`
   */
  it("Standard fn void fuzz target fails if return is !==undefined", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testStandardVoidReturnNumber",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBe(0);
  });
  it("Arrow fn void fuzz target fails if return is !==undefined", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testArrowVoidReturnNumber",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBe(0);
  });

  /**
   * Test that `void` functions (standard and arrow) pass the implicit
   * oracle in the case that they only return `undefined`
   */
  it("Standard fn void fuzz target passes if return is undefined", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testStandardVoidReturnUndefined",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBeGreaterThan(0);
  });
  it("Arrow fn void fuzz target passes if return is undefined", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testArrowVoidReturnUndefined",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBeGreaterThan(0);
  });

  /**
   * Test that `void` functions (standard and arrow) fail the implicit
   * oracle when they throw an exception.
   */
  it("Standard fn void fuzz target fails if exception is thrown", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testStandardVoidReturnException",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBe(0);
    expect(fuzzResult.stats.outcomes.exceptions).toEqual(
      fuzzResult.stats.outcomes.total
    );
  });
  it("Arrow fn void fuzz target fails if exception is thrown", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testArrowVoidReturnException",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBe(0);
    expect(fuzzResult.stats.outcomes.exceptions).toEqual(
      fuzzResult.stats.outcomes.total
    );
  });

  /**
   * Test that `void` functions w/literal arguments (standard and arrow) pass
   * when they return undefined.
   */
  it("Standard void literal arg fuzz target", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testStandardVoidLiteralArgs",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBeGreaterThan(0);
  });
  it("Arrow void literal arg fuzz target", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testArrowVoidLiteralArgs",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBeGreaterThan(0);
  });

  /**
   * Test that we can fuzz functions with union arguments.
   */
  it("Standard union arg fuzz target", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testStandardUnionArgs",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBe(0);
  });
  it("Arrow union arg fuzz target", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testArrowUnionArgs",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBe(0);
  });

  /**
   * Test that we can fuzz optional boolean inputs.
   */
  it("Optional boolean inputs", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testBoolean",
      intOptions
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBe(3);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.pass).toBe(3);

    // Run the following tests on the raw and cloned results
    [results, structuredClone(results)].forEach((r) => {
      // Every input should be true, false, or undefined
      expect(
        r.every(
          (e) =>
            e.input.length &&
            (e.input[0].value === undefined ||
              e.input[0].value === true ||
              e.input[0].value === false)
        )
      ).toBeTruthy();
      // Some inputs should be undefined
      expect(
        r.some((e) => e.input.length && e.input[0].value === undefined)
      ).toBeTruthy();
      // Some inputs should be true
      expect(
        r.some((e) => e.input.length && e.input[0].value === true)
      ).toBeTruthy();
      // Some inputs should be false
      expect(
        r.some((e) => e.input.length && e.input[0].value === false)
      ).toBeTruthy();
    });
  });

  it("Issue #301 (Typescript) include object members if value is `undefined`", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "issue301",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(1);
    expect(fuzzResult.stats.outcomes.oracles.heuristic.fail).toEqual(1);
    const firstFailure = fuzzResult.stats.outcomes.firstFailure;
    expect(firstFailure).toBeDefined();
    if (firstFailure) {
      expect(
        ValueMapper.toLang("typescript", firstFailure.input[0].value)
      ).toEqual("6");
      expect(
        typeof firstFailure.output[0].value === "object" &&
          firstFailure.output[0].value !== null &&
          "a" in firstFailure.output[0].value &&
          firstFailure.output[0].value["a"] === undefined
      ).toBeTrue();
      expect(
        ValueMapper.toLang("typescript", firstFailure.output[0].value)
      ).toEqual(`{a: undefined}`);
    }
  });

  it("TypeScript target importing a class from a parent module compiles and runs successfully", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testCoverageOneFile",
      intOptions
    ).test();

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
  });

  it("TypeScript unexported function fuzzing", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testUnexportedFunction",
      intOptions
    ).test([
      {
        input: [
          { name: "x", offset: 0, value: 42, origin: { type: "user" } },
          { name: "y", offset: 1, value: 42, origin: { type: "user" } },
        ],
        output: [],
        pinned: true,
      },
    ]);

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.exceptions).toBeGreaterThan(0);
    const firstFailure = fuzzResult.stats.outcomes.firstFailure;
    expect(firstFailure).toBeDefined();
    expect(firstFailure?.exceptionMessage).toContain("unexported secret hit");
  });

  it("TypeScript unexported arrow function fuzzing via rewire accessor", async () => {
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testUnexportedArrowFunction",
      intOptions
    ).test([
      {
        input: [
          { name: "s", offset: 0, value: "private", origin: { type: "user" } },
        ],
        output: [],
        pinned: true,
      },
    ]);

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.exceptions).toBeGreaterThan(0);
    const firstFailure = fuzzResult.stats.outcomes.firstFailure;
    expect(firstFailure).toBeDefined();
    expect(firstFailure?.exceptionMessage).toContain("unexported arrow hit");
  });

  it("Typescript transformer skip and modify", async () => {
    const skips: FuzzTestResult[] = [];
    const passed: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetTransformed",
      { ...intOptions, maxTests: 200 }
    ).test([], { gen: true }, undefined, undefined, (r) => {
      if (r.category === "skip") skips.push(r);
      if (r.category === "ok") passed.push(r);
    });

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.categories.skip).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.categories.ok).toBeGreaterThan(0);

    // Check skipped inputs
    expect(skips.length).toBeGreaterThan(0);
    skips.forEach((r) => {
      expect(r.skipped).toBeTrue();
      expect(r.skipReason).toContain("skip negative inputs");
    });

    // Check transformed non-skipped inputs
    expect(passed.length).toBeGreaterThan(0);
    passed.forEach((r) => {
      // Since transformer doubled n, the output should be (n * 2) + 1
      const transformedInput = Number(r.input[0].value);
      const actualOutput: unknown = r.output[0].value;
      expect(actualOutput).toBe(transformedInput + 1);

      // Verify FuzzValueOrigin of type transformer
      expect(r.input[0].origin.type).toBe("transformer");
      if (r.input[0].origin.type === "transformer") {
        expect(r.input[0].origin.transformer).toBe(
          "targetTransformedTransformer"
        );
        expect(r.input[0].origin.basis.source.type).toBe("generator");
      }
    });
  });

  it("injected (pinned, saved, and human-generated) inputs bypass input transformer", async () => {
    const injectedInput: FuzzPinnedTest = {
      input: [
        {
          name: "n",
          offset: 0,
          value: 10,
          origin: { type: "user" },
        },
      ],
      output: [],
      pinned: true,
    };

    const results: FuzzTestResult[] = [];
    await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetTransformed",
      { ...intOptions, maxTests: 0 }
    ).test([injectedInput], { gen: true }, undefined, undefined, (r) =>
      results.push(r)
    );

    expect(results.length).toBe(1);
    const injectedResult = results[0];

    // Verify the injected input was NOT skipped by the transformer
    expect(injectedResult.skipped).toBeFalse();

    // Verify the input value was NOT transformed (remains 10, not doubled to 20)
    expect<unknown>(injectedResult.input[0].value).toBe(10);

    // Verify output is targetTransformed(10) => 11 (not 20 + 1 => 21)
    expect<unknown>(injectedResult.output[0].value).toBe(11);

    // Verify origin was preserved as user input rather than changed to transformer
    expect(injectedResult.input[0].origin.type).toBe("user");
  });

  it("records dupeTicks in generator stats when duplicate inputs are generated", async () => {
    // Fuzz a function with small boolean input space to force duplicates
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testBoolean",
      { ...intOptions, maxTests: 50 }
    ).test();

    const randomGenStats = fuzzResult.stats.generators.RandomInputGenerator;
    expect(randomGenStats.counters.dupeTicks).toBeDefined();
    expect(Array.isArray(randomGenStats.counters.dupeTicks)).toBeTrue();
    expect(randomGenStats.counters.dupesGenerated).toBeGreaterThan(0);
    expect(randomGenStats.counters.dupeTicks.length).toBe(
      randomGenStats.counters.dupesGenerated
    );
  });

  it("TypeScript transformer exception", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetTransformedException",
      intOptions
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.categories.failure).toEqual(
      fuzzResult.stats.outcomes.total
    );
    results.forEach((r) => {
      expect(r.harnessErrors.length).toBeGreaterThan(0);
      expect(r.harnessErrors[0].message).toContain("Transformer error message");
      expect(r.category).toBe("failure");
    });
  });

  it("TypeScript transformer timeout", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetTransformedTimeout",
      { ...intOptions, maxTests: 2 }
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

  it("dupe check transformer inputs", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetTransformedDupeCheck",
      { ...intOptions, maxTests: 50 }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    // There are only 2 booleans (true/false).
    // The transformer throws if called more than twice.
    // If pre-transformer deduplication works, at most 2 inputs will be transformed
    // and no transformer exception will occur.
    expect(fuzzResult.stats.outcomes.total).toBe(2);
    expect(fuzzResult.stats.counters.dupesGenerated).toBeGreaterThan(0);
    results.forEach((r) => {
      expect(r.harnessErrors.length).toBe(0);
      expect(r.category).toBe("ok");
    });
  });

  it("deduplicates transformed inputs after transformer collapses distinct inputs", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetTransformedCollapsing",
      { ...intOptions, maxTests: 50 }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    // Transformer maps all inputs to 42. Post-transformer dupe check should ensure
    // only 1 unique test output result exists despite generating many inputs.
    expect(results.length).toBe(1);
    expect<unknown>(results[0].input[0].value).toBe(42);
    expect(fuzzResult.stats.counters.dupesGenerated).toBeGreaterThan(0);
  });

  it("Typescript UserInputGenerator generation, origin tagging, and execution", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetUserGen",
      {
        ...intOptions,
        maxTests: 20,
        generators: {
          RandomInputGenerator: { enabled: false },
          MutationInputGenerator: { enabled: false },
          AiInputGenerator: { enabled: false },
          UserInputGenerator: { enabled: true },
        },
      }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.categories.ok).toBeGreaterThan(0);

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
      expect(coveredFnNames).toContain("targetUserGen");
      expect(coveredFnNames).toContain("targetUserGenGenerator");
    }
  });

  it("Typescript UserInputGenerator exhaustion", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetUserGenFinite",
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

  it("Typescript UserInputGenerator exception stops testing with crash", async () => {
    let caughtError: unknown;
    try {
      await FuzzerFactory(
        "./test_fixtures/Fuzzer.testfixtures.ts",
        "targetUserGenException",
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
      expect(caughtError.message).toContain("User generator error message");
    }
  });

  it("Typescript UserInputGenerator UnsatisfiedAssumption crashes", async () => {
    let caughtError: unknown;
    try {
      await FuzzerFactory(
        "./test_fixtures/Fuzzer.testfixtures.ts",
        "targetUserGenAssumption",
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

  it("TypeScript validator exception", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetValidatorException",
      { ...intOptions, useProperty: true, maxTests: 2 }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.categories.failure).toEqual(
      fuzzResult.stats.outcomes.total
    );
    results.forEach((r) => {
      expect(r.harnessErrors.length).toBeGreaterThan(0);
      expect(r.harnessErrors[0].fnName).toBe(
        "targetValidatorExceptionValidator"
      );
      expect(r.harnessErrors[0].message).toContain("Validator error message");
      expect(r.category).toBe("failure");
    });
  });

  it("TypeScript validator timeout", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetValidatorTimeout",
      { ...intOptions, useProperty: true, maxTests: 2 }
    ).test([], { gen: true }, undefined, undefined, (r) => results.push(r));

    expect(fuzzResult.stats.outcomes.total).toBeGreaterThan(0);
    expect(fuzzResult.stats.outcomes.categories.failure).toEqual(
      fuzzResult.stats.outcomes.total
    );
    results.forEach((r) => {
      expect(r.harnessErrors.length).toBeGreaterThan(0);
      expect(r.harnessErrors[0].fnName).toBe("targetValidatorTimeoutValidator");
      expect(r.harnessErrors[0].kind).toBe("timeout");
      expect(r.category).toBe("failure");
    });
  });

  it("TypeScript async fuzz target with async property validator", async () => {
    const results: FuzzTestResult[] = [];
    const fuzzResult = await FuzzerFactory(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testAsyncGreeting",
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
      expect(coveredFnNames).toContain("testAsyncGreeting");
      expect(
        coveredFnNames.some(
          (name) => name && name.includes("testAsyncGreetingValidator")
        )
      ).toBeTrue();
    }
  });

  it("TypeScript BigInt target with property validator and pin", async () => {
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
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testBigIntTarget",
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
    const pinnedRes = results.find((r) => r.input[0].value === 42n);
    expect(pinnedRes).toBeDefined();
    expect(pinnedRes?.exception).toBeTrue();
    expect(
      results.every(
        (r) =>
          r.input.length === 1 &&
          typeof r.input[0].value === "bigint" &&
          (r.exception || typeof r.output[0].value === "bigint")
      )
    ).toBeTrue();
  });
});
