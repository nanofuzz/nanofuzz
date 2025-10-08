import { ArgDef, setup, fuzz, implicitOracle } from "./Fuzzer";
import { FuzzOptions } from "./Types";

/**
 * Fuzzer option for integer arguments and a seed for deterministic test execution.
 */
const intOptions: FuzzOptions = {
  argDefaults: ArgDef.getDefaultOptions(),
  maxTests: 1000,
  fnTimeout: 100,
  suiteTimeout: 3000,
  seed: "qwertyuiop",
  maxDupeInputs: 1000,
  maxFailures: 0,
  onlyFailures: false,
  useImplicit: true,
  useHuman: true,
  useProperty: false,
};

/**
 * Fuzzer option for float arguments and a seed for deterministic test execution.
 */
const floatOptions: FuzzOptions = {
  ...intOptions,
  argDefaults: ArgDef.getDefaultFloatOptions(),
};

/**
 * Fuzzer options for counter-example mode
 */
const counterExampleOptions: FuzzOptions = {
  ...intOptions,
  maxFailures: 1,
  onlyFailures: true,
};

/**
 * Fuzz target that alters its input - used to verify
 * that recorded fuzzer input is not altered by the target
 */
export function testChangeInput(obj: { a: number }) {
  (obj as any).b = 1;
}

/**
 * Fuzz targets with return type `void` that returns undefined
 */
export function testStandardVoidReturnUndefined(x: number): void {
  const y = x - 1;
}
export const testArrowVoidReturnUndefined = (x: number): void => {
  const y = x - 1;
};

/**
 * Fuzz targets with return type `void` that returns number
 */
export function testStandardVoidReturnNumber(x: number): void {
  const y: unknown = x;
  return y as void;
}
export const testArrowVoidReturnNumber = (x: number): void => {
  const y: unknown = x;
  return y as void;
};

/**
 * Fuzz targets with return type `void` that throw an exception
 */
export function testStandardVoidReturnException(x: number): void {
  throw new Error("Random error");
}
export const testArrowVoidReturnException = (x: number): void => {
  throw new Error("Random error");
};

/**
 * Fuzz targets with literal arguments
 */
export function testStandardVoidLiteralArgs(n: 5, n2: 5[]): void {
  return;
}
export const testArrowVoidLiteralArgs = (n: 5, n2: 5[]): void => {
  return;
};

/**
 * Fuzz targets with union arguments
 */
type hellos = "hello" | "bonjour" | "olá" | "ciao" | "hej";
type stringOrNumber = string | number;
type maybeString = string | undefined;
export function testStandardUnionArgs(
  a: stringOrNumber,
  b: maybeString[]
): boolean | undefined {
  return;
}
export const testArrowUnionArgs = (
  a: stringOrNumber,
  b: maybeString[]
): boolean | undefined => {
  return;
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

  it("Fuzz example 1", async () => {
    fuzz(setup(intOptions, "nanofuzz-study/examples/1.ts", "minValue")).then(
      (fuzzResult) => {
        expect(fuzzResult.results.length).not.toBe(0);
      }
    );
  });

  it("Fuzz example 2", async () => {
    fuzz(
      setup(intOptions, "nanofuzz-study/examples/2.ts", "getSortSetting")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
    });
  });

  it("Fuzz example 3", async () => {
    fuzz(
      setup(floatOptions, "nanofuzz-study/examples/3.ts", "totalDinnerExpenses")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
    });
  });

  it("Fuzz example 4", async () => {
    fuzz(
      setup(
        {
          ...intOptions,
          argDefaults: { ...intOptions.argDefaults, anyDims: 1 },
        },
        "nanofuzz-study/examples/4.ts",
        "maxOfArray"
      )
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
    });
  });

  it("Fuzz example 5", async () => {
    fuzz(
      setup(intOptions, "nanofuzz-study/examples/5.ts", "getRandomNumber")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
    });
  });

  it("Fuzz example 6", async () => {
    fuzz(setup(intOptions, "nanofuzz-study/examples/6.ts", "getZero")).then(
      (fuzzResult) => {
        expect(fuzzResult.results.length).not.toBe(0);
      }
    );
  });

  it("Fuzz example 7", async () => {
    fuzz(
      setup(intOptions, "nanofuzz-study/examples/7.ts", "sortByWinLoss")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
    });
  });

  it("Fuzz example 8", async () => {
    fuzz(setup(intOptions, "nanofuzz-study/examples/8.ts", "minSalary")).then(
      (fuzzResult) => {
        expect(fuzzResult.results.length).not.toBe(0);
      }
    );
  });

  it("Fuzz example 9", async () => {
    fuzz(
      setup(intOptions, "nanofuzz-study/examples/9.ts", "getOffsetOrDefault")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
    });
  });

  // TODO: Vector length is randomized here - probably do not want that !!!
  it("Fuzz example 10", async () => {
    fuzz(
      setup(intOptions, "nanofuzz-study/examples/10.ts", "gramSchmidt")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
    });
  });

  it("Fuzz example 11", async () => {
    fuzz(setup(intOptions, "nanofuzz-study/examples/11.ts", "idMatrix")).then(
      (fuzzResult) => {
        expect(fuzzResult.results.length).not.toBe(0);
      }
    );
  });

  it("Fuzz example 12", async () => {
    fuzz(
      setup(intOptions, "nanofuzz-study/examples/12.ts", "levenshtein")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
    });
  });

  it("Fuzz example 13", async () => {
    fuzz(setup(intOptions, "nanofuzz-study/examples/13.ts", "isSteady")).then(
      (fuzzResult) => {
        expect(fuzzResult.results.length).not.toBe(0);
      }
    );
  });

  it("Fuzz example 14", async () => {
    fuzz(setup(intOptions, "nanofuzz-study/examples/14.ts", "modInv")).then(
      (fuzzResult) => {
        expect(fuzzResult.results.length).not.toBe(0);
        expect(fuzzResult.results.some((e) => e.timeout)).toBe(true);
      }
    );
  });

  it("Counter-example mode 01", async () => {
    fuzz(
      setup(counterExampleOptions, "nanofuzz-study/examples/14.ts", "modInv")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).toBe(1);
      expect(fuzzResult.results[0].category).not.toBe("ok");
    });
  });

  /**
   * Ensure fuzz targets that mutate their inputs cannot alter
   * the input the fuzzer recorded for the function.
   */
  it("Fuzz target cannot change fuzzer input record", async () => {
    fuzz(setup(intOptions, "./Fuzzer.test.ts", "testChangeInput")).then(
      (fuzzResult) => {
        const resultValue = fuzzResult.results[0].input[0].value;
        expect(fuzzResult.results.length).not.toBe(0);
        expect(
          resultValue !== undefined &&
            typeof resultValue === "object" &&
            !("b" in resultValue)
        ).toBeTruthy();
      }
    );
  });

  /**
   * Test that `void` functions (standard and arrow) fail the implicit
   * oracle in the case that they return values other than `undefined`
   */
  it("Standard fn void fuzz target fails if return is !==undefined", async () => {
    fuzz(
      setup(intOptions, "./Fuzzer.test.ts", "testStandardVoidReturnNumber")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
      expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
    });
  });
  it("Arrow fn void fuzz target fails if return is !==undefined", async () => {
    fuzz(
      setup(intOptions, "./Fuzzer.test.ts", "testArrowVoidReturnNumber")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
      expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
    });
  });

  /**
   * Test that `void` functions (standard and arrow) pass the implicit
   * oracle in the case that they only return `undefined`
   */
  it("Standard fn void fuzz target passes if return is undefined", async () => {
    fuzz(
      setup(intOptions, "./Fuzzer.test.ts", "testStandardVoidReturnUndefined")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
      expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeTruthy();
    });
  });
  it("Arrow fn void fuzz target passes if return is undefined", async () => {
    fuzz(
      setup(intOptions, "./Fuzzer.test.ts", "testArrowVoidReturnUndefined")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
      expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeTruthy();
    });
  });

  /**
   * Test that `void` functions (standard and arrow) fail the implicit
   * oracle when they throw an exception.
   */
  it("Standard fn void fuzz target fails if exception is thrown", async () => {
    fuzz(
      setup(intOptions, "./Fuzzer.test.ts", "testStandardVoidReturnException")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
      expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
      expect(fuzzResult.results.every((e) => e.exception)).toBeTruthy();
    });
  });
  it("Arrow fn void fuzz target fails if exception is thrown", async () => {
    fuzz(
      setup(intOptions, "./Fuzzer.test.ts", "testArrowVoidReturnException")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
      expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
      expect(fuzzResult.results.every((e) => e.exception)).toBeTruthy();
    });
  });

  /**
   * Test that `void` functions w/literal arguments (standard and arrow) pass
   * when they return undefined.
   */
  it("Standard void literal arg fuzz target", async () => {
    fuzz(
      setup(intOptions, "./Fuzzer.test.ts", "testStandardVoidLiteralArgs")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
      expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeTruthy();
    });
  });
  it("Arrow void literal arg fuzz target", async () => {
    fuzz(
      setup(intOptions, "./Fuzzer.test.ts", "testArrowVoidLiteralArgs")
    ).then((fuzzResult) => {
      expect(fuzzResult.results.length).not.toBe(0);
      expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeTruthy();
    });
  });

  /**
   * Test that we can fuzz functions with union arguments.
   */
  it("Standard union arg fuzz target", async () => {
    fuzz(setup(intOptions, "./Fuzzer.test.ts", "testStandardUnionArgs")).then(
      (fuzzResult) => {
        expect(fuzzResult.results.length).not.toBe(0);
        expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
      }
    );
  });
  it("Arrow union arg fuzz target", async () => {
    fuzz(setup(intOptions, "./Fuzzer.test.ts", "testArrowUnionArgs")).then(
      (fuzzResult) => {
        expect(fuzzResult.results.length).not.toBe(0);
        expect(fuzzResult.results.some((e) => e.passedImplicit)).toBeFalsy();
      }
    );
  });
});
