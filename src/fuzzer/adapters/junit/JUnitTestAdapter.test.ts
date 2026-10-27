import { JUnitTestAdapter } from "./JUnitTestAdapter";
import * as TestAdapterFactory from "../TestAdapterFactory";
import { FuzzOptions, FuzzTests } from "../../Types";
import { ArgOptions, ArgTag } from "../../analysis/Types";
import * as Parser from "../../adapters/ParserAdapter";
import {
  JavaCompiler,
  findRuntimeJar,
} from "../../compilers/java/JavaCompiler";
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

describe("fuzzer/adapters/junit/JUnitTestAdapter:", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-junittest-")
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

  it("emits unit test methods for all generated scenarios", () => {
    const javaPath = path.join(tempDir, "Sample.java");
    fs.writeFileSync(
      javaPath,
      `package com.example;

import com.nanofuzz.runtime.FuzzTestResult;
import com.nanofuzz.runtime.ValidatorResult;

public class Sample {
    public static int sampleFn(int x) {
        if (x < 0) throw new IllegalArgumentException("negative");
        return x * 2;
    }

    public static ValidatorResult sampleFnValidator(FuzzTestResult r) {
        return ValidatorResult.PASS;
    }

    public static void voidFn() {
    }

    public static int heuristicFn(int a) {
        return a + 1;
    }
}
`
    );

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

    const out = new JUnitTestAdapter(tests, javaPath).toString();

    expect(out).toContain("package com.example;");
    expect(out).toContain("public class SampleNanoTest {");
    expect(out).toContain("void test_sampleFn_0_expect()");
    expect(out).toContain("assertEquals(20, actual);");
    expect(out).toContain("void test_sampleFn_0_prop_Validator()");
    expect(out).toContain("void test_sampleFn_1_expect()");
    expect(out).toContain("assertThrows(Throwable.class");
    expect(out).toContain("void test_voidFn_0_heuristic()");
    expect(out).toContain("void test_heuristicFn_0_heuristic()");
    expect(out).toContain("assertTrue(ImplicitOracle.check(res));");
    expect(out).toContain("import org.junit.jupiter.api.Test;");
    expect(out).toContain("import static org.junit.jupiter.api.Assertions.*;");
    expect(out).toContain("import com.nanofuzz.runtime.FuzzTestResult;");
    expect(out).toContain("import com.nanofuzz.runtime.ValidatorResult;");
  });

  it("handles default package when no package statement is present", () => {
    const javaPath = path.join(tempDir, "DefaultPkg.java");
    fs.writeFileSync(
      javaPath,
      `public class DefaultPkg {
    public static int doubleVal(int x) { return x * 2; }
}
`
    );

    const tests: FuzzTests = {
      version: "0.4.0",
      functions: {
        doubleVal: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                {
                  name: "0",
                  offset: 0,
                  value: 7,
                  origin: { type: "user" },
                },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  value: 14,
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
      },
    };

    const out = new JUnitTestAdapter(tests, javaPath).toString();
    expect(out).not.toContain("package ");
    expect(out).toContain("public class DefaultPkgNanoTest {");
    expect(out).toContain("DefaultPkg.doubleVal(7)");
  });

  it("names nano test filename correctly", () => {
    const adapter = new JUnitTestAdapter(
      { version: "0.4.0", functions: {} },
      "/path/to/MyMath.java"
    );
    expect(adapter.filename).toBe("/path/to/MyMathNanoTest.java");
    expect(adapter.toolname).toBe("JUnit");
  });

  it("integrates with TestAdapterFactory", () => {
    const adapter = TestAdapterFactory.fromSourceFilename("Target.java", {
      version: "0.4.0",
      functions: {},
    });
    expect(adapter instanceof JUnitTestAdapter).toBeTrue();
    expect(adapter.toolname).toBe("JUnit");
  });

  it("uses assertEquals for List return types and custom outputFilename class/package names", () => {
    const pkgDir = path.join(tempDir, "src", "main", "java", "com", "example");
    fs.mkdirSync(pkgDir, { recursive: true });
    const javaPath = path.join(pkgDir, "ListHarness.java");
    fs.writeFileSync(
      javaPath,
      `package com.example;

import java.util.List;
import java.util.Arrays;

public class ListHarness {
    public static List<String> getItems(String a) {
        return Arrays.asList(a, "OK");
    }

    public static String[] getArray(String a) {
        return new String[]{ a, "OK" };
    }
}
`
    );

    const tests: FuzzTests = {
      version: "0.4.0",
      functions: {
        getItems: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                { name: "0", offset: 0, value: "hi", origin: { type: "user" } },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  value: ["hi", "OK"],
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
        getArray: {
          options: makeOptions({ useHuman: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                { name: "0", offset: 0, value: "hi", origin: { type: "user" } },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                {
                  name: "0",
                  offset: 0,
                  value: ["hi", "OK"],
                  origin: { type: "user" },
                },
              ],
            },
          },
          isVoid: false,
        },
      },
    };

    const customOut = path.join(
      tempDir,
      "src",
      "test",
      "java",
      "CustomSuiteTest.java"
    );
    const adapter = new JUnitTestAdapter(tests, javaPath, customOut);
    expect(adapter.filename).toBe(customOut);
    const out = adapter.toString();

    expect(out).not.toContain("package ");
    expect(out).toContain("public class CustomSuiteTest {");
    expect(out).toContain('com.example.ListHarness.getItems("hi")');
    expect(out).toContain(
      'assertEquals(new java.util.ArrayList<>(java.util.Arrays.asList("hi", "OK")), actual);'
    );
    expect(out).toContain(
      'assertArrayEquals(new String[]{ "hi", "OK" }, actual);'
    );
  });

  it("compiles synthesized Java regression tests via javac with runtime jar", () => {
    const pkgDir = path.join(tempDir, "com", "test");
    fs.mkdirSync(pkgDir, { recursive: true });

    const srcPath = path.join(pkgDir, "Calc.java");
    fs.writeFileSync(
      srcPath,
      `package com.test;

public class Calc {
    public static int add(int a, int b) {
        return a + b;
    }
}
`
    );

    const tests: FuzzTests = {
      version: "0.4.0",
      functions: {
        add: {
          options: makeOptions({ useHuman: true, useImplicit: true }),
          validators: [],
          tests: {
            "0": {
              input: [
                { name: "0", offset: 0, value: 3, origin: { type: "user" } },
                { name: "1", offset: 1, value: 4, origin: { type: "user" } },
              ],
              output: [],
              pinned: true,
              expectedOutput: [
                { name: "0", offset: 0, value: 7, origin: { type: "user" } },
              ],
            },
          },
          isVoid: false,
        },
      },
    };

    const adapter = new JUnitTestAdapter(tests, srcPath);
    const testSrc = adapter.toString();
    const testFilePath = adapter.filename;
    fs.writeFileSync(testFilePath, testSrc, "utf8");

    const runtimeJar = findRuntimeJar();
    const m2Repo = path.join(os.homedir(), ".m2", "repository");
    const junitApiJar = path.join(
      m2Repo,
      "org",
      "junit",
      "jupiter",
      "junit-jupiter-api",
      "5.10.2",
      "junit-jupiter-api-5.10.2.jar"
    );
    const opentestJar = path.join(
      m2Repo,
      "org",
      "opentest4j",
      "opentest4j",
      "1.3.0",
      "opentest4j-1.3.0.jar"
    );

    if (
      runtimeJar &&
      fs.existsSync(runtimeJar) &&
      fs.existsSync(junitApiJar) &&
      fs.existsSync(opentestJar)
    ) {
      const sep = process.platform === "win32" ? ";" : ":";
      const cp = [tempDir, runtimeJar, junitApiJar, opentestJar].join(sep);
      const javac = JavaCompiler.resolveJavac() ?? "javac";

      const res = spawnSync(
        javac,
        ["-nowarn", "-cp", cp, srcPath, testFilePath],
        {
          cwd: tempDir,
          encoding: "utf8",
        }
      );

      expect(res.status).toBe(0);
    }
  });
});
