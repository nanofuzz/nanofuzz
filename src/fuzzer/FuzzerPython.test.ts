import { Tester } from "./Fuzzer";
import { intOptions, initParser } from "./FuzzerTestHelper";
import * as ValueMapper from "./mappers/ValueMapper";
import { FuzzPinnedTest } from "./Types";

describe("fuzzer: python targets", () => {
  beforeAll(async () => {
    await initParser();
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
      expect(r.passedImplicit).toBe("unknown");
      expect(r.skipReason).toContain("n cannot be 5");
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

    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "py_transformed",
      { ...intOptions, maxTests: 0 }
    ).testSync([injectedInput]);

    expect(fuzzResult.results.length).toBe(1);
    const injectedResult = fuzzResult.results[0];

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
    const fuzzResult = await new Tester(
      "./test_fixtures/Fuzzer.testfixtures.py",
      "py_transformed_exception",
      intOptions
    ).testSync();

    expect(fuzzResult.results.length).toBeGreaterThan(0);
    fuzzResult.results.forEach((r) => {
      expect(r.harnessErrors.length).toBeGreaterThan(0);
      expect(r.harnessErrors[0].message).toContain("Python transformer error");
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
      expect(r.harnessErrors.length).toBeGreaterThan(0);
      expect(r.harnessErrors[0].kind).toBe("timeout");
      expect(r.category).toBe("failure");
    });
  });
});
