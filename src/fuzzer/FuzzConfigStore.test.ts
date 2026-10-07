import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as JSONN from "../Jsonn";
import { FuzzConfigStore, CURR_FILE_FMT_VER } from "./FuzzConfigStore";
import { FuzzPinnedTest, FuzzTests } from "./Types";
import * as ProgramFactory from "./analysis/ProgramFactory";

describe("FuzzConfigStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-config-store-test-")
    );
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("calculates nano and legacy filenames correctly", () => {
    const srcTs = "/path/to/math.ts";
    const srcPy = "/path/to/math.py";

    expect(FuzzConfigStore.getNanoFilename(srcTs)).toBe(
      "/path/to/math.ts.nano.json5"
    );
    expect(FuzzConfigStore.getNanoFilename(srcPy)).toBe(
      "/path/to/math.py.nano.json5"
    );
    expect(FuzzConfigStore.getNanoFilename("/path/to/math.ts.nano.json5")).toBe(
      "/path/to/math.ts.nano.json5"
    );

    expect(FuzzConfigStore.getLegacyNanoFilename(srcTs)).toBe(
      "/path/to/math.nano.test.json"
    );
    expect(FuzzConfigStore.getLegacyNanoFilename(srcPy)).toBe(
      "/path/to/math.nano.test.json"
    );
  });

  it("migrates legacy .nano.test.json file to .nano.json5", () => {
    const srcFile = path.join(tmpDir, "calculator.ts");
    const legacyFile = path.join(tmpDir, "calculator.nano.test.json");
    const newFile = path.join(tmpDir, "calculator.ts.nano.json5");

    fs.writeFileSync(
      srcFile,
      "export function add(a: number, b: number): number { return a + b; }"
    );
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        version: "0.3.6",
        functions: {
          add: {
            tests: {},
          },
        },
      })
    );

    expect(fs.existsSync(legacyFile)).toBe(true);
    expect(fs.existsSync(newFile)).toBe(false);

    const migrated = FuzzConfigStore.migrateLegacyNanoFile(srcFile);
    expect(migrated).toBe(true);
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  it("loads empty structure when config file does not exist", () => {
    const srcFile = path.join(tmpDir, "nonexistent.ts");
    const testSet = FuzzConfigStore.loadForModule(srcFile);

    expect(testSet.version).toBe(CURR_FILE_FMT_VER);
    expect(testSet.functions).toEqual({});
  });

  it("upgrades v0.1.0 format without version field", () => {
    const rawLegacy = {
      add: {
        '{"value":[1,2]}': {
          input: [{ name: "a", offset: 0, value: 1 }],
          output: [],
          pinned: true,
        },
      },
    };

    const upgraded = FuzzConfigStore.upgrade(rawLegacy, "test.nano.json5");
    expect(upgraded.version).toBe(CURR_FILE_FMT_VER);
    expect(upgraded.functions.add).toBeDefined();
    expect(upgraded.functions.add.tests).toBeDefined();
  });

  it("upgrades v0.2.0, 0.2.1, 0.3.0, 0.3.3, 0.3.6 sequentially", () => {
    const v020Data = {
      version: "0.2.0",
      functions: {
        foo: {
          options: {},
          validator: "fooValidator",
          tests: {},
        },
      },
    };

    const upgraded = FuzzConfigStore.upgrade(v020Data, "test.nano.json5");
    expect(upgraded.version).toBe(CURR_FILE_FMT_VER);
    expect(upgraded.functions.foo.options.maxFailures).toBe(0);
    expect(upgraded.functions.foo.options.useHuman).toBe(true);
    expect(upgraded.functions.foo.options.useProperty).toBe(true);
    expect(upgraded.functions.foo.options.useTransformer).toBe(true);
    expect(
      upgraded.functions.foo.options.generators.RandomInputGenerator.enabled
    ).toBe(true);
    expect(
      upgraded.functions.foo.options.generators.UserInputGenerator.enabled
    ).toBe(true);
  });

  it("upgrades v0.3.3 file to v0.4.0 with options, argOverrides, and test origin metadata", () => {
    const rawV033 = `{
      version: '0.3.3',
      functions: {
        decodeRoman: {
          options: {
            argDefaults: {
              strCharset: ' !"#$%&\\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\\\]^_\\\`abcdefghijklmnopqrstuvwxyz{|}~',
              strLength: { min: 0, max: 10 },
              numInteger: true,
              numSigned: false,
              anyType: 'number',
              anyDims: 0,
              dftDimLength: { min: 0, max: 4 },
              dimLength: []
            },
            maxTests: 1000,
            fnTimeout: 100,
            suiteTimeout: 3000,
            maxFailures: 0,
            onlyFailures: false,
            useHuman: true,
            useImplicit: true,
            useProperty: true
          },
          argOverrides: [{ string: { minStrLen: 0, maxStrLen: 10, strCharset: 'MCXVI' } }],
          validators: ['decodeRoman_length'],
          tests: {
            "[{name:'str',offset:0,value:''}]": {
              input: [{ name: 'str', offset: 0, value: '' }],
              output: [{ name: '0', offset: 0, value: 0 }],
              pinned: false,
              expectedOutput: [{ name: '0', offset: 0, isException: true }]
            }
          }
        },
        toRoman: {
          options: {
            argDefaults: {
              strCharset: ' !"#$%&\\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\\\]^_\\\`abcdefghijklmnopqrstuvwxyz{|}~',
              strLength: { min: 0, max: 10 },
              numInteger: true,
              numSigned: false,
              anyType: 'number',
              anyDims: 0,
              dftDimLength: { min: 0, max: 4 },
              dimLength: []
            },
            maxTests: 1000,
            fnTimeout: 100,
            suiteTimeout: 3000,
            maxFailures: 0,
            onlyFailures: false,
            useHuman: true,
            useImplicit: true,
            useProperty: true
          },
          argOverrides: [{ number: { numInteger: true, min: 0, max: 100 } }],
          validators: ['toRoman_roundtrip'],
          tests: {
            "[{name:'n',offset:0,value:0}]": {
              input: [{ name: 'n', offset: 0, value: 0 }],
              output: [{ name: '0', offset: 0, value: '' }],
              pinned: false,
              expectedOutput: [{ name: '0', offset: 0, isException: true }]
            }
          }
        }
      }
    }`;

    const parsed = JSONN.parse(rawV033);
    const upgraded = FuzzConfigStore.upgrade(parsed, "roman.nano.json5");

    expect(upgraded.version).toBe(CURR_FILE_FMT_VER);
    expect(upgraded.functions.decodeRoman).toBeDefined();
    expect(upgraded.functions.toRoman).toBeDefined();

    // 1. Verify decodeRoman options upgraded with generators, measures, useTransformer, and maxDupeInputs
    const decodeFn = upgraded.functions.decodeRoman;
    expect(decodeFn.options.maxDupeInputs).toBe(500);
    expect(decodeFn.options.useTransformer).toBe(true);
    expect(decodeFn.options.generators.RandomInputGenerator.enabled).toBe(true);
    expect(decodeFn.options.generators.UserInputGenerator.enabled).toBe(true);
    expect(decodeFn.options.measures.CoverageMeasure.enabled).toBe(true);
    expect(decodeFn.options.measures.FailedTestMeasure.enabled).toBe(true);

    // 2. Verify decodeRoman argOverrides preserved
    expect(decodeFn.argOverrides?.length).toBe(1);
    expect(decodeFn.argOverrides?.[0].string?.strCharset).toBe("MCXVI");

    // 3. Verify decodeRoman tests converted and re-keyed with origin tagging
    const decodeTests = Object.values(decodeFn.tests);
    expect(decodeTests.length).toBe(1);
    const decodeTest = decodeTests[0];
    expect(decodeTest.input[0].origin).toEqual({
      type: "generator",
      generator: "RandomInputGenerator",
    });
    expect(decodeTest.output[0].origin).toEqual({ type: "put" });
    expect(decodeTest.expectedOutput?.[0].origin).toEqual({ type: "user" });

    // 4. Verify toRoman argOverrides and tests
    const toRomanFn = upgraded.functions.toRoman;
    expect(toRomanFn.argOverrides?.length).toBe(1);
    expect(toRomanFn.argOverrides?.[0].number?.min).toBe(0);
    expect(toRomanFn.argOverrides?.[0].number?.max).toBe(100);

    const toRomanTests = Object.values(toRomanFn.tests);
    expect(toRomanTests.length).toBe(1);
    expect(toRomanTests[0].input[0].origin).toEqual({
      type: "generator",
      generator: "RandomInputGenerator",
    });
  });

  it("applies argOverrides to function argument definitions", () => {
    const srcFile = path.join(tmpDir, "argoverrides.ts");
    fs.writeFileSync(
      srcFile,
      "export function testOverrides(s: string, n: number): boolean { return s.length > n; }"
    );
    const program = ProgramFactory.fromFile(srcFile);
    const fnDef = program.functionsExported["testOverrides"];
    expect(fnDef).toBeDefined();

    FuzzConfigStore.applyArgOverrides(
      fnDef,
      [
        { string: { minStrLen: 3, maxStrLen: 7, strCharset: "ABC" } },
        { number: { min: 10, max: 20, numInteger: true } },
      ],
      FuzzConfigStore.getDefaultFuzzOptions().argDefaults
    );

    const args = fnDef.getArgDefs();
    expect(args[0].getOptions().strLength).toEqual({ min: 3, max: 7 });
    expect(args[0].getOptions().strCharset).toBe("ABC");
    expect(args[1].getIntervals()).toEqual([{ min: 10, max: 20 }]);
    expect(args[1].getOptions().numInteger).toBe(true);
  });

  it("throws error for unknown schema version", () => {
    const futureData = {
      version: "99.0.0",
      functions: {},
    };

    expect(() => {
      FuzzConfigStore.upgrade(futureData, "future.nano.json5");
    }).toThrowError(/Unknown version 99\.0\.0/);
  });

  it("prunes unpinned tests without expectedOutput", () => {
    const testSet: FuzzTests = {
      version: CURR_FILE_FMT_VER,
      functions: {
        calc: {
          options: FuzzConfigStore.getDefaultFuzzOptions(),
          validators: [],
          isVoid: false,
          tests: {
            t1: {
              input: [
                { name: "x", offset: 0, value: 1, origin: { type: "user" } },
              ],
              output: [],
              pinned: true,
            },
            t2: {
              input: [
                { name: "x", offset: 0, value: 2, origin: { type: "user" } },
              ],
              output: [],
              pinned: false,
              expectedOutput: [
                { name: "0", offset: 0, value: 4, origin: { type: "user" } },
              ],
            },
            t3: {
              input: [
                { name: "x", offset: 0, value: 3, origin: { type: "user" } },
              ],
              output: [],
              pinned: false,
            },
          },
        },
      },
    };

    const pruned = FuzzConfigStore.prune(testSet);
    expect(pruned.functions.calc.tests.t1).toBeDefined();
    expect(pruned.functions.calc.tests.t2).toBeDefined();
    expect(pruned.functions.calc.tests.t3).toBeUndefined();
  });

  it("saves and loads module tests round-trip", () => {
    const srcFile = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(
      srcFile,
      "export function sample(x: number): number { return x * 2; }"
    );

    const pinnedTest: FuzzPinnedTest = {
      input: [{ name: "x", offset: 0, value: 10, origin: { type: "user" } }],
      output: [{ name: "0", offset: 0, value: 20, origin: { type: "put" } }],
      pinned: true,
      expectedOutput: [
        { name: "0", offset: 0, value: 20, origin: { type: "user" } },
      ],
    };

    FuzzConfigStore.updatePinnedTest(srcFile, "sample", pinnedTest);

    const loadedFn = FuzzConfigStore.loadForFunction(srcFile, "sample");
    expect(Object.keys(loadedFn.tests).length).toBe(1);
    const savedTest = Object.values(loadedFn.tests)[0];
    expect(savedTest.pinned).toBe(true);
    expect(savedTest.input[0].value === 10).toBe(true);
  });

  it("removes pinned test when unpinned without expectedOutput", () => {
    const srcFile = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(
      srcFile,
      "export function sample(x: number): number { return x * 2; }"
    );

    const pinnedTest: FuzzPinnedTest = {
      input: [{ name: "x", offset: 0, value: 10, origin: { type: "user" } }],
      output: [],
      pinned: true,
    };

    FuzzConfigStore.updatePinnedTest(srcFile, "sample", pinnedTest);
    let loadedFn = FuzzConfigStore.loadForFunction(srcFile, "sample");
    expect(Object.keys(loadedFn.tests).length).toBe(1);

    // Unpin without expectedOutput
    FuzzConfigStore.updatePinnedTest(srcFile, "sample", {
      ...pinnedTest,
      pinned: false,
      expectedOutput: undefined,
    });

    loadedFn = FuzzConfigStore.loadForFunction(srcFile, "sample");
    expect(Object.keys(loadedFn.tests).length).toBe(0);
  });

  it("syncs Jest test adapter file when saving pinned tests in TypeScript module", () => {
    const srcFile = path.join(tmpDir, "sample.ts");
    const jestFile = path.join(tmpDir, "sample.nano.test.ts");
    fs.writeFileSync(
      srcFile,
      "export function sample(x: number): number { return x * 2; }"
    );

    const pinnedTest: FuzzPinnedTest = {
      input: [{ name: "x", offset: 0, value: 10, origin: { type: "user" } }],
      output: [],
      pinned: true,
      expectedOutput: [
        { name: "0", offset: 0, value: 20, origin: { type: "user" } },
      ],
    };

    FuzzConfigStore.updatePinnedTest(srcFile, "sample", pinnedTest, {
      syncTestAdapter: true,
    });
    expect(fs.existsSync(jestFile)).toBe(true);

    const jestContent = fs.readFileSync(jestFile, "utf8");
    expect(jestContent).toContain('describe("sample"');

    // When all tests unpinned, test file is removed
    FuzzConfigStore.updatePinnedTest(
      srcFile,
      "sample",
      { ...pinnedTest, pinned: false, expectedOutput: undefined },
      { syncTestAdapter: true }
    );
    expect(fs.existsSync(jestFile)).toBe(false);
  });
});
