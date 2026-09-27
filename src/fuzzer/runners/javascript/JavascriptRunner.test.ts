import { JavascriptRunner } from "./JavascriptRunner";
import { FileCoverageData } from "istanbul-lib-coverage";
import {
  FuzzEnv,
  FuzzGeneratorStatsBase,
  FuzzStopReason,
  FuzzTestResult,
  FuzzTestResults,
} from "../../Fuzzer";
import { ArgDef } from "../../analysis/ArgDef";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import * as Parser from "../../adapters/ParserAdapter";
import * as Config from "../../../Config";
import {
  TypescriptCoverageMeasure,
  isCoverageMapData,
} from "../../measures/TypescriptCoverageMeasure";
import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("fuzzer/runners/JavascriptRunner", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  afterEach(() => {
    Config.override("nanofuzz.fuzzer.coverageScope", "project static");
  });

  it("subprocess run and return result", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-jsrunner-"));
    const jsPath = path.join(tmpDir, "testModule.js");
    const jsCode = `
function add(a, b) {
  return a + b;
}
module.exports = { add };
`;
    fs.writeFileSync(jsPath, jsCode);

    try {
      const runner = new JavascriptRunner(jsPath, "add");
      await runner.onRunStart();

      const res = await runner.run([3, 4], 2000);
      await runner.onRunEnd();

      expect(res.result.tag).toBe("value");
      if (res.result.tag === "value") {
        expect(res.result.value).toBe(7);
      }
    } finally {
      try {
        fs.rmSync(tmpDir, {
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

  it("Uint8Array, Set, and Map arguments", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-jsrunner-"));
    const jsPath = path.join(tmpDir, "typesModule.js");
    const jsCode = `
function processTypes(bytes, mySet, myMap) {
  if (!(bytes instanceof Uint8Array)) throw new Error("bytes must be Uint8Array");
  if (!(mySet instanceof Set)) throw new Error("mySet must be Set");
  if (!(myMap instanceof Map)) throw new Error("myMap must be Map");
  return {
    bytesLength: bytes.length,
    setSize: mySet.size,
    mapVal: myMap.get("key"),
  };
}
module.exports = { processTypes };
`;
    fs.writeFileSync(jsPath, jsCode);

    try {
      const srcCode = `
export function processTypes(bytes: Uint8Array, mySet: Set<string>, myMap: Map<string, number>) {
}
`;
      const program = ProgramFactory.fromSource(
        () => srcCode,
        "typescript",
        jsPath
      );
      const fnDef = program.functionsExported["processTypes"];
      const env: FuzzEnv = {
        function: fnDef,
        options: {
          argDefaults: ArgDef.getDefaultOptions(),
          maxTests: 100,
          maxDupeInputs: 100,
          maxFailures: 0,
          fnTimeout: 100,
          suiteTimeout: 0,
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
            MutationInputGenerator: { enabled: true },
            AiInputGenerator: { enabled: false },
          },
        },
        validators: [],
        transformers: [],
      };

      const runner = new JavascriptRunner(jsPath, "processTypes", env);
      await runner.onRunStart();

      const bytes = new Uint8Array([1, 2, 3]);
      const mySet = new Set(["a", "b"]);
      const myMap = new Map([["key", 42]]);

      const res = await runner.run([bytes, mySet, myMap], 2000);
      await runner.onRunEnd();

      expect(res.result.tag).toBe("value");
      if (res.result.tag === "value") {
        expect(res.result.value).toEqual({
          bytesLength: 3,
          setSize: 2,
          mapVal: 42,
        });
      }
    } finally {
      try {
        fs.rmSync(tmpDir, {
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

  it("subprocess timeouts and errors", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-jsrunner-"));
    const jsPath = path.join(tmpDir, "errorModule.js");
    const jsCode = `
function throwErr() {
  throw new Error("test error");
}
function infiniteLoop() {
  while (true) {}
}
module.exports = { throwErr, infiniteLoop };
`;
    fs.writeFileSync(jsPath, jsCode);

    try {
      const errRunner = new JavascriptRunner(jsPath, "throwErr");
      await errRunner.onRunStart();
      const errRes = await errRunner.run([], 2000);
      await errRunner.onRunEnd();

      expect(errRes.result.tag).toBe("error");
      if (errRes.result.tag === "error") {
        expect(errRes.result.message).toContain("test error");
      }

      const loopRunner = new JavascriptRunner(jsPath, "infiniteLoop");
      await loopRunner.onRunStart();
      const loopRes = await loopRunner.run([], 100);
      await loopRunner.onRunEnd();

      expect(loopRes.result.tag).toBe("timeout");
    } finally {
      try {
        fs.rmSync(tmpDir, {
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

  it("subprocess crash recovery", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-jsrunner-"));
    const jsPath = path.join(tmpDir, "crashModule.js");
    const jsCode = `
function crash() {
  process.exit(1);
}
function ok() {
  return "recovered";
}
module.exports = { crash, ok };
`;
    fs.writeFileSync(jsPath, jsCode);

    try {
      const runner = new JavascriptRunner(jsPath, "crash");
      await runner.onRunStart();

      // First run crashes the process
      const crashRes = await runner.run([], 2000);
      expect(crashRes.result.tag).toBe("error");
      if (crashRes.result.tag === "error") {
        expect(crashRes.result.message).toContain("Host exited unexpectedly");
      }

      // Next run should automatically spawn a new host and succeed
      const recoveredRunner = new JavascriptRunner(jsPath, "ok");
      const okRes = await recoveredRunner.run([], 2000);
      expect(okRes.result.tag).toBe("value");
      if (okRes.result.tag === "value") {
        expect(okRes.result.value).toBe("recovered");
      }

      await recoveredRunner.onRunEnd();
    } finally {
      try {
        fs.rmSync(tmpDir, {
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

  it("timeout coverage data is retained", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-jsrunner-"));
    const jsPath = path.join(tmpDir, "timeoutModule.js");
    const jsCode = `
function loopTimeout(n) {
  let a = 1;
  while (true) {
    /* infinite loop */
  }
}
module.exports = { loopTimeout };
`;
    fs.writeFileSync(jsPath, jsCode);

    try {
      let capturedCov: unknown;
      const runner = new JavascriptRunner(jsPath, "loopTimeout");
      runner.onCoverage((cov) => {
        capturedCov = cov;
      });
      await runner.onRunStart();

      const timeoutRes = await runner.run([5], 100);
      expect(timeoutRes.result.tag).toBe("timeout");
      expect(capturedCov).toBeDefined();

      await runner.onRunEnd();
    } finally {
      try {
        fs.rmSync(tmpDir, {
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

  it("heartbeat: keep long-running startups alive", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-jsrunner-"));
    const jsPath = path.join(tmpDir, "slowModule.js");
    const jsCode = `
const start = Date.now();
while (Date.now() - start < 1500) {} // busy wait 1.5s during require()

function slowAdd(a, b) {
  return a + b;
}
module.exports = { slowAdd };
`;
    fs.writeFileSync(jsPath, jsCode);
    const hostStartupTimeout = Config.get(
      "nanofuzz.fuzzer.hostStartupTimeout",
      10000
    );

    try {
      // Set hostStartupTimeout to 500ms. Without heartbeats (sent every 250ms),
      // a 1.5s require() would time out at t=500ms. Heartbeats reset the 500ms clock,
      // allowing the 1.5s import to succeed cleanly.
      Config.override("nanofuzz.fuzzer.hostStartupTimeout", 1000);

      const runner = new JavascriptRunner(jsPath, "slowAdd");
      const start = performance.now();
      await runner.onRunStart();
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(1400);

      const res = await runner.run([3, 4], 2000);
      await runner.onRunEnd();

      expect(res.result.tag).toBe("value");
      if (res.result.tag === "value") {
        expect(res.result.value).toBe(7);
      }
    } finally {
      Config.override("nanofuzz.fuzzer.hostStartupTimeout", hostStartupTimeout);
      try {
        fs.rmSync(tmpDir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // ignore
      }
    }
  }, 10000);

  it("static coverage: static maps", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-static-js-")
    );
    const jsPath = path.join(tmpDir, "staticModule.js");
    const rawJsCode = `
function absVal(x) {
  if (x >= 0) {
    return x;
  } else {
    return -x;
  }
}
function deadCode() {
  return 999;
}
module.exports = { absVal, deadCode };
`;
    fs.writeFileSync(jsPath, rawJsCode);
    const measure = new TypescriptCoverageMeasure();
    const instJsCode = measure.onAfterCompile(rawJsCode, jsPath);
    fs.writeFileSync(jsPath, instJsCode);

    try {
      const runner = new JavascriptRunner(jsPath, "absVal");
      await runner.onRunStart();

      // 1. Check runner.coverageInfo immediately after onRunStart before running any test inputs.
      // Expect initialCoverage sent on host connect to contain statementMap, fnMap, and branchMap.
      const initialCov = runner.coverageInfo;
      expect(isCoverageMapData(initialCov)).toBeTrue();
      if (isCoverageMapData(initialCov)) {
        const fileCov = initialCov[Object.keys(initialCov)[0]];
        expect(fileCov).toBeDefined();
        expect(fileCov?.statementMap).toBeDefined();
        expect(Object.keys(fileCov?.statementMap ?? {}).length).toBeGreaterThan(
          0
        );
        expect(fileCov?.fnMap).toBeDefined();
        expect(Object.keys(fileCov?.fnMap ?? {}).length).toBeGreaterThanOrEqual(
          2
        );
        expect(fileCov?.branchMap).toBeDefined();
      }

      // 2. Execute a test run and check runner.coverageInfo afterwards.
      // Expect runner.coverageInfo to STILL retain statementMap, fnMap, and branchMap,
      // not just stripped hit counters {s, f, b}.
      const res = await runner.run([5], 2000);
      expect(res.result.tag).toBe("value");

      const runCov = runner.coverageInfo;
      expect(isCoverageMapData(runCov)).toBeTrue();
      if (isCoverageMapData(runCov)) {
        const runFileCov = runCov[Object.keys(runCov)[0]];
        expect(runFileCov).toBeDefined();
        expect(runFileCov?.statementMap).toBeDefined();
        expect(
          Object.keys(runFileCov?.statementMap ?? {}).length
        ).toBeGreaterThan(0);
        expect(runFileCov?.fnMap).toBeDefined();
        expect(
          Object.keys(runFileCov?.fnMap ?? {}).length
        ).toBeGreaterThanOrEqual(2);
      }

      await runner.onRunEnd();
    } finally {
      try {
        fs.rmSync(tmpDir, {
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

  it("static and dynamic coverage for top-level snippet", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-usersnippet-js-")
    );
    const tsPath = path.join(tmpDir, "userSnippet.ts");
    const jsPath = path.join(tmpDir, "userSnippet.js");
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
    fs.writeFileSync(tsPath, tsCode);
    const out = ts.transpileModule(tsCode, {
      fileName: tsPath,
      compilerOptions: {
        sourceMap: true,
        inlineSources: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    });
    fs.writeFileSync(jsPath, out.outputText);
    fs.writeFileSync(jsPath + ".map", out.sourceMapText!);
    const realJsPath = fs.realpathSync(jsPath);

    const measure = new TypescriptCoverageMeasure();
    const instJsCode = measure.onAfterCompile(out.outputText, realJsPath);
    fs.writeFileSync(realJsPath, instJsCode);

    try {
      const runner = new JavascriptRunner(realJsPath, "x");
      await runner.onRunStart();

      // Attach TypescriptCoverageMeasure to runner
      measure.onRunStart([runner]);

      // 1. Initial static coverage on host connect before test execution
      const initialCov = runner.coverageInfo;
      expect(isCoverageMapData(initialCov)).toBeTrue();
      if (isCoverageMapData(initialCov)) {
        const fileKey = Object.keys(initialCov)[0];
        const rawCov = structuredClone(initialCov[fileKey]);
        const fileCov: FileCoverageData = {
          path: "<TEMP_JS_PATH>",
          statementMap: rawCov.statementMap,
          fnMap: rawCov.fnMap,
          branchMap: rawCov.branchMap,
          s: rawCov.s,
          f: rawCov.f,
          b: rawCov.b,
        };

        expect(fileCov).toEqual({
          path: "<TEMP_JS_PATH>",
          statementMap: {
            "0": {
              start: { line: 2, column: 0 },
              end: { line: 2, column: 62 },
            },
            "1": {
              start: { line: 3, column: 0 },
              end: { line: 3, column: 14 },
            },
            "2": { start: { line: 4, column: 8 }, end: { line: 4, column: 9 } },
            "3": { start: { line: 5, column: 0 }, end: { line: 5, column: 4 } },
            "4": { start: { line: 6, column: 8 }, end: { line: 6, column: 9 } },
            "5": { start: { line: 7, column: 0 }, end: { line: 7, column: 6 } },
            "6": {
              start: { line: 9, column: 4 },
              end: { line: 9, column: 13 },
            },
          },
          fnMap: {
            "0": {
              name: "x",
              decl: {
                start: { line: 8, column: 9 },
                end: { line: 8, column: 10 },
              },
              loc: {
                start: { line: 8, column: 16 },
                end: { line: 10, column: 1 },
              },
              line: 8,
            },
          },
          branchMap: {},
          s: { "0": 1, "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 0 },
          f: { "0": 0 },
          b: {},
        });
      }

      // 2. Execute test run calling function x([])
      const res = await runner.run([[]], 2000);
      expect(res.result.tag).toBe("value");

      if (res.result.tag === "value") {
        const testResult: FuzzTestResult = {
          pinned: false,
          inputGenerated: {
            tick: 0,
            value: [],
            source: {
              type: "generator",
              generator: "RandomInputGenerator",
            },
          },
          input: [],
          output: [],
          exception: false,
          skipped: false,
          timeout: false,
          passedImplicit: "pass",
          passedHuman: "unknown",
          passedValidator: "pass",
          passedValidators: [],
          harnessErrors: [],
          timers: { gen: 0, transform: 0, run: 0 },
          category: "ok",
          interestingReasons: [],
        };

        measure.measure(
          {
            tick: 0,
            value: [
              {
                tag: "ArgValueTypeWrapped",
                value: [[]],
              },
            ],
            source: {
              type: "generator",
              generator: "RandomInputGenerator",
            },
          },
          testResult
        );
      }

      const dummyGenStats: FuzzGeneratorStatsBase = {
        counters: { inputsGenerated: 0, dupesGenerated: 0, dupeTicks: [] },
        timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
      };

      const resultsStub: FuzzTestResults = {
        toolVersion: "0.0.0",
        env: {
          options: {
            argDefaults: ArgDef.getDefaultOptions(),
            maxTests: 1,
            maxDupeInputs: 1,
            maxFailures: 0,
            fnTimeout: 100,
            suiteTimeout: 1000,
            useImplicit: true,
            useHuman: false,
            useProperty: false,
            useTransformer: false,
            measures: {
              FailedTestMeasure: { enabled: false, weight: 0 },
              CoverageMeasure: { enabled: true, weight: 1 },
            },
            generators: {
              RandomInputGenerator: { enabled: true },
              MutationInputGenerator: { enabled: false },
              AiInputGenerator: { enabled: false },
            },
          },
          function: ProgramFactory.fromSource(
            () => tsCode,
            "typescript",
            tsPath
          ).functionsExported["x"],
          validators: [],
          transformers: [],
        },
        stopReason: FuzzStopReason.MAXTESTS,
        interesting: { inputs: [] },
        results: [],
        stats: {
          counters: {
            testingRuns: 1,
            inputsGenerated: 1,
            dupesGenerated: 0,
            inputsInjected: 0,
            erroredTests: 0,
            passedTests: 1,
            inputsSkipped: 0,
            failedTests: 0,
          },
          timers: {
            total: 10,
            compile: 0,
            instrument: 0,
            put: 10,
            val: 0,
            gen: 0,
            transform: 0,
            measure: 0,
          },
          generators: {
            RandomInputGenerator: dummyGenStats,
            MutationInputGenerator: dummyGenStats,
            AiInputGenerator: dummyGenStats,
          },
          measures: {},
        },
      };

      measure.onRunEnd(resultsStub);
      const stats = await resultsStub.stats.measures.CodeCoverageMeasure!();
      expect(stats.counters.statementsTotal).toBe(6);
      expect(stats.counters.functionsTotal).toBe(1);
      expect(stats.counters.statementsCovered).toBe(6);
      expect(stats.counters.functionsCovered).toBe(1);

      const fileMapNoPath = structuredClone(stats.files[0].fileMap.data);
      fileMapNoPath.path = "<TEMP_TS_PATH>";
      expect(fileMapNoPath).toEqual({
        path: "<TEMP_TS_PATH>",
        statementMap: {
          "0": {
            start: { line: 6, column: 0 },
            end: { line: 6, column: 16 },
          },
          "1": {
            start: { line: 1, column: 8 },
            end: { line: 1, column: 9 },
          },
          "2": {
            start: { line: 2, column: 0 },
            end: { line: 2, column: 4 },
          },
          "3": {
            start: { line: 3, column: 8 },
            end: { line: 3, column: 9 },
          },
          "4": {
            start: { line: 4, column: 0 },
            end: { line: 4, column: 6 },
          },
          "5": {
            start: { line: 12, column: 2 },
            end: { line: 12, column: 11 },
          },
        },
        fnMap: {
          "0": jasmine.objectContaining({
            name: "x",
            decl: {
              start: { line: 6, column: 16 },
              end: { line: 6, column: 17 },
            },
            loc: {
              start: { line: 10, column: 5 },
              end: { line: 13, column: 1 },
            },
          }),
        },
        branchMap: {},
        s: {
          "0": 1,
          "1": 1,
          "2": 1,
          "3": 1,
          "4": 1,
          "5": 1,
        },
        f: {
          "0": 1,
        },
        b: {},
      });

      // 3. Execute 2 more test runs (total 3 test runs)
      for (let tick = 1; tick <= 2; tick++) {
        measure.onBeforeNextTestExecution();
        const r = await runner.run([[]], 2000);
        if (r.result.tag === "value") {
          measure.measure(
            {
              tick,
              value: [{ tag: "ArgValueTypeWrapped", value: [[]] }],
              source: {
                type: "generator",
                generator: "RandomInputGenerator",
              },
            },
            {
              pinned: false,
              inputGenerated: {
                tick,
                value: [],
                source: {
                  type: "generator",
                  generator: "RandomInputGenerator",
                },
              },
              input: [],
              output: [],
              exception: false,
              skipped: false,
              timeout: false,
              passedImplicit: "pass",
              passedHuman: "unknown",
              passedValidator: "pass",
              passedValidators: [],
              harnessErrors: [],
              timers: { gen: 0, transform: 0, run: 0 },
              category: "ok",
              interestingReasons: [],
            }
          );
        }
      }

      measure.onRunEnd(resultsStub);
      const statsAfter3 =
        await resultsStub.stats.measures.CodeCoverageMeasure!();
      const fileMapAfter3 = JSON.parse(
        JSON.stringify(statsAfter3.files[0].fileMap)
      );
      delete fileMapAfter3.path;

      // Top-level statements MUST stay at 1 (from initial load, not accumulating),
      // while statement "5" inside x() MUST accumulate to 3 (1 hit per run * 3 runs).
      expect(fileMapAfter3.s).toEqual({
        "0": 1,
        "1": 1,
        "2": 1,
        "3": 1,
        "4": 1,
        "5": 3,
      });

      await runner.onRunEnd();
    } finally {
      try {
        fs.rmSync(tmpDir, {
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

  it("resolves node_modules dependencies from the original project directory", async () => {
    const projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-project-")
    );
    const nodeModulesDir = path.join(projectDir, "node_modules", "custom_dep");
    fs.mkdirSync(nodeModulesDir, { recursive: true });

    // Mock a package inside node_modules
    fs.writeFileSync(
      path.join(nodeModulesDir, "package.json"),
      JSON.stringify({ name: "custom_dep", main: "index.js" })
    );
    fs.writeFileSync(
      path.join(nodeModulesDir, "index.js"),
      "module.exports = { value: 42 };"
    );

    // Target module that requires the package
    const jsPath = path.join(projectDir, "target.js");
    fs.writeFileSync(
      jsPath,
      `
const dep = require('custom_dep');
function getVal() {
  return dep.value;
}
module.exports = { getVal };
`
    );

    try {
      const runner = new JavascriptRunner(jsPath, "getVal");
      await runner.onRunStart();

      const res = await runner.run([], 2000);
      await runner.onRunEnd();

      expect(res.result.tag).toBe("value");
      if (res.result.tag === "value") {
        expect(res.result.value).toBe(42);
      }
    } finally {
      try {
        fs.rmSync(projectDir, {
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

  it("skips static coverage at init when 'static' is NOT in coverageScope", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-nostatic-js-")
    );
    const tsPath = path.join(tmpDir, "noStatic.ts");
    const jsPath = path.join(tmpDir, "noStatic.js");
    const tsCode = `let z = 1;
export function x(): number {
  return 1;
}
`;
    fs.writeFileSync(tsPath, tsCode);
    const out = ts.transpileModule(tsCode, {
      fileName: tsPath,
      compilerOptions: {
        sourceMap: true,
        inlineSources: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    });
    fs.writeFileSync(jsPath, out.outputText);
    fs.writeFileSync(jsPath + ".map", out.sourceMapText!);
    const realJsPath = fs.realpathSync(jsPath);

    Config.override("nanofuzz.fuzzer.coverageScope", "project");
    const measure = new TypescriptCoverageMeasure();
    const instJsCode = measure.onAfterCompile(out.outputText, realJsPath);
    fs.writeFileSync(realJsPath, instJsCode);

    try {
      const runner = new JavascriptRunner(realJsPath, "x");
      await runner.onRunStart();
      measure.onRunStart([runner]);

      // Initial coverage at startup has 0 covered statements when static is not in coverageScope
      const initialCov = runner.coverageInfo;
      expect(isCoverageMapData(initialCov)).toBeTrue();

      // Dynamic coverage is still collected during test execution
      const res = await runner.run([], 2000);
      expect(res.result.tag).toBe("value");

      if (res.result.tag === "value") {
        const testResult: FuzzTestResult = {
          pinned: false,
          inputGenerated: {
            tick: 0,
            value: [],
            source: {
              type: "generator",
              generator: "RandomInputGenerator",
            },
          },
          input: [],
          output: [],
          exception: false,
          skipped: false,
          timeout: false,
          passedImplicit: "pass",
          passedHuman: "unknown",
          passedValidator: "pass",
          passedValidators: [],
          harnessErrors: [],
          timers: { gen: 0, transform: 0, run: 0 },
          category: "ok",
          interestingReasons: [],
        };

        measure.measure(
          {
            tick: 0,
            value: [],
            source: {
              type: "generator",
              generator: "RandomInputGenerator",
            },
          },
          testResult
        );
      }

      const dummyGenStats: FuzzGeneratorStatsBase = {
        counters: { inputsGenerated: 0, dupesGenerated: 0, dupeTicks: [] },
        timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
      };

      const resultsStub: FuzzTestResults = {
        toolVersion: "0.0.0",
        env: {
          options: {
            argDefaults: ArgDef.getDefaultOptions(),
            maxTests: 1,
            maxDupeInputs: 1,
            maxFailures: 0,
            fnTimeout: 100,
            suiteTimeout: 1000,
            useImplicit: true,
            useHuman: false,
            useProperty: false,
            useTransformer: false,
            measures: {
              FailedTestMeasure: { enabled: false, weight: 0 },
              CoverageMeasure: { enabled: true, weight: 1 },
            },
            generators: {
              RandomInputGenerator: { enabled: true },
              MutationInputGenerator: { enabled: false },
              AiInputGenerator: { enabled: false },
            },
          },
          function: ProgramFactory.fromSource(
            () => tsCode,
            "typescript",
            tsPath
          ).functionsExported["x"],
          validators: [],
          transformers: [],
        },
        stopReason: FuzzStopReason.MAXTESTS,
        interesting: { inputs: [] },
        results: [],
        stats: {
          counters: {
            testingRuns: 1,
            inputsGenerated: 1,
            dupesGenerated: 0,
            inputsInjected: 0,
            erroredTests: 0,
            passedTests: 1,
            inputsSkipped: 0,
            failedTests: 0,
          },
          timers: {
            total: 10,
            compile: 0,
            instrument: 0,
            put: 10,
            val: 0,
            gen: 0,
            transform: 0,
            measure: 0,
          },
          generators: {
            RandomInputGenerator: dummyGenStats,
            MutationInputGenerator: dummyGenStats,
            AiInputGenerator: dummyGenStats,
          },
          measures: {},
        },
      };

      measure.onRunEnd(resultsStub);
      const stats = await resultsStub.stats.measures.CodeCoverageMeasure!();
      expect(stats.counters.statementsTotal).toBe(3);
      expect(stats.counters.functionsTotal).toBe(1);
      expect(stats.counters.statementsCovered).toBe(1);
      expect(stats.counters.functionsCovered).toBe(1);

      await runner.onRunEnd();
    } finally {
      Config.override("nanofuzz.fuzzer.coverageScope", "project static");
      try {
        fs.rmSync(tmpDir, {
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
