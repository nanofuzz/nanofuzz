import { ArgDef, Tester } from "./Fuzzer";
import { TypeScriptCompiler } from "./Compiler";
import { FuzzOptions } from "./Types";
import * as JSON5 from "json5";
import { ArgDefValidator } from "./analysis/typescript/ArgDefValidator";

// Extend default test timeout to 60s
jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

// Clean up prior testing temporary files, like compiler output,
// so that we actually run the compiler during testing
new TypeScriptCompiler(require.resolve("nanofuzz-study/examples/3.ts")).clean();

/**
 * Fuzzer option for enabling all Measures
 */
const allMeasures = {
  FailedTestMeasure: {
    enabled: true,
    weight: 1,
  },
  CoverageMeasure: {
    enabled: true,
    weight: 1,
  },
};

/**
 * Fuzzer option for enabling all Generators
 */
const allGenerators = {
  RandomInputGenerator: {
    enabled: true,
  },
  MutationInputGenerator: {
    enabled: true,
  },
  AiInputGenerator: {
    enabled: true,
  },
};

/**
 * Fuzzer option for integer arguments and a seed for deterministic test execution.
 */
const intOptions: FuzzOptions = {
  argDefaults: ArgDef.getDefaultOptions(),
  maxTests: 1000,
  fnTimeout: 100,
  suiteTimeout: 0,
  seed: "qwertyuiop",
  maxDupeInputs: 1000,
  maxFailures: 0,
  useImplicit: true,
  useHuman: true,
  useProperty: false,
  measures: allMeasures,
  generators: allGenerators,
};

/**
 * Fuzzer option for float arguments and a seed for deterministic test execution.
 */
const floatOptions: FuzzOptions = {
  ...intOptions,
  argDefaults: ArgDef.getDefaultFloatOptions(),
};

/**
 * These tests currently just ensure that the fuzzer runs and produces output
 * for each example. TODO: Add tests that check the fuzzer output.
 */
describe("fuzzer:", () => {
  it("Fuzz example 01 - minValue", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/1.ts",
        "minValue",
        intOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 02 - getSortSetting", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/2.ts",
        "getSortSetting",
        intOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 03 - totalDinnerExpenses", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/3.ts",
        "totalDinnerExpenses",
        floatOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 04 - maxOfArray", () => {
    expect(
      new Tester("nanofuzz-study/examples/4.ts", "maxOfArray", {
        ...intOptions,
        argDefaults: { ...intOptions.argDefaults, anyDims: 1 },
      }).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 05 - getRandomNumber", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/5.ts",
        "getRandomNumber",
        intOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 06 - getZero", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/6.ts",
        "getZero",
        intOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 07 - sortByWinLoss", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/7.ts",
        "sortByWinLoss",
        intOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 08 - minSalary", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/8.ts",
        "minSalary",
        intOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 09 - getOffsetOrDefault", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/9.ts",
        "getOffsetOrDefault",
        intOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  // TODO: Vector length is randomized here - probably do not want that !!!
  it("Fuzz example 10 - gramSchmidt", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/10.ts",
        "gramSchmidt",
        intOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 11 - idMatrix", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/11.ts",
        "idMatrix",
        intOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 12 - levenshtein", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/12.ts",
        "levenshtein",
        intOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 13 - isSteady", () => {
    expect(
      new Tester(
        "nanofuzz-study/examples/13.ts",
        "isSteady",
        intOptions
      ).testSync().results.length
    ).not.toBe(0);
  });

  it("Fuzz example 14 - modInv", () => {
    const fuzzResult = new Tester("nanofuzz-study/examples/14.ts", "modInv", {
      ...intOptions,
      suiteTimeout: 3000,
    }).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.timeout)).toBe(true);
  });

  it("Fuzz example 15 - coverageOneFile", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testCoverageOneFile",
      {
        ...intOptions,
        useProperty: true,
        maxTests: 12000,
        argDefaults: {
          ...intOptions.argDefaults,
          strLength: {
            min: 4,
            max: 4,
          },
        },
      }
    ).testSync();

    expect(fuzzResult.results.length).toBeGreaterThan(0); // Expect some results
    expect(fuzzResult.results.every((e) => e.passedImplicit)).toBeTruthy(); // Expect all implicit validation to pass

    // Expect that we generate input "bugs" within 12k input generations
    expect(
      fuzzResult.results.some((e) => e.input[0].value === "bugs")
    ).toBeTruthy();

    // Expect that most of the validtor tests will pass
    expect(
      fuzzResult.results.some((e) => e.passedValidators?.some((v) => v))
    ).toBeTruthy();

    // But expect that "bugs" should fail (as would "bug!" and "moth")
    expect(
      fuzzResult.results.some((e) => e.passedValidators?.some((v) => !v))
    ).toBeTruthy();
  });

  it("Fuzz example 16 - coverageMultiFile", async () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testCoverageMultiFile",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0); // Ensure we have results
    expect(fuzzResult.results.every((e) => e.passedImplicit)).toBeTruthy(); // Expect all implicit validation to pass
    expect(fuzzResult.stats.measures.CodeCoverageMeasure).toBeDefined(); // Has coverage stats
    if (fuzzResult.stats.measures.CodeCoverageMeasure) {
      const coverageStats =
        await fuzzResult.stats.measures.CodeCoverageMeasure();
      // Expect coverage of >1 source files
      expect(coverageStats.files.length).toBeGreaterThan(1);
      // Expect coverage of 2 functions (one in each source file)
      expect(coverageStats.counters.functionsCovered).toBe(2);
      // Expect coverage of 2 statements across 2 files, 2 functions
      expect(coverageStats.counters.statementsCovered).toBeGreaterThan(1);
      // Expect coverage of 1 branch across 2 files, 2 functions
      expect(coverageStats.counters.branchesCovered).toBeGreaterThan(0);
    }
  });

  /**
   * Ensure that chains of dimensioned typerefs have the correct number
   * of dimensions, including both local and imported typerefs. As an
   * end-to-end test, this also tests the input generator.
   */
  it("Fuzz example 17 - dimensioned typerefs", () => {
    const tester = new Tester(
      "./Fuzzer.testfixtures.ts",
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

    const fuzzResult = tester.testSync();
    const validator = new ArgDefValidator(args);
    expect(fuzzResult.results.length).not.toBe(0); // Ensure we have results
    fuzzResult.results.forEach((result) => {
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
        ["[]", "[[]]", "[[[]]]", "[[['hello']]]"].includes(
          JSON5.stringify(input[0])
        )
      ).toBeTrue();
      expect(
        ["[]", "[[]]", "[[[]]]", "[[['goodbye']]]"].includes(
          JSON5.stringify(input[1])
        )
      ).toBeTrue();
    });
  });

  /**
   * Ensure fuzz targets that mutate their inputs cannot alter
   * the input the fuzzer recorded for the function.
   */
  it("Fuzz target cannot change fuzzer input record", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testChangeInput",
      intOptions
    ).testSync();

    const resultValue = fuzzResult.results[0].input[0].value;
    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      resultValue !== undefined &&
        typeof resultValue === "object" &&
        !("b" in resultValue)
    ).toBeTruthy();
  });

  /**
   * Test that `void` functions (standard and arrow) fail the implicit
   * oracle in the case that they return values other than `undefined`
   */
  it("Standard fn void fuzz target fails if return is !==undefined", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testStandardVoidReturnNumber",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
  });
  it("Arrow fn void fuzz target fails if return is !==undefined", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testArrowVoidReturnNumber",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
  });

  /**
   * Test that `void` functions (standard and arrow) pass the implicit
   * oracle in the case that they only return `undefined`
   */
  it("Standard fn void fuzz target passes if return is undefined", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testStandardVoidReturnUndefined",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeTruthy();
  });
  it("Arrow fn void fuzz target passes if return is undefined", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testArrowVoidReturnUndefined",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeTruthy();
  });

  /**
   * Test that `void` functions (standard and arrow) fail the implicit
   * oracle when they throw an exception.
   */
  it("Standard fn void fuzz target fails if exception is thrown", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testStandardVoidReturnException",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
    expect(fuzzResult.results.every((e) => e.exception)).toBeTruthy();
  });
  it("Arrow fn void fuzz target fails if exception is thrown", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testArrowVoidReturnException",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
    expect(fuzzResult.results.every((e) => e.exception)).toBeTruthy();
  });

  /**
   * Test that `void` functions w/literal arguments (standard and arrow) pass
   * when they return undefined.
   */
  it("Standard void literal arg fuzz target", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testStandardVoidLiteralArgs",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeTruthy();
  });
  it("Arrow void literal arg fuzz target", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testArrowVoidLiteralArgs",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeTruthy();
  });

  /**
   * Test that we can fuzz functions with union arguments.
   */
  it("Standard union arg fuzz target", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testStandardUnionArgs",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
  });
  it("Arrow union arg fuzz target", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testArrowUnionArgs",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
  });

  /**
   * Test that we can fuzz optional boolean inputs.
   */
  it("Optional boolean inputs", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testBoolean",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).toBe(3);
    expect(fuzzResult.results.every((e) => e.passedImplicit)).toBeTruthy();

    // Run the following tests on the raw and JSON5-cloned results
    [
      fuzzResult.results,
      JSON5.parse<typeof fuzzResult.results>(
        JSON5.stringify(fuzzResult.results)
      ),
    ].forEach((r) => {
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
});
