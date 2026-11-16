import * as vm from "vm";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";
import { FileCoverage } from "istanbul-lib-coverage";
import {
  CoverageMeasure,
  isCoverageMapData,
  isRecordOfFileCoverageData,
} from "./CoverageMeasure";
import { JavascriptRunner } from "../runners/javascript/JavascriptRunner";
import * as Config from "../../Config";
import { VmGlobals } from "../Types";
import { normalizePathForKey } from "../Util";
import {
  inputAt,
  anyResult,
  coveredCounts,
  statsOf,
} from "./CoverageMeasureTestHelper";
import {
  linearSource as jsSrcLinear,
  logicalSource as jsSrcLogical,
  multiFunctionSource as jsSrcTwoFns,
  switchSource as jsSrcSwitch,
  ternarySource as jsSrcTernary,
  twoPathSource as jsSrc,
} from "./test_fixtures/CoverageMeasure.testfixture1";
import {
  multiFunctionSource as tsSrcTwoFns,
  twoPathSource as tsSrc,
} from "./test_fixtures/CoverageMeasure.testfixture2";

/**
 * Exposes protected state to drive onAfterCompile and onAfterLoad in tests.
 */
class TestCoverageMeasure extends CoverageMeasure {}

type NumericFn = (n: number) => number;

type TsProgram = {
  tsFile: string;
  jsFile: string;
  js: string;
};

describe("fuzzer/measures/CoverageMeasure: TypeScript / JavaScript", () => {
  const jsFileName = "/tmp/absValue.js";

  const load = (
    binds = 1,
    src = jsSrc
  ): {
    measure: TestCoverageMeasure;
    context: VmGlobals;
    absValue: (n: number) => number;
  } => {
    const measure = new TestCoverageMeasure();
    const { context, absValue } = runInSandbox(
      measure.onAfterCompile(src, jsFileName),
      jsFileName
    );
    for (let i = 0; i < binds; i++) {
      measure.onAfterLoad(context);
    }
    return { measure, context, absValue };
  }; // fn: load

  const runTest = (
    measure: TestCoverageMeasure,
    absValue: (n: number) => number,
    n: number
  ) => {
    measure.onBeforeNextTestExecution();
    absValue(n);
    return measure.measure(inputAt(0), anyResult);
  }; // fn: runTest

  const coverageOfCall = (src: string, n: number): FileCoverage => {
    const { measure, absValue } = load(1, src);
    measure.onBeforeNextTestExecution();
    absValue(n);
    return measure
      .measure(inputAt(0), anyResult)
      .coverageMeasure.current.fileCoverageFor(jsFileName);
  }; // fn: coverageOfCall

  // ------------------------------------------------------------------
  // Instrumentation & Context Ingestion
  // ------------------------------------------------------------------
  describe("instrumentation and context binding", () => {
    it("onAfterCompile preserves the program's behavior", () => {
      const measure = new TestCoverageMeasure();
      const instrumented = measure.onAfterCompile(jsSrc, "/tmp/absValue.js");

      expect(instrumented).not.toEqual(jsSrc);

      const plain = runInSandbox(jsSrc, "/tmp/absValue.js");
      const covered = runInSandbox(instrumented, "/tmp/absValue.js");

      for (const n of [-3, 0, 7]) {
        expect(covered.absValue(n)).toEqual(plain.absValue(n));
      }
    });

    it("onAfterCompile emits counters keyed by the supplied filename", () => {
      const measure = new TestCoverageMeasure();
      const targetJs = "/tmp/absValue.js";
      const { context, absValue } = runInSandbox(
        measure.onAfterCompile(jsSrc, targetJs),
        targetJs
      );

      const data = coverageOf(context);
      expect(isCoverageMapData(data)).toBeTrue();
      expect(Object.keys(data)).toEqual([targetJs]);
      expect(data[targetJs].path).toEqual(targetJs);

      expect(Object.keys(data[targetJs].fnMap).length).toEqual(1);
      expect(Object.keys(data[targetJs].branchMap).length).toEqual(1);
      expect(Object.values(data[targetJs].f)).toEqual([0]);

      absValue(-3);

      expect(data[targetJs].f[0]).toEqual(1);
      expect(data[targetJs].b[0]).toEqual([1, 0]);
      expect(Object.values(data[targetJs].s).some((s) => s === 0)).toBeTrue();
    });

    it("onAfterLoad accepts the context of any module it instrumented", () => {
      const sources = [
        jsSrc,
        "const absValue = (n) => (n < 0 ? -n : n);\nmodule.exports = { absValue };\n",
        "function absValue(n) { return n; }\nmodule.exports = { absValue };\n",
      ];

      sources.forEach((src, i) => {
        const file = `/tmp/absValue${i}.js`;
        const measure = new TestCoverageMeasure();
        const { context } = runInSandbox(
          measure.onAfterCompile(src, file),
          file
        );
        expect(() => measure.onAfterLoad(context)).not.toThrow();
      });
    });

    it("onAfterLoad throws on a context without valid coverage data", () => {
      const validEntry = {
        path: "/tmp/absValue.js",
        statementMap: {},
        fnMap: {},
        branchMap: {},
        s: {},
        f: {},
        b: {},
      };
      const badContexts: Record<string, VmGlobals> = {
        "no global": {},
        "undefined global": { global: undefined },
        "null global": { global: null },
        "non-object global": { global: "global" },
        "global without __coverage__": { global: {} },
        "null coverage": { global: { __coverage__: null } },
        "non-object coverage": { global: { __coverage__: "coverage" } },
        "array coverage": { global: { __coverage__: [] } },
        "coverage entry missing counters": {
          global: { __coverage__: { "/tmp/absValue.js": { path: "/x.js" } } },
        },
        "coverage entry missing branch counters": {
          global: {
            __coverage__: {
              "/tmp/absValue.js": { ...validEntry, b: undefined },
            },
          },
        },
      };

      for (const [name, context] of Object.entries(badContexts)) {
        expect(() => new TestCoverageMeasure().onAfterLoad(context))
          .withContext(name)
          .toThrow();
      }

      expect(() =>
        new TestCoverageMeasure().onAfterLoad({ global: { __coverage__: {} } })
      ).not.toThrow();
    });

    it("onAfterLoad leaves an existing binding intact when a later load is rejected", () => {
      const { measure, absValue } = load();

      measure.onBeforeNextTestExecution();
      absValue(-3);
      const before = coveredCounts(
        measure.measure(inputAt(0), anyResult).coverageMeasure.current
      );
      expect(before.functions).toEqual(1);

      expect(() => measure.onAfterLoad({ global: {} })).toThrow();

      expect(
        coveredCounts(measure.getCoverage(0).coverageMeasure.current)
      ).toEqual(before);

      measure.onBeforeNextTestExecution();
      absValue(-3);
      expect(
        coveredCounts(
          measure.measure(inputAt(1), anyResult).coverageMeasure.current
        )
      ).toEqual(before);
    });

    it("measure reports no coverage before onAfterLoad has bound a module", () => {
      const measure = new TestCoverageMeasure();
      const meas = measure.measure(inputAt(0), anyResult);

      expect(meas.coverageMeasure.current.files()).toEqual([]);
      expect(coveredCounts(meas.coverageMeasure.current)).toEqual({
        functions: 0,
        statements: 0,
        branches: 0,
      });
      expect(measure.delta(meas)).toEqual(0);
    });
  });

  // ------------------------------------------------------------------
  // In-Memory Counter Resets
  // ------------------------------------------------------------------
  describe("counter resets", () => {
    it("onBeforeNextTestExecution zeroes every counter in the coverage data", () => {
      const { measure, context, absValue } = load(1, jsSrcSwitch);

      absValue(0);
      absValue(1);
      absValue(9);
      const before = coverageOf(context)[jsFileName];
      expect(before.s).toEqual({ 0: 3, 1: 1, 2: 1, 3: 1, 4: 1 });
      expect(before.f).toEqual({ 0: 3 });
      expect(before.b).toEqual({ 0: [1, 1, 1] });

      measure.onBeforeNextTestExecution();

      const after = coverageOf(context)[jsFileName];
      expect(after.s).toEqual({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 });
      expect(after.f).toEqual({ 0: 0 });
      expect(after.b).toEqual({ 0: [0, 0, 0] });
    });

    it("onBeforeNextTestExecution preserves everything but the counter values", () => {
      const { measure, context, absValue } = load(1, jsSrcSwitch);
      absValue(1);

      const before = JSON.parse(JSON.stringify(coverageOf(context)));
      measure.onBeforeNextTestExecution();
      const after = coverageOf(context);

      expect(Object.keys(after)).toEqual(Object.keys(before));
      const [was, is] = [before[jsFileName], after[jsFileName]];
      expect(is.path).toEqual(was.path);
      expect(is.statementMap).toEqual(was.statementMap);
      expect(is.fnMap).toEqual(was.fnMap);
      expect(is.branchMap).toEqual(was.branchMap);
      expect(Object.keys(is.s)).toEqual(Object.keys(was.s));
      expect(Object.keys(is.f)).toEqual(Object.keys(was.f));
      expect(Object.keys(is.b)).toEqual(Object.keys(was.b));
    });

    it("onBeforeNextTestExecution leaves valid coverage data behind", () => {
      const { measure, context, absValue } = load(1, jsSrcTwoFns);
      absValue(-4);

      measure.onBeforeNextTestExecution();

      expect(isCoverageMapData(coverageOf(context))).toBeTrue();
      expect(() => measure.onAfterLoad(context)).not.toThrow();
    });
  });

  // ------------------------------------------------------------------
  // JavaScript Language Branch Constructs
  // ------------------------------------------------------------------
  describe("JavaScript branch constructs", () => {
    it("measure reports statements and one function for branch-free code", () => {
      const fileCoverage = coverageOfCall(jsSrcLinear, 5);

      expect(Object.keys(fileCoverage.statementMap)).toEqual(["0", "1", "2"]);
      expect(fileCoverage.s).toEqual({ 0: 1, 1: 1, 2: 0 });
      expect(fileCoverage.fnMap[0].name).toEqual("absValue");
      expect(fileCoverage.f).toEqual({ 0: 1 });
      expect(fileCoverage.branchMap).toEqual({});
      expect(fileCoverage.b).toEqual({});
    });

    it("measure reports a ternary as a cond-expr branch of an anonymous function", () => {
      const fileCoverage = coverageOfCall(jsSrcTernary, -3);

      expect(fileCoverage.fnMap[0].name).toEqual("(anonymous_0)");
      expect(fileCoverage.fnMap[0].line).toEqual(1);
      expect(fileCoverage.f).toEqual({ 0: 1 });

      expect(Object.keys(fileCoverage.branchMap)).toEqual(["0"]);
      expect(fileCoverage.branchMap[0].type).toEqual("cond-expr");
      expect(fileCoverage.branchMap[0].line).toEqual(1);
      expect(fileCoverage.b).toEqual({ 0: [1, 0] });
    });

    it("measure counts each operand of a short-circuiting expression", () => {
      const truthy = coverageOfCall(jsSrcLogical, 7);
      expect(truthy.branchMap[0].type).toEqual("binary-expr");
      expect(truthy.branchMap[0].line).toEqual(2);
      expect(truthy.b).toEqual({ 0: [1, 0] });

      expect(coverageOfCall(jsSrcLogical, 0).b).toEqual({ 0: [1, 1] });
    });

    it("measure reports a switch as one branch with an arm per case", () => {
      const fileCoverage = coverageOfCall(jsSrcSwitch, 1);

      expect(fileCoverage.branchMap[0].type).toEqual("switch");
      expect(fileCoverage.branchMap[0].line).toEqual(2);
      expect(fileCoverage.branchMap[0].locations.length).toEqual(3);
      expect(fileCoverage.b).toEqual({ 0: [0, 1, 0] });
      expect(fileCoverage.s).toEqual({ 0: 1, 1: 0, 2: 1, 3: 0, 4: 0 });
    });

    it("measure reports every function in the file, called or not", () => {
      const fileCoverage = coverageOfCall(jsSrcTwoFns, -4);

      expect(Object.keys(fileCoverage.fnMap)).toEqual(["0", "1", "2"]);
      expect(
        Object.values(fileCoverage.fnMap).map((fn) => [fn.name, fn.line])
      ).toEqual([
        ["absValue", 1],
        ["helper", 4],
        ["neverCalled", 7],
      ]);
      expect(fileCoverage.f).toEqual({ 0: 1, 1: 1, 2: 0 });
      expect(fileCoverage.b).toEqual({ 0: [1, 0] });
    });
  });

  // ------------------------------------------------------------------
  // Source Map Remapping in onRunEnd
  // ------------------------------------------------------------------
  describe("source map remapping", () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-ts-cov-"));
    });

    afterAll(() => {
      try {
        fs.rmSync(tmpDir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // Ignore residual file locks
      }
    });

    const compileTs = (
      tsSrc: string,
      base: string,
      jsFile?: string
    ): TsProgram => {
      const tsFile = path.join(tmpDir, `${base}.ts`);
      const jsPath = jsFile ?? path.join(tmpDir, `${base}.js`);

      fs.writeFileSync(tsFile, tsSrc);
      const out = ts.transpileModule(tsSrc, {
        fileName: tsFile,
        compilerOptions: {
          sourceMap: true,
          inlineSources: true,
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      });
      if (!out.sourceMapText) {
        throw new Error(`no source map emitted for ${tsFile}`);
      }
      fs.writeFileSync(jsPath, out.outputText);
      fs.writeFileSync(`${jsPath}.map`, out.sourceMapText);

      return { tsFile, jsFile: jsPath, js: out.outputText };
    }; // fn: compileTs

    const loadTs = (
      measure: TestCoverageMeasure,
      programs: TsProgram[]
    ): Record<string, unknown>[] => {
      const module: { exports: Record<string, unknown> } = { exports: {} };
      const sandbox: VmGlobals = { module, exports: module.exports };
      sandbox.global = sandbox;
      vm.createContext(sandbox);

      const loaded: Record<string, unknown>[] = [];
      for (const program of programs) {
        module.exports = {};
        sandbox.exports = module.exports;
        vm.runInContext(
          measure.onAfterCompile(program.js, program.jsFile),
          sandbox,
          { filename: program.jsFile }
        );
        loaded.push(module.exports);
      }
      measure.onAfterLoad(sandbox);

      return loaded;
    }; // fn: loadTs

    it("static coverage: reports top-level statements as well as function statements", async () => {
      const tsCode = `let z = 1;
z++;
let q = z;
z = q;

export function x(
  obj: {
    a?: 1;
    b?: 1;
  }[]
): number {
  return 1;
}
`;
      const measure = new TestCoverageMeasure();
      const program = compileTs(tsCode, "toplevelTest");
      const [exports] = loadTs(measure, [program]);
      const xFn = fnOf(exports, "x");

      let stats = await statsOf(measure);
      expect(stats.counters.statementsTotal).toEqual(6);
      expect(stats.counters.functionsTotal).toEqual(1);
      expect(stats.counters.statementsCovered).toEqual(0);
      expect(stats.counters.functionsCovered).toEqual(0);

      runTest(measure, () => xFn(0), 0);

      stats = await statsOf(measure);
      expect(stats.counters.statementsTotal).toEqual(6);
      expect(stats.counters.functionsTotal).toEqual(1);
      expect(stats.counters.statementsCovered).toEqual(1);
      expect(stats.counters.functionsCovered).toEqual(1);
    });

    it("the stats report TypeScript locations, not the compiled JavaScript ones", async () => {
      const measure = new TestCoverageMeasure();
      const program = compileTs(tsSrc, "tsLocations");
      const [exports] = loadTs(measure, [program]);

      runTest(measure, fnOf(exports, "absValue"), -3);
      const stats = await statsOf(measure);

      expect(stats.files.length).toEqual(1);
      const file = stats.files[0];

      expect(file.path).toEqual(normalizePathForKey(program.tsFile));
      expect(file.fileMap.fnMap[0].name).toEqual("absValue");
      expect(file.fileMap.s).toEqual({ 0: 0, 1: 1, 2: 1, 3: 0 });
      expect(file.fileMap.f).toEqual({ 0: 1 });
      expect(file.fileMap.b).toEqual({ 0: [1, 0] });
    });

    it("the stats report exact counters for a run that left code uncovered", async () => {
      const measure = new TestCoverageMeasure();
      const program = compileTs(tsSrcTwoFns, "uncovered");
      const [exports] = loadTs(measure, [program]);

      runTest(measure, fnOf(exports, "absValue"), -4);
      const stats = await statsOf(measure);

      expect(stats.files.length).toEqual(1);
      const file = stats.files[0];

      expect(file.path).toEqual(normalizePathForKey(program.tsFile));
      expect(file.counters.functionsTotal).toEqual(3);
      expect(file.counters.functionsCovered).toEqual(2);
      expect(file.counters.statementsTotal).toEqual(6);
      expect(file.counters.statementsCovered).toEqual(2);
      expect(file.counters.branchesTotal).toEqual(2);
      expect(file.counters.branchesCovered).toEqual(1);
    });
  });

  // ------------------------------------------------------------------
  // Coverage Scopes: 'project static' vs 'project directimports static'
  // ------------------------------------------------------------------
  describe("coverage scopes", () => {
    it("coverage scope: 'project static' vs 'project directimports static' for TypeScript", async () => {
      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nanofuzz-ts-covscope-")
      );
      const nodeModules = path.join(testDir, "node_modules", "ext_math");
      fs.mkdirSync(nodeModules, { recursive: true });
      fs.writeFileSync(
        path.join(nodeModules, "index.js"),
        `function square(x) {
  if (x > 0) {
    return x * x;
  } else {
    return 0;
  }
}
module.exports = { square };
`
      );

      const mainTs = path.join(testDir, "main.ts");
      const mainJs = path.join(testDir, "main.js");
      const tsCode = `import { square } from "ext_math";

export function compute(n: number): number {
  return square(n) + 1;
}
`;
      fs.writeFileSync(mainTs, tsCode);
      const out = ts.transpileModule(tsCode, {
        fileName: mainTs,
        compilerOptions: {
          sourceMap: true,
          inlineSources: true,
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      });
      fs.writeFileSync(mainJs, out.outputText);
      fs.writeFileSync(mainJs + ".map", out.sourceMapText!);
      const realJs = fs.realpathSync(mainJs);

      const measure = new CoverageMeasure();
      fs.writeFileSync(realJs, measure.onAfterCompile(out.outputText, realJs));

      try {
        // 1. Default 'project static' scope
        Config.override("nanofuzz.fuzzer.coverageScope", "project static");
        const runnerProject = new JavascriptRunner(realJs, "compute");
        await runnerProject.onRunStart();
        const resProject = await runnerProject.run([4], 5000);
        expect(resProject.result.tag).toBe("value");
        if (resProject.result.tag === "value") {
          expect(resProject.result.value).toBe(17);
        }
        expect(runnerProject.coverageInfo).toBeDefined();
        const projectFiles = Object.keys(runnerProject.coverageInfo!);
        expect(
          projectFiles.some((f) => f.toLowerCase().includes("main.js"))
        ).toBeTrue();
        expect(
          projectFiles.some((f) => f.toLowerCase().includes("ext_math"))
        ).toBeFalse();
        await runnerProject.onRunEnd();

        // 2. 'project directimports static' scope
        Config.override(
          "nanofuzz.fuzzer.coverageScope",
          "project directimports static"
        );
        const runnerImports = new JavascriptRunner(realJs, "compute");
        await runnerImports.onRunStart();
        const resImports = await runnerImports.run([4], 5000);
        expect(resImports.result.tag).toBe("value");
        if (resImports.result.tag === "value") {
          expect(resImports.result.value).toBe(17);
        }
        expect(runnerImports.coverageInfo).toBeDefined();
        const importFiles = Object.keys(runnerImports.coverageInfo!);
        expect(
          importFiles.some((f) => f.toLowerCase().includes("main.js"))
        ).toBeTrue();
        expect(
          importFiles.some((f) => f.toLowerCase().includes("ext_math"))
        ).toBeTrue();

        const extFile = importFiles.find((f) =>
          f.toLowerCase().includes("ext_math")
        );
        expect(extFile).toBeDefined();
        const cov = runnerImports.coverageInfo;
        expect(cov).toBeDefined();
        expect(isRecordOfFileCoverageData(cov)).toBeTrue();
        if (isRecordOfFileCoverageData(cov)) {
          const extCov = cov[extFile!];
          expect(extCov).toBeDefined();
          expect(Object.values(extCov.f).some((h: number) => h > 0)).toBeTrue();
          expect(Object.values(extCov.s).some((h: number) => h > 0)).toBeTrue();
          expect(extCov.b["0"]).toEqual([1, 0]);
        }

        await runnerImports.onRunEnd();
      } finally {
        Config.override("nanofuzz.fuzzer.coverageScope", "project static");
        try {
          fs.rmSync(testDir, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
        } catch {
          // ignore
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNumericFn(value: unknown): value is NumericFn {
  return typeof value === "function";
} // fn: isNumericFn

function runInSandbox(
  jsSrc: string,
  jsFileName: string
): { context: VmGlobals; absValue: NumericFn } {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  const sandbox: VmGlobals = { module, exports: module.exports };
  sandbox.global = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(jsSrc, sandbox, { filename: jsFileName });

  const absValue = module.exports.absValue;
  if (!isNumericFn(absValue)) {
    throw new Error("source under test did not export absValue");
  }
  return { context: sandbox, absValue };
} // fn: runInSandbox

function coverageOf(context: VmGlobals) {
  const globals = context.global;
  const coverage =
    typeof globals === "object" && globals && "__coverage__" in globals
      ? globals.__coverage__
      : undefined;
  if (!isCoverageMapData(coverage)) {
    throw new Error("instrumented code published no coverage data");
  }
  return coverage;
} // fn: coverageOf

function fnOf(exports: Record<string, unknown>, name: string): NumericFn {
  const fn = exports[name];
  if (!isNumericFn(fn)) {
    throw new Error(`fixture did not export ${name}`);
  }
  return fn;
} // fn: fnOf
