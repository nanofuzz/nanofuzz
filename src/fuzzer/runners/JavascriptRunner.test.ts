import { JavascriptRunner } from "./javascript/JavascriptRunner";
import { FuzzEnv } from "../Fuzzer";
import { ArgDef } from "../analysis/ArgDef";
import * as ProgramFactory from "../analysis/ProgramFactory";
import * as Parser from "../adapters/ParserAdapter";
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
        fs.rmSync(tmpDir, { recursive: true, force: true });
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
        fs.rmSync(tmpDir, { recursive: true, force: true });
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
        fs.rmSync(tmpDir, { recursive: true, force: true });
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
        fs.rmSync(tmpDir, { recursive: true, force: true });
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
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
