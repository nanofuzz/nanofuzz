import { JavascriptRunner } from "./JavascriptRunner";
import { FuzzEnv, FuzzTestResults } from "../../Fuzzer";
import { ArgDef } from "../../analysis/ArgDef";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import * as Parser from "../../adapters/ParserAdapter";
import * as Config from "../../../Config";
import { TypescriptCoverageMeasure } from "../../measures/TypescriptCoverageMeasure";
import { FileCoverageData } from "istanbul-lib-coverage";
import { normalizePathForKey } from "../../Util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("fuzzer/runners/JavascriptRunner", () => {
  beforeAll(async () => {
    await Parser.init();
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
    const realJsPath = fs.realpathSync(jsPath);
    const measure = new TypescriptCoverageMeasure();
    const instJsCode = measure.onAfterCompile(rawJsCode, realJsPath);
    fs.writeFileSync(realJsPath, instJsCode);

    try {
      const runner = new JavascriptRunner(realJsPath, "absVal");
      await runner.onRunStart();

      // 1. Check runner.coverageInfo immediately after onRunStart before running any test inputs.
      // Expect initialCoverage sent on host connect to contain statementMap, fnMap, and branchMap.
      const initialCov = runner.coverageInfo as Record<
        string,
        FileCoverageData
      >;
      expect(initialCov).toBeDefined();
      const normPath = normalizePathForKey(realJsPath);
      const fileCov = initialCov?.[normPath] ?? initialCov?.[jsPath];
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

      // 2. Execute a test run and check runner.coverageInfo afterwards.
      // Expect runner.coverageInfo to STILL retain statementMap, fnMap, and branchMap,
      // not just stripped hit counters {s, f, b}.
      const res = await runner.run([5], 2000);
      expect(res.result.tag).toBe("value");

      const runCov = runner.coverageInfo as Record<string, FileCoverageData>;
      expect(runCov).toBeDefined();
      const runFileCov = runCov?.[normPath] ?? runCov?.[jsPath];
      expect(runFileCov).toBeDefined();
      expect(runFileCov?.statementMap).toBeDefined();
      expect(
        Object.keys(runFileCov?.statementMap ?? {}).length
      ).toBeGreaterThan(0);
      expect(runFileCov?.fnMap).toBeDefined();
      expect(
        Object.keys(runFileCov?.fnMap ?? {}).length
      ).toBeGreaterThanOrEqual(2);

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
});
