import * as vscode from "vscode";
import path from "path";
import { setup, fuzz, getDefaultFuzzOptions, implicitOracle } from "./Fuzzer";
import { ArgDef } from "./analysis/typescript/ArgDef";
import { FuzzOptions } from "./Types";

jest.mock("vscode");

/**
 * Fuzzer option for integer arguments and a seed for deterministic test execution.
 */
const intOptions: FuzzOptions = {
  ...getDefaultFuzzOptions(),
  fnTimeout: 1000,
  seed: "qwertyuiop",
};

/**
 * Fuzzer option for float arguments and a seed for deterministic test execution.
 */
const floatOptions: FuzzOptions = {
  ...intOptions,
  argDefaults: ArgDef.getDefaultFloatOptions(),
};

/**
 * Extension Uri
 */
const extensionUri = vscode.Uri.file(path.resolve("."));
console.log(`Path: ${path.resolve(".")}`); // !!!!
console.log(`Extension Uri: ${extensionUri.toString()}`); // !!!!

/**
 * These tests currently just ensure that the fuzzer runs and produces output
 * for each example. TODO: Add tests that check the fuzzer output.
 */
describe("Fuzzer", () => {
  test("Implicit Oracle - NaN", () => {
    expect(implicitOracle(NaN)).toBe(false);
  });

  test("Implicit Oracle - +Infinity", () => {
    expect(implicitOracle(Infinity)).toBe(false);
  });

  test("Implicit Oracle - -Infinity", () => {
    expect(implicitOracle(-Infinity)).toBe(false);
  });

  test("Implicit Oracle - null", () => {
    expect(implicitOracle(null)).toBe(false);
  });

  test("Implicit Oracle - undefined", () => {
    expect(implicitOracle(undefined)).toBe(false);
  });

  test("Implicit Oracle - ''", () => {
    expect(implicitOracle("")).toBe(true);
  });

  test("Implicit Oracle - 0", () => {
    expect(implicitOracle(0)).toBe(true);
  });

  test("Implicit Oracle - -1", () => {
    expect(implicitOracle(-1)).toBe(true);
  });

  test("Implicit Oracle - 1", () => {
    expect(implicitOracle(1)).toBe(true);
  });

  test("Implicit Oracle - 'xyz'", () => {
    expect(implicitOracle("xyz")).toBe(true);
  });

  test("Implicit Oracle - []", () => {
    expect(implicitOracle([])).toBe(true);
  });

  test("Implicit Oracle - [1]", () => {
    expect(implicitOracle([1])).toBe(true);
  });

  test("Implicit Oracle - [[]]", () => {
    expect(implicitOracle([[]])).toBe(true);
  });

  test("Implicit Oracle - [[1]]", () => {
    expect(implicitOracle([[]])).toBe(true);
  });

  test("Implicit Oracle - [null,1]", () => {
    expect(implicitOracle([null, 1])).toBe(false);
  });

  test("Implicit Oracle - [1,undefined]", () => {
    expect(implicitOracle([1, undefined])).toBe(false);
  });

  test("Implicit Oracle - [NaN,1]", () => {
    expect(implicitOracle([NaN, 1])).toBe(false);
  });

  test("Implicit Oracle - [1,Infinity]", () => {
    expect(implicitOracle([1, Infinity])).toBe(false);
  });

  test("Implicit Oracle - [-Infinity,1]", () => {
    expect(implicitOracle([-Infinity, 1])).toBe(false);
  });

  test("Implicit Oracle - [[null,1],1]", () => {
    expect(implicitOracle([[null, 1], 1])).toBe(false);
  });

  test("Implicit Oracle - [1,[undefined,1]]", () => {
    expect(implicitOracle([1, [undefined, 1]])).toBe(false);
  });

  test("Implicit Oracle - [[NaN,1],1]", () => {
    expect(implicitOracle([[NaN, 1], 1])).toBe(false);
  });

  test("Implicit Oracle - [1,[1,Infinity]]", () => {
    expect(implicitOracle([1, [1, Infinity]])).toBe(false);
  });

  test("Implicit Oracle - [[1,-Infinity],1]", () => {
    expect(implicitOracle([[1, -Infinity], 1])).toBe(false);
  });

  test("Implicit Oracle - {}", () => {
    expect(implicitOracle({})).toBe(true);
  });

  test("Implicit Oracle - {a: 'abc', b: 123}", () => {
    expect(implicitOracle({ a: "abc", b: 123 })).toBe(true);
  });

  test("Implicit Oracle - {a:null, b:1}", () => {
    expect(implicitOracle({ a: null, b: 1 })).toBe(false);
  });

  test("Implicit Oracle - {a:1, b:undefined}", () => {
    expect(implicitOracle({ a: 1, b: undefined })).toBe(false);
  });

  test("Implicit Oracle - {a:1, b:NaN}", () => {
    expect(implicitOracle({ a: 1, b: NaN })).toBe(false);
  });

  test("Implicit Oracle - {a:1, b:Infinity}", () => {
    expect(implicitOracle({ a: 1, b: Infinity })).toBe(false);
  });

  test("Implicit Oracle - {a:-Infinity, b:1}", () => {
    expect(implicitOracle({ a: -Infinity, b: 1 })).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:null}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: null }], b: 1 }])).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:NaN}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: NaN }], b: 1 }])).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:Infinity}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: Infinity }], b: 1 }])).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:-Infinity}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: -Infinity }], b: 1 }])).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:undefined}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: undefined }], b: 1 }])).toBe(false);
  });

  test("Implicit Oracle - [{a:[{c:2}], b:1}]", () => {
    expect(implicitOracle([{ a: [{ c: 2 }], b: 1 }])).toBe(true);
  });

  test("Fuzz example 01", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/1.ts"),
          name: "minValue",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 02", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/2.ts"),
          name: "getSortSetting",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 03", async () => {
    const results = (
      await fuzz(
        await setup(floatOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/3.ts"),
          name: "totalDinnerExpenses",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 04", async () => {
    const results = (
      await fuzz(
        await setup(
          {
            ...intOptions,
            argDefaults: { ...intOptions.argDefaults, anyDims: 1 },
          },
          extensionUri,
          {
            module: new URL(extensionUri + "/src/examples/4.ts"),
            name: "maxOfArray",
          }
        )
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 05", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/5.ts"),
          name: "getRandomNumber",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 06", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/6.ts"),
          name: "getZero",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 07", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/7.ts"),
          name: "sortByWinLoss",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 08", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/8.ts"),
          name: "minSalary",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 09", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/9.ts"),
          name: "getOffsetOrDefault",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  // TODO: Vector length is randomized here - probably do not want that !!!
  test("Fuzz example 10", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/10.ts"),
          name: "gramSchmidt",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 11", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/11.ts"),
          name: "idMatrix",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 12", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/12.ts"),
          name: "levenshtein",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 13", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/13.ts"),
          name: "isSteady",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });

  test("Fuzz example 14", async () => {
    const results = (
      await fuzz(
        await setup(intOptions, extensionUri, {
          module: new URL(extensionUri + "/src/examples/14.ts"),
          name: "modInv",
        })
      )
    ).results;
    expect(results.length).not.toStrictEqual(0);
  });
});
