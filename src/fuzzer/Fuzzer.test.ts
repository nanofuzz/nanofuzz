import { ArgDef, Tester, implicitOracle } from "./Fuzzer";
import { FuzzOptions } from "./Types";
import * as JSON5 from "json5";

// Extend default test timeout to 45s
jasmine.DEFAULT_TIMEOUT_INTERVAL = 45000;

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
  suiteTimeout: 10000,
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
  it("Implicit Oracle - NaN", () => {
    expect(implicitOracle(NaN)).toBe(false);
  });

  it("Implicit Oracle - +Infinity", () => {
    expect(implicitOracle(Infinity)).toBe(false);
  });

  it("Implicit Oracle - -Infinity", () => {
    expect(implicitOracle(-Infinity)).toBe(false);
  });

  it("Implicit Oracle - null", () => {
    expect(implicitOracle(null)).toBe(false);
  });

  it("Implicit Oracle - undefined", () => {
    expect(implicitOracle(undefined)).toBe(false);
  });

  it("Implicit Oracle - ''", () => {
    expect(implicitOracle("")).toBe(true);
  });

  it("Implicit Oracle - 0", () => {
    expect(implicitOracle(0)).toBe(true);
  });

  it("Implicit Oracle - -1", () => {
    expect(implicitOracle(-1)).toBe(true);
  });

  it("Implicit Oracle - 1", () => {
    expect(implicitOracle(1)).toBe(true);
  });

  it("Implicit Oracle - 'xyz'", () => {
    expect(implicitOracle("xyz")).toBe(true);
  });

  it("Implicit Oracle - []", () => {
    expect(implicitOracle([])).toBe(true);
  });

  it("Implicit Oracle - [1]", () => {
    expect(implicitOracle([1])).toBe(true);
  });

  it("Implicit Oracle - [[]]", () => {
    expect(implicitOracle([[]])).toBe(true);
  });

  it("Implicit Oracle - [[1]]", () => {
    expect(implicitOracle([[]])).toBe(true);
  });

  it("Implicit Oracle - [null,1]", () => {
    expect(implicitOracle([null, 1])).toBe(false);
  });

  it("Implicit Oracle - [1,undefined]", () => {
    expect(implicitOracle([1, undefined])).toBe(false);
  });

  it("Implicit Oracle - [NaN,1]", () => {
    expect(implicitOracle([NaN, 1])).toBe(false);
  });

  it("Implicit Oracle - [1,Infinity]", () => {
    expect(implicitOracle([1, Infinity])).toBe(false);
  });

  it("Implicit Oracle - [-Infinity,1]", () => {
    expect(implicitOracle([-Infinity, 1])).toBe(false);
  });

  it("Implicit Oracle - [[null,1],1]", () => {
    expect(implicitOracle([[null, 1], 1])).toBe(false);
  });

  it("Implicit Oracle - [1,[undefined,1]]", () => {
    expect(implicitOracle([1, [undefined, 1]])).toBe(false);
  });

  it("Implicit Oracle - [[NaN,1],1]", () => {
    expect(implicitOracle([[NaN, 1], 1])).toBe(false);
  });

  it("Implicit Oracle - [1,[1,Infinity]]", () => {
    expect(implicitOracle([1, [1, Infinity]])).toBe(false);
  });

  it("Implicit Oracle - [[1,-Infinity],1]", () => {
    expect(implicitOracle([[1, -Infinity], 1])).toBe(false);
  });

  it("Implicit Oracle - {}", () => {
    expect(implicitOracle({})).toBe(true);
  });

  it("Implicit Oracle - {a: 'abc', b: 123}", () => {
    expect(implicitOracle({ a: "abc", b: 123 })).toBe(true);
  });

  it("Implicit Oracle - {a:null, b:1}", () => {
    expect(implicitOracle({ a: null, b: 1 })).toBe(false);
  });

  it("Implicit Oracle - {a:1, b:undefined}", () => {
    expect(implicitOracle({ a: 1, b: undefined })).toBe(false);
  });

  it("Implicit Oracle - {a:1, b:NaN}", () => {
    expect(implicitOracle({ a: 1, b: NaN })).toBe(false);
  });

  it("Implicit Oracle - {a:1, b:Infinity}", () => {
    expect(implicitOracle({ a: 1, b: Infinity })).toBe(false);
  });

  it("Implicit Oracle - {a:-Infinity, b:1}", () => {
    expect(implicitOracle({ a: -Infinity, b: 1 })).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:null}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: null }], b: 1 }])).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:NaN}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: NaN }], b: 1 }])).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:Infinity}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: Infinity }], b: 1 }])).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:-Infinity}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: -Infinity }], b: 1 }])).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:undefined}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: undefined }], b: 1 }])).toBe(false);
  });

  it("Implicit Oracle - [{a:[{c:2}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: 2 }], b: 1 }])).toBe(true);
  });

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
    const fuzzResult = new Tester(
      "nanofuzz-study/examples/14.ts",
      "modInv",
      intOptions
    ).testSync();

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
        suiteTimeout: 30000,
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

  it("Fuzz example 16 - coverageMultiFile", () => {
    const fuzzResult = new Tester(
      "./Fuzzer.testfixtures.ts",
      "testCoverageMultiFile",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0); // Ensure we have results
    expect(fuzzResult.results.every((e) => e.passedImplicit)).toBeTruthy(); // Expect all implicit validation to pass
    expect(fuzzResult.stats.measures.CodeCoverageMeasure).toBeDefined(); // Has coverage stats
    if (fuzzResult.stats.measures.CodeCoverageMeasure) {
      // Expect coverage of >1 source files
      expect(
        fuzzResult.stats.measures.CodeCoverageMeasure.files.length
      ).toBeGreaterThan(1);
      // Expect coverage of 2 functions (one in each source file)
      expect(
        fuzzResult.stats.measures.CodeCoverageMeasure.counters.functionsCovered
      ).toBe(2);
      // Expect coverage of 2 statements across 2 files, 2 functions
      expect(
        fuzzResult.stats.measures.CodeCoverageMeasure.counters.statementsCovered
      ).toBeGreaterThan(1);
      // Expect coverage of 1 branch across 2 files, 2 functions
      expect(
        fuzzResult.stats.measures.CodeCoverageMeasure.counters.branchesCovered
      ).toBeGreaterThan(0);
    }
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
      JSON5.parse(JSON5.stringify(fuzzResult.results)),
    ].forEach((r) => {
      // Every input should be true, false, or undefined
      expect(
        fuzzResult.results.every(
          (e) =>
            e.input.length &&
            (e.input[0].value === undefined ||
              e.input[0].value === true ||
              e.input[0].value === false)
        )
      ).toBeTruthy();
      // Some inputs should be undefined
      expect(
        fuzzResult.results.some(
          (e) => e.input.length && e.input[0].value === undefined
        )
      ).toBeTruthy();
      // Some inputs should be true
      expect(
        fuzzResult.results.some(
          (e) => e.input.length && e.input[0].value === true
        )
      ).toBeTruthy();
      // Some inputs should be false
      expect(
        fuzzResult.results.some(
          (e) => e.input.length && e.input[0].value === false
        )
      ).toBeTruthy();
    });
  });
});
