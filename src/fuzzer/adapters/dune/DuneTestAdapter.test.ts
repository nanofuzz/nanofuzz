import { DuneTestAdapter } from "./DuneTestAdapter";
import * as TestAdapterFactory from "../TestAdapterFactory";
import { FuzzOptions, FuzzTests } from "../../Types";
import { ArgOptions, ArgTag } from "../../analysis/Types";
import * as Parser from "../../adapters/ParserAdapter";
import { OxcamlCompiler } from "../../compilers/oxcaml/OxcamlCompiler";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

const argDefaults: ArgOptions = {
  strCharset: "abc",
  strLength: { min: 0, max: 3 },
  byteLength: { min: 0, max: 3 },
  dictLength: { min: 0, max: 3 },
  setLength: { min: 0, max: 3 },
  strRegex: undefined,
  numInteger: true,
  anyType: ArgTag.NUMBER,
  anyDims: 0,
  dftDimLength: { min: 0, max: 1 },
  dimLength: [],
  dimsUnique: false,
};

const baseOptions: Omit<
  FuzzOptions,
  "argDefaults" | "measures" | "generators"
> = {
  maxTests: 1,
  fnTimeout: 100,
  suiteTimeout: 1000,
  seed: "seed",
  maxDupeInputs: 1,
  maxFailures: 1,
  useTransformer: true,
  useImplicit: false,
  useHuman: false,
  useProperty: false,
};

const measures: FuzzOptions["measures"] = {
  FailedTestMeasure: { enabled: true, weight: 1 },
  CoverageMeasure: { enabled: false, weight: 0 },
};

const generators: FuzzOptions["generators"] = {
  RandomInputGenerator: { enabled: true },
  MutationInputGenerator: { enabled: false },
  AiInputGenerator: { enabled: false },
  UserInputGenerator: { enabled: false },
};

const makeOptions = (overrides: Partial<FuzzOptions> = {}): FuzzOptions => ({
  ...baseOptions,
  argDefaults: overrides.argDefaults ?? argDefaults,
  measures: overrides.measures ?? measures,
  generators: overrides.generators ?? generators,
  maxTests: overrides.maxTests ?? baseOptions.maxTests,
  fnTimeout: overrides.fnTimeout ?? baseOptions.fnTimeout,
  suiteTimeout: overrides.suiteTimeout ?? baseOptions.suiteTimeout,
  seed: overrides.seed ?? baseOptions.seed,
  maxDupeInputs: overrides.maxDupeInputs ?? baseOptions.maxDupeInputs,
  maxFailures: overrides.maxFailures ?? baseOptions.maxFailures,
  useImplicit: overrides.useImplicit ?? baseOptions.useImplicit,
  useHuman: overrides.useHuman ?? baseOptions.useHuman,
  useProperty: overrides.useProperty ?? baseOptions.useProperty,
});

describe("fuzzer/adapters/dune/DuneTestAdapter:", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-dunetest-")
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("emits unit test fn for all generated scenarios", () => {
    const tests: FuzzTests = {
      version: "0.4.0",
      functions: {
        sampleFn: {
          options: makeOptions({ useHuman: true, useProperty: true }),
          validators: ["sampleFnValidator"],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 10,
                  origin: {
                    type: "generator",
                    generator: "RandomInputGenerator",
                  },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  value: 20,
                  origin: { type: "user" },
                },
              ],
            },
            "1": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: -5,
                  origin: {
                    type: "generator",
                    generator: "RandomInputGenerator",
                  },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  isException: true,
                  value: undefined,
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        voidFn: {
          options: makeOptions({ useImplicit: true }),
          validators: [],
          tests: {
            only: {
              input: [],
              output: [],
              pinned: true,
            },
          },
          isVoid: true,
        },
        heuristicFn: {
          options: makeOptions({ useImplicit: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 42,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
            },
          },
          isVoid: false,
        },
      },
    };

    const out = new DuneTestAdapter(tests, "mymodule.ml").toString();

    expect(out).toContain("let test_sampleFn_0_expect () =");
    expect(out).toContain("let test_sampleFn_0_prop_Validator () =");
    expect(out).toContain("let test_sampleFn_1_expect () =");
    expect(out).toContain("let test_voidFn_0_heuristic () =");
    expect(out).toContain("let test_heuristicFn_0_heuristic () =");
    expect(out).toContain(
      'assert_true ~message:"Implicit oracle failed" (Nanofuzz_runtime.implicit_oracle_value res_json)'
    );
    expect(out).toContain("open Nanofuzz_runtime");
    expect(out).toContain("module Target = struct");
    expect(out).toContain("include Mymodule");
    expect(out).toContain("test_sampleFn_0_expect ();");
    expect(out).toContain("test_sampleFn_0_prop_Validator ();");
  });

  it("names nano test filename correctly", () => {
    const adapter = new DuneTestAdapter(
      { version: "0.4.0", functions: {} },
      "/path/to/my_math.ml"
    );
    expect(adapter.filename).toBe("/path/to/my_math_nano_test.ml");
    expect(adapter.toolname).toBe("Dune");
  });

  it("integrates with TestAdapterFactory", () => {
    const adapter = TestAdapterFactory.fromSourceFilename("target.ml", {
      version: "0.4.0",
      functions: {},
    });
    expect(adapter instanceof DuneTestAdapter).toBeTrue();
    expect(adapter.toolname).toBe("Dune");
  });

  it("compiles and executes synthesized OCaml regression tests via dune runtest", () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const runtimePath = path.resolve("./packages/runtime/oxcaml");
    fs.cpSync(runtimePath, path.join(tempDir, "nanofuzz_runtime"), {
      recursive: true,
      filter: (s) => !s.includes("_build"),
    });

    fs.writeFileSync(
      path.join(tempDir, "dune-project"),
      `(lang dune 2.9)\n(name test_dune_adapter)\n`
    );

    fs.writeFileSync(
      path.join(tempDir, "dune"),
      `(library
 (name math_lib)
 (libraries nanofuzz_runtime)
 (modules math_lib))

(test
 (name math_lib_nano_test)
 (modules math_lib_nano_test)
 (libraries math_lib nanofuzz_runtime yojson))
`
    );

    const modPath = path.join(tempDir, "math_lib.ml");
    fs.writeFileSync(
      modPath,
      `let add (a : int) (b : int) : int =
  if a < 0 then failwith "negative a not allowed"
  else a + b

let add_validator (result : Nanofuzz_runtime.fuzz_test_result) : Nanofuzz_runtime.validator_result =
  match Nanofuzz_runtime.get_in 0 result, Nanofuzz_runtime.get_in 1 result with
  | Some (\`Int a), Some (\`Int b) ->
    (match Nanofuzz_runtime.get_out result with
     | \`Int out_val -> if out_val = a + b then Nanofuzz_runtime.Pass else Nanofuzz_runtime.Fail
     | _ -> Nanofuzz_runtime.Unknown)
  | _ -> Nanofuzz_runtime.Unknown
`
    );

    const tests: FuzzTests = {
      version: "0.4.0",
      functions: {
        add: {
          options: makeOptions({ useHuman: true, useProperty: true }),
          validators: ["add_validator"],
          tests: {
            "0": {
              input: [
                {
                  name: "a",
                  offset: 0,
                  value: 10,
                  origin: {
                    type: "generator",
                    generator: "RandomInputGenerator",
                  },
                },
                {
                  name: "b",
                  offset: 1,
                  value: 32,
                  origin: {
                    type: "generator",
                    generator: "RandomInputGenerator",
                  },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  value: 42,
                  origin: { type: "user" },
                },
              ],
            },
            "1": {
              input: [
                {
                  name: "a",
                  offset: 0,
                  value: -5,
                  origin: {
                    type: "generator",
                    generator: "RandomInputGenerator",
                  },
                },
                {
                  name: "b",
                  offset: 1,
                  value: 10,
                  origin: {
                    type: "generator",
                    generator: "RandomInputGenerator",
                  },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  isException: true,
                  value: undefined,
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
      },
    };

    const adapter = new DuneTestAdapter(tests, modPath);
    const testCode = adapter.toString();
    fs.writeFileSync(adapter.filename, testCode);

    const duneDir = path.dirname(duneBin);
    const pathKey =
      Object.keys(process.env).find((k) => k.toLowerCase() === "path") ||
      "PATH";

    const res = spawnSync(duneBin, ["runtest"], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        [pathKey]: `${duneDir}${path.delimiter}${process.env[pathKey] || ""}`,
      },
    });

    if (res.status !== 0) {
      console.error("Dune runtest stdout:", res.stdout);
      console.error("Dune runtest stderr:", res.stderr);
    }
    expect(res.status).toBe(0);
  });
});
