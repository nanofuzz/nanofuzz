import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as TestAdapterFactory from "../TestAdapterFactory";
import { VirgilTestAdapter } from "./VirgilTestAdapter";
import { FuzzOptions, FuzzTests } from "../../Types";
import { ArgDef } from "../../analysis/ArgDef";
import * as Parser from "../../adapters/ParserAdapter";

const testOptions: FuzzOptions = {
  argDefaults: ArgDef.getDefaultOptions(),
  maxTests: 10,
  maxDupeInputs: 5,
  maxFailures: 0,
  fnTimeout: 500,
  suiteTimeout: 1000,
  useImplicit: true,
  useHuman: false,
  useProperty: false,
  useTransformer: false,
  measures: {
    CoverageMeasure: { enabled: true, weight: 1 },
    FailedTestMeasure: { enabled: true, weight: 1 },
  },
  generators: {
    RandomInputGenerator: { enabled: true },
    MutationInputGenerator: { enabled: false },
    AiInputGenerator: { enabled: false },
    UserInputGenerator: { enabled: false },
  },
};

describe("fuzzer/adapters/virgil/VirgilTestAdapter: ", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-v3ta-test-")
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("registers in TestAdapterFactory and returns VirgilTestAdapter", () => {
    const v3File = path.join(tempDir, "math.v3");
    const testSet: FuzzTests = {
      version: "0.4.1",
      functions: {},
    };

    const adapter = TestAdapterFactory.fromSourceFilename(v3File, testSet);
    expect(adapter).toBeDefined();
    expect(adapter instanceof VirgilTestAdapter).toBeTrue();
    expect(adapter.toolname).toBe("Virgil");
    expect(adapter.filename).toBe(path.join(tempDir, "math_nano_test.v3"));
  });

  it("synthesizes standalone Virgil test suite with main() entrypoint and assertions", () => {
    const v3File = path.join(tempDir, "ops.v3");
    fs.writeFileSync(
      v3File,
      `def add(a: int, b: int) -> int { return a + b; }
def greet(name: string) -> string { return "hello " + name; }
def do_nothing() -> void {}
`
    );

    const testSet: FuzzTests = {
      version: "0.4.1",
      functions: {
        add: {
          options: testOptions,
          validators: [],
          isVoid: false,
          tests: {
            "0": {
              pinned: true,
              input: [
                { name: "a", offset: 0, value: 2, origin: { type: "user" } },
                { name: "b", offset: 1, value: 3, origin: { type: "user" } },
              ],
              output: [
                { name: "0", offset: 0, value: 5, origin: { type: "user" } },
              ],
            },
          },
        },
        greet: {
          options: testOptions,
          validators: [],
          isVoid: false,
          tests: {
            "0": {
              pinned: true,
              input: [
                {
                  name: "name",
                  offset: 0,
                  value: "world",
                  origin: { type: "user" },
                },
              ],
              output: [
                {
                  name: "0",
                  offset: 0,
                  value: "hello world",
                  origin: { type: "user" },
                },
              ],
            },
          },
        },
        do_nothing: {
          options: testOptions,
          validators: [],
          isVoid: true,
          tests: {
            "0": {
              pinned: true,
              input: [],
              output: [],
            },
          },
        },
      },
    };

    const adapter = new VirgilTestAdapter(testSet, v3File);
    const code = adapter.toString();

    expect(code).toContain("def main() -> int {");
    expect(code).toContain("add(2, 3)");
    expect(code).toContain("res_0 != 5");
    expect(code).toContain('greet("world")');
    expect(code).toContain('res_1 != "hello world"');
    expect(code).toContain("do_nothing();");
    expect(code).toContain("return 0;");
  });
});
