import { ArgDef, Tester } from "./Fuzzer";
import { FuzzOptions } from "./Types";
import * as CompilerFactory from "./compilers/CompilerFactory";
import * as ValueMapper from "./mappers/ValueMapper";
import { ArgDefValidator } from "./analysis/ArgDefValidator";
import * as Parser from "./adapters/ParserAdapter";
import { getToolVersion } from "../ToolVersion";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as JSONN from "../Jsonn";

// Extend default test timeout to 60s
jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

// Clean up prior testing temporary files, like compiler output,
// so that we actually run the compiler during testing
CompilerFactory.clean();

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
  useTransformer: true,
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
  argDefaults: {
    ...ArgDef.getDefaultOptions(),
    numInteger: false,
  },
};

/**
 * These tests currently just ensure that the fuzzer runs and produces output
 * for each example. TODO: Add tests that check the fuzzer output.
 */
describe("fuzzer:", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("includes the tool version in initialized and persisted results", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-version-"));
    const outputFile = path.join(tmpdir, "results.json5");

    try {
      const results = await new Tester(
        "nanofuzz-study/examples/1.ts",
        "minValue",
        { ...intOptions, maxTests: 1, outputFile }
      ).testSync();
      const persisted = JSONN.parse(fs.readFileSync(outputFile, "utf8"));

      expect(results.toolVersion).toBe(getToolVersion());
      expect(persisted).toEqual(
        jasmine.objectContaining({ toolVersion: getToolVersion() })
      );
    } finally {
      fs.rmSync(tmpdir, { recursive: true });
    }
  });

  it("Fuzz example 01 - minValue", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/1.ts",
          "minValue",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 02 - getSortSetting", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/2.ts",
          "getSortSetting",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 03 - totalDinnerExpenses", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/3.ts",
          "totalDinnerExpenses",
          floatOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 04 - maxOfArray", async () => {
    expect(
      (
        await new Tester("nanofuzz-study/examples/4.ts", "maxOfArray", {
          ...intOptions,
          argDefaults: { ...intOptions.argDefaults, anyDims: 1 },
        }).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 05 - getRandomNumber", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/5.ts",
          "getRandomNumber",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 06 - getZero", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/6.ts",
          "getZero",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 07 - sortByWinLoss", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/7.ts",
          "sortByWinLoss",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 08 - minSalary", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/8.ts",
          "minSalary",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 09 - getOffsetOrDefault", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/9.ts",
          "getOffsetOrDefault",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  // TODO: Vector length is randomized here - probably do not want that !!!
  it("Fuzz example 10 - gramSchmidt", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/10.ts",
          "gramSchmidt",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 11 - idMatrix", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/11.ts",
          "idMatrix",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 12 - levenshtein", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/12.ts",
          "levenshtein",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 13 - isSteady", async () => {
    expect(
      (
        await new Tester(
          "nanofuzz-study/examples/13.ts",
          "isSteady",
          intOptions
        ).testSync()
      ).results.length
    ).not.toBe(0);
  });

  it("Fuzz example 14 - modInv", async () => {
    const fuzzResult = await new Tester(
      "nanofuzz-study/examples/14.ts",
      "modInv",
      {
        ...intOptions,
        suiteTimeout: 3000,
      }
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.some((e) => e.timeout)).toBe(true);
  });

  it("Fuzz example 15 - coverageOneFile", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
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
    expect(
      fuzzResult.results.every((e) => e.passedImplicit === "pass")
    ).toBeTruthy(); // Expect all implicit validation to pass

    // Expect that we generate input "bugs" within 12k input generations
    expect(
      fuzzResult.results.some((e) => e.input[0].value === "bugs")
    ).toBeTruthy();

    // Expect that some of the validator tests will pass
    expect(
      fuzzResult.results.some((e) =>
        e.passedValidators.some((v) => v === "pass")
      )
    ).toBeTruthy();

    // But expect that "bugs" should fail (as would "bug!" and "moth")
    expect(
      fuzzResult.results.some((e) =>
        e.passedValidators.some((v) => v === "fail")
      )
    ).toBeTruthy();
  });

  it("Fuzz example 16 - coverageMultiFile", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testCoverageMultiFile",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0); // Ensure we have results
    expect(
      fuzzResult.results.every((e) => e.passedImplicit === "pass")
    ).toBeTruthy(); // Expect all implicit validation to pass
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
  it("Fuzz example 17 - dimensioned typerefs", async () => {
    const tester = new Tester(
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

    const fuzzResult = await tester.testSync();
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
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testChangeInput",
      intOptions
    ).testSync();

    const resultValue = fuzzResult.results[0].input[0].value;
    expect(fuzzResult.results.length).not.toBe(0);
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
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testStandardVoidReturnNumber",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeFalsy();
  });
  it("Arrow fn void fuzz target fails if return is !==undefined", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testArrowVoidReturnNumber",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeFalsy();
  });

  /**
   * Test that `void` functions (standard and arrow) pass the implicit
   * oracle in the case that they only return `undefined`
   */
  it("Standard fn void fuzz target passes if return is undefined", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testStandardVoidReturnUndefined",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeTruthy();
  });
  it("Arrow fn void fuzz target passes if return is undefined", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testArrowVoidReturnUndefined",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeTruthy();
  });

  /**
   * Test that `void` functions (standard and arrow) fail the implicit
   * oracle when they throw an exception.
   */
  it("Standard fn void fuzz target fails if exception is thrown", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testStandardVoidReturnException",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeFalsy();
    expect(fuzzResult.results.every((e) => e.exception)).toBeTruthy();
  });
  it("Arrow fn void fuzz target fails if exception is thrown", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testArrowVoidReturnException",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeFalsy();
    expect(fuzzResult.results.every((e) => e.exception)).toBeTruthy();
  });

  /**
   * Test that `void` functions w/literal arguments (standard and arrow) pass
   * when they return undefined.
   */
  it("Standard void literal arg fuzz target", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testStandardVoidLiteralArgs",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeTruthy();
  });
  it("Arrow void literal arg fuzz target", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testArrowVoidLiteralArgs",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeTruthy();
  });

  /**
   * Test that we can fuzz functions with union arguments.
   */
  it("Standard union arg fuzz target", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testStandardUnionArgs",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeFalsy();
  });
  it("Arrow union arg fuzz target", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testArrowUnionArgs",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeFalsy();
  });

  /**
   * Test that we can fuzz optional boolean inputs.
   */
  it("Optional boolean inputs", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testBoolean",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).toBe(3);
    expect(
      fuzzResult.results.every((e) => e.passedImplicit === "pass")
    ).toBeTruthy();

    // Run the following tests on the raw and cloned results
    [fuzzResult.results, structuredClone(fuzzResult.results)].forEach((r) => {
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

  it("Python string input and property test", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "greeting",
      {
        ...intOptions,
        useProperty: true,
        suiteTimeout: 3000,
      }
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.every((e) => e.passedImplicit === "pass")
    ).toBeTrue();
    expect(
      fuzzResult.results.every(
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
    fuzzResult.results.forEach((r) => {
      expect(r.passedValidators.length).toBe(1);
      expect(r.validatorException).toBeFalse();
      expect(r.passedValidator).toBe("pass");
    });
  });

  it("Python timeouts", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "timeouts",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeTrue();
    expect(fuzzResult.results.some((e) => e.timeout)).toBeTrue();
  });

  it("Python exceptions", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "throws",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(
      fuzzResult.results.some((e) => e.passedImplicit === "pass")
    ).toBeTrue();
    expect(fuzzResult.results.some((e) => e.exception)).toBeTrue();
  });

  it("Python valid target in invalid file", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures2.py",
      "valid",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).not.toBe(0);
    expect(fuzzResult.results.every((e) => e.exception)).toBeTrue();
  });

  it("Python invalid target in invalid file", async () => {
    expect(() => {
      new Tester(
        "./test_fixtures/Fuzzer.testfixtures2.py",
        "invalid",
        intOptions
      ).testSync();
    }).toThrowError();
  });

  it("Issue #301 (Python) include object members if value is `None`", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "issue301",
      intOptions
    ).testSync();

    const failures = fuzzResult.results.filter(
      (r) => r.passedImplicit === "fail"
    );

    expect(fuzzResult.results.length).toBeGreaterThan(1);
    expect(failures.length).toEqual(1);
    expect(ValueMapper.toLang("python", failures[0].input[0].value)).toEqual(
      "6"
    );
    expect(
      typeof failures[0].output[0].value === "object" &&
        failures[0].output[0].value !== null &&
        "a" in failures[0].output[0].value &&
        failures[0].output[0].value["a"] === null
    ).toBeTrue();
    expect(ValueMapper.toLang("python", failures[0].output[0].value)).toEqual(
      `{"a": None}`
    );
  });

  it("Issue #301 (Typescript) include object members if value is `undefined`", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "issue301",
      intOptions
    ).testSync();

    const failures = fuzzResult.results.filter(
      (r) => r.passedImplicit === "fail"
    );

    expect(fuzzResult.results.length).toBeGreaterThan(1);
    expect(failures.length).toEqual(1);
    expect(
      ValueMapper.toLang("typescript", failures[0].input[0].value)
    ).toEqual("6");
    expect(
      typeof failures[0].output[0].value === "object" &&
        failures[0].output[0].value !== null &&
        "a" in failures[0].output[0].value &&
        failures[0].output[0].value["a"] === undefined
    ).toBeTrue();
    expect(
      ValueMapper.toLang("typescript", failures[0].output[0].value)
    ).toEqual(`{a: undefined}`);
  });

  it("Python assume statement (skipped tests)", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "with_assume",
      {
        ...intOptions,
        maxTests: 200, // Make sure we generate enough tests to hit n = 5
      }
    ).testSync();

    const skips = fuzzResult.results.filter((r) => r.category === "skip");

    expect(skips.length).toBeGreaterThan(0);
    skips.forEach((r) => {
      expect(r.skipped).toBeTrue();
      expect(r.skipReason).toContain("n cannot be 5");
    });
  });

  it("TypeScript target importing a class from a parent module compiles and runs successfully", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "testCoverageOneFile",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).toBeGreaterThan(0);
  });

  it("Typescript transformer skip and modify", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetTransformed",
      { ...intOptions, maxTests: 200 }
    ).testSync();

    expect(fuzzResult.results.length).toBeGreaterThan(0);

    // Check skipped inputs
    const skips = fuzzResult.results.filter((r) => r.category === "skip");
    expect(skips.length).toBeGreaterThan(0);
    skips.forEach((r) => {
      expect(r.skipped).toBeTrue();
      expect(r.skipReason).toContain("skip negative inputs");
    });

    // Check transformed non-skipped inputs
    const passed = fuzzResult.results.filter((r) => r.category === "ok");
    expect(passed.length).toBeGreaterThan(0);
    passed.forEach((r) => {
      // Since transformer doubled n, the output should be (n * 2) + 1
      const transformedInput = Number(r.input[0].value);
      const actualOutput: unknown = r.output[0].value;
      expect(actualOutput).toBe(transformedInput + 1);
    });
  });

  it("TypeScript transformer exception", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetTransformedException",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).toBeGreaterThan(0);
    fuzzResult.results.forEach((r) => {
      expect(r.validatorException).toBeTrue();
      expect(r.validatorExceptionMessage).toContain(
        "Transformer error message"
      );
      expect(r.category).toBe("failure");
    });
  });

  it("TypeScript transformer timeout", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.ts",
      "targetTransformedTimeout",
      { ...intOptions, maxTests: 2 }
    ).testSync();

    expect(fuzzResult.results.length).toBeGreaterThan(0);
    fuzzResult.results.forEach((r) => {
      expect(r.validatorException).toBeTrue();
      expect(r.validatorExceptionMessage).toBe("timeout");
      expect(r.category).toBe("failure");
    });
  });

  it("Python transformer input transformation, skips, and null return", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "py_transformed",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).toBeGreaterThan(0);

    const skips = fuzzResult.results.filter((r) => r.category === "skip");
    expect(skips.length).toBeGreaterThan(0);
    skips.forEach((r) => {
      expect(r.skipped).toBeTrue();
    });

    const passed = fuzzResult.results.filter((r) => r.category === "ok");
    expect(passed.length).toBeGreaterThan(0);
    passed.forEach((r) => {
      const transformedInput = Number(r.input[0].value);
      const actualOutput: unknown = r.output[0].value;
      expect(actualOutput).toBe(transformedInput + 1);
    });
  });

  it("Python transformer exception", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "py_transformed_exception",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).toBeGreaterThan(0);
    fuzzResult.results.forEach((r) => {
      expect(r.validatorException).toBeTrue();
      expect(r.validatorExceptionMessage).toContain("Python transformer error");
      expect(r.category).toBe("failure");
    });
  });

  it("Python transformer timeout", async () => {
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "py_transformed_timeout",
      {
        ...intOptions,
        maxTests: 2,
      }
    ).testSync();

    expect(fuzzResult.results.length).toBeGreaterThan(0);
    fuzzResult.results.forEach((r) => {
      expect(r.validatorException).toBeTrue();
      expect(r.validatorExceptionMessage).toBe("timeout");
      expect(r.category).toBe("failure");
    });
  });
});
