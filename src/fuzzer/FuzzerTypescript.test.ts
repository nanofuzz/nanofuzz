import { Tester } from "./Fuzzer";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { ArgDefValidator } from "./analysis/ArgDefValidator";
import * as ValueMapper from "./mappers/ValueMapper";

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
});
