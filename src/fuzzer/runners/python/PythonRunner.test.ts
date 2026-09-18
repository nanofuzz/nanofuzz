import { PythonRunner } from "./PythonRunner";
import {
  FunctionDef,
  FuzzEnv,
  FuzzGeneratorStatsBase,
  FuzzStopReason,
  FuzzTestResult,
  FuzzTestResults,
} from "../../Fuzzer";
import { PythonCoverageMeasure } from "../../measures/PythonCoverageMeasure";
import { ArgDef } from "../../analysis/ArgDef";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import * as Parser from "../../adapters/ParserAdapter";
import * as Config from "../../../Config";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function getTmpDir(prefix: string): string {
  let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (process.platform === "win32") {
    const colonIdx = tmpDir.indexOf(":");
    if (colonIdx > 0) {
      tmpDir =
        tmpDir.substring(0, colonIdx).toUpperCase() +
        tmpDir.substring(colonIdx);
    }
  }
  return tmpDir;
}

function getRealPath(p: string): string {
  let real = fs.realpathSync(p);
  if (process.platform === "win32") {
    const colonIdx = real.indexOf(":");
    if (colonIdx > 0) {
      real =
        real.substring(0, colonIdx).toUpperCase() + real.substring(colonIdx);
    }
  }
  return real;
}

describe("fuzzer/runners/PythonRunner", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  afterEach(() => {
    Config.override("nanofuzz.fuzzer.coverageScope", "project static");
  });

  it("resolves python interpreter trying python3 first and python as fallback", () => {
    const spy = spyOn(PythonRunner, "canExecute");

    // Case 1: python3 works
    spy.and.callFake((bin: string) => bin === "python3");
    expect(PythonRunner.resolveInterpreter("python3")).toBe("python3");
    expect(PythonRunner.resolveInterpreter("python")).toBe("python3");

    // Case 2: python3 fails, python works
    spy.and.callFake((bin: string) => bin === "python");
    expect(PythonRunner.resolveInterpreter("python3")).toBe("python");
    expect(PythonRunner.resolveInterpreter("python")).toBe("python");

    // Case 3: venv path python3 fails, venv path python works
    spy.and.callFake((bin: string) => bin === "/venv/bin/python");
    expect(PythonRunner.resolveInterpreter("/venv/bin/python3")).toBe(
      "/venv/bin/python"
    );

    // Case 4: neither works, returns candidate
    spy.and.callFake(() => false);
    expect(PythonRunner.resolveInterpreter("python3")).toBe("python3");
  });

  it("handles binary bytes inputs and outputs", async () => {
    const tmpDir = getTmpDir("nanofuzz-runner-");
    const pyPath = path.join(tmpDir, "binary_test.py");
    const pyCode = `
def process_bytes(data: bytes) -> bytes:
    assert isinstance(data, bytes), "data must be bytes"
    return data + b"!"
`;
    fs.writeFileSync(pyPath, pyCode);

    try {
      const srcCode = `
def process_bytes(data: bytes) -> bytes:
    pass
`;
      const program = ProgramFactory.fromSource(
        () => srcCode,
        "python",
        pyPath
      );
      const fnDef = program.functionsExported["process_bytes"];
      const env = createFuzzEnv(fnDef);

      const runner = new PythonRunner(pyPath, "process_bytes", env, 2000);
      await runner.onRunStart();

      const inputBytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
      const res = await runner.run([inputBytes], 2000);

      await runner.onRunEnd();

      expect(res.result.tag).toBe("value");
      if (res.result.tag === "value") {
        expect(res.result.value).toEqual([104, 101, 108, 108, 111, 33]); // "hello!"
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
        // Ignore residual file lock cleanup errors on Windows
      }
    }
  });

  it("nested UUID inputs and outputs", async () => {
    const tmpDir = getTmpDir("nanofuzz-runner-");
    const pyPath = path.join(tmpDir, "uuid_test.py");
    const pyCode = `import uuid

def process_nested(uuids_list, obj_data, tuple_data, plain_str):
    assert all(isinstance(u, uuid.UUID) for u in uuids_list), "uuids_list elements must be uuid.UUID"
    assert isinstance(obj_data['id'], uuid.UUID), "obj_data['id'] must be uuid.UUID"
    assert isinstance(tuple_data[0], uuid.UUID), "tuple_data[0] must be uuid.UUID"
    assert isinstance(plain_str, str), "plain_str must remain str"
    return {
        "status": "ok",
        "returned_uuid": uuid.UUID("12345678-1234-4123-8123-123456789abc"),
        "returned_list": [uuid.UUID("87654321-4321-3214-3218-cba987654321")]
    }
`;
    fs.writeFileSync(pyPath, pyCode);

    try {
      const srcCode = `import uuid
from typing import TypedDict, List, Tuple

class UserObj(TypedDict):
    id: uuid.UUID

def process_nested(uuids_list: list[uuid.UUID], obj_data: UserObj, tuple_data: tuple[uuid.UUID, int], plain_str: str):
    pass
`;
      const program = ProgramFactory.fromSource(
        () => srcCode,
        "python",
        pyPath
      );
      const fnDef = program.functionsExported["process_nested"];
      const env = createFuzzEnv(fnDef);

      const runner = new PythonRunner(pyPath, "process_nested", env, 2000);
      await runner.onRunStart();

      const uuidStr1 = "12345678-1234-4123-8123-123456789abc";
      const uuidStr2 = "87654321-4321-3214-3218-cba987654321";
      const hexNotUuid = "12345678123441238123123456789abc";

      const res = await runner.run(
        [[uuidStr1, uuidStr2], { id: uuidStr1 }, [uuidStr2, 42], hexNotUuid],
        2000
      );

      await runner.onRunEnd();

      expect(res.result.tag).toBe("value");
      if (res.result.tag === "value") {
        expect(res.result.value).toEqual({
          status: "ok",
          returned_uuid: "12345678-1234-4123-8123-123456789abc",
          returned_list: ["87654321-4321-3214-3218-cba987654321"],
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
        // Ignore residual file lock cleanup errors on Windows
      }
    }
  });

  it("set & frozenset inputs and outputs", async () => {
    const tmpDir = getTmpDir("nanofuzz-runner-");
    const pyPath = path.join(tmpDir, "set_test.py");
    const pyCode = `from typing import FrozenSet

def process_sets(s_data: set[int], f_data: FrozenSet[str]):
    assert isinstance(s_data, set), "s_data must be a python set"
    assert isinstance(f_data, frozenset), "f_data must be a python frozenset"
    return {
        "set_res": {x * 2 for x in s_data},
        "frozenset_res": frozenset(x.upper() for x in f_data)
    }
`;
    fs.writeFileSync(pyPath, pyCode);

    try {
      const srcCode = `from typing import FrozenSet

def process_sets(s_data: set[int], f_data: FrozenSet[str]):
    pass
`;
      const program = ProgramFactory.fromSource(
        () => srcCode,
        "python",
        pyPath
      );
      const fnDef = program.functionsExported["process_sets"];
      const env = createFuzzEnv(fnDef);

      const runner = new PythonRunner(pyPath, "process_sets", env, 2000);
      await runner.onRunStart();

      const inputSet = new Set([1, 2, 3]);
      const inputFrozenSet = new Set(["a", "b"]);

      const res = await runner.run([inputSet, inputFrozenSet], 2000);

      await runner.onRunEnd();

      expect(res.result.tag).toBe("value");
      if (res.result.tag === "value") {
        const val = res.result.value;
        if (
          val !== null &&
          typeof val === "object" &&
          "set_res" in val &&
          "frozenset_res" in val &&
          Array.isArray(val.set_res) &&
          Array.isArray(val.frozenset_res)
        ) {
          expect(new Set(val.set_res)).toEqual(new Set([2, 4, 6]));
          expect(new Set(val.frozenset_res)).toEqual(new Set(["A", "B"]));
        } else {
          fail("Expected object with set_res and frozenset_res arrays");
        }
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
        // Ignore residual file lock cleanup errors on Windows
      }
    }
  });

  it("handles tuple arguments, dict with numeric keys, and non-string dict return keys", async () => {
    const tmpDir = getTmpDir("nanofuzz-runner-");
    const pyPath = path.join(tmpDir, "tuple_dict_test.py");
    const pyCode = `
def process_data(t: tuple[int, str], d: dict[int, str]):
    assert isinstance(t, tuple), "t must be a tuple"
    assert all(isinstance(k, int) for k in d.keys()), "d keys must be int"
    return {
        10: "ten",
        20: "twenty"
    }
`;
    fs.writeFileSync(pyPath, pyCode);

    try {
      const srcCode = `
def process_data(t: tuple[int, str], d: dict[int, str]):
    pass
`;
      const program = ProgramFactory.fromSource(
        () => srcCode,
        "python",
        pyPath
      );
      const fnDef = program.functionsExported["process_data"];
      const env = createFuzzEnv(fnDef);

      const runner = new PythonRunner(pyPath, "process_data", env, 2000);
      await runner.onRunStart();

      const res = await runner.run(
        [[10, "foo"], { "1": "one", "2": "two" }],
        2000
      );

      await runner.onRunEnd();

      expect(res.result.tag).toBe("value");
      if (res.result.tag === "value") {
        expect(res.result.value).toEqual({
          "10": "ten",
          "20": "twenty",
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
        // Ignore residual file lock cleanup errors on Windows
      }
    }
  });

  it("handles NaN and Infinity float numbers passed as strings", async () => {
    const tmpDir = getTmpDir("nanofuzz-runner-");
    const pyPath = path.join(tmpDir, "float_test.py");
    const pyCode = `import math

def process_floats(nan_val: float, inf_val: float) -> dict:
    assert isinstance(nan_val, float), "nan_val must be float"
    assert math.isnan(nan_val), "nan_val must be NaN"
    assert isinstance(inf_val, float), "inf_val must be float"
    assert math.isinf(inf_val), "inf_val must be Infinity"
    return {"nan": nan_val, "inf": inf_val}
`;
    fs.writeFileSync(pyPath, pyCode);

    try {
      const srcCode = `
def process_floats(nan_val: float, inf_val: float):
    pass
`;
      const program = ProgramFactory.fromSource(
        () => srcCode,
        "python",
        pyPath
      );
      const fnDef = program.functionsExported["process_floats"];
      const env = createFuzzEnv(fnDef);

      const runner = new PythonRunner(pyPath, "process_floats", env, 2000);
      await runner.onRunStart();

      const res = await runner.run(["NaN", "Infinity"], 2000);

      await runner.onRunEnd();

      expect(res.result.tag).toBe("value");
      if (res.result.tag === "value") {
        const val = res.result.value;
        if (
          val !== null &&
          typeof val === "object" &&
          "nan" in val &&
          "inf" in val
        ) {
          expect(Number.isNaN(val.nan)).toBeTrue();
          expect(val.inf).toBe(Infinity);
        } else {
          fail("Expected object with nan and inf properties");
        }
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
        // Ignore residual file lock cleanup errors on Windows
      }
    }
  });

  it("skips coverage collection when coverage is disabled", async () => {
    const tmpDir = getTmpDir("nanofuzz-runner-");
    const pyPath = path.join(tmpDir, "nocov_test.py");
    const pyCode = `
def add_one(x: int) -> int:
    return x + 1
`;
    fs.writeFileSync(pyPath, pyCode);

    try {
      const program = ProgramFactory.fromSource(() => pyCode, "python", pyPath);
      const fnDef = program.functionsExported["add_one"];
      const env = createFuzzEnv(fnDef);
      env.options.measures.CoverageMeasure.enabled = false;

      const runner = new PythonRunner(pyPath, "add_one", env, 2000);
      await runner.onRunStart();

      const res = await runner.run([5], 2000);
      await runner.onRunEnd();

      expect(res.result.tag).toBe("value");
      expect(runner.coverageInfo).toBeUndefined();
    } finally {
      try {
        fs.rmSync(tmpDir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // Ignore
      }
    }
  });

  it("timeouts with partial coverage", async () => {
    const tmpDir = getTmpDir("nanofuzz-runner-");
    const pyPath = path.join(tmpDir, "timeout_test.py");
    const pyCode = `
def loop_timeout(n: int) -> int:
    a = 1
    if n > 0:
        while True:
            pass
    b = 2
    return a + b
`;
    fs.writeFileSync(pyPath, pyCode);

    try {
      const srcCode = `
def loop_timeout(n: int) -> int:
    pass
`;
      const program = ProgramFactory.fromSource(
        () => srcCode,
        "python",
        pyPath
      );
      const fnDef = program.functionsExported["loop_timeout"];
      const env = createFuzzEnv(fnDef);

      const runner = new PythonRunner(pyPath, "loop_timeout", env, 100);
      await runner.onRunStart();

      // First run times out in-host
      const timeoutRes = await runner.run([5], 100);
      expect(timeoutRes.result.tag).toBe("timeout");
      expect(runner.coverageInfo).toBeDefined();

      // Second run after timeout reuses same host and succeeds
      const fastRes = await runner.run([0], 0);
      expect(fastRes.result.tag).toBe("value");

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
        // Ignore
      }
    }
  });

  it("heartbeat: keep long-running startups alive", async () => {
    const tmpDir = getTmpDir("nanofuzz-runner-");
    const pyPath = path.join(tmpDir, "slow_import_hb.py");
    const pyCode = `import time
time.sleep(1.5)

def slow_fn(x: int) -> int:
    return x * 2
`;
    fs.writeFileSync(pyPath, pyCode);
    const hostStartupTimeout = Config.get(
      "nanofuzz.fuzzer.hostStartupTimeout",
      10000
    );

    try {
      const program = ProgramFactory.fromSource(() => pyCode, "python", pyPath);
      const fnDef = program.functionsExported["slow_fn"];
      const env = createFuzzEnv(fnDef, {
        maxTests: 10,
        maxDupeInputs: 10,
      });

      // Set hostStartupTimeout to 500ms. Without heartbeats (sent every 250ms),
      // a 1.5s import would time out at t=1000ms. Heartbeats reset the 500ms clock,
      // allowing the 1.5s import to succeed cleanly.
      Config.override("nanofuzz.fuzzer.hostStartupTimeout", 1000);

      const runner = new PythonRunner(pyPath, "slow_fn", env, 10000);
      const start = performance.now();
      await runner.onRunStart();
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(1400);

      const res = await runner.run([10], 10000);
      await runner.onRunEnd();

      expect(res.result.tag).toBe("value");
      if (res.result.tag === "value") {
        expect(res.result.value).toBe(20);
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
        // Ignore
      }
    }
  });

  it("coverage scope: 'project' vs 'project directimports'", async () => {
    const normalizePath = (p: string): string => {
      try {
        if (fs.existsSync(p)) {
          const real = fs.realpathSync.native
            ? fs.realpathSync.native(p)
            : fs.realpathSync(p);
          return real.replace(/\\/g, "/").toLowerCase();
        }
      } catch {
        // Fall back if realpathSync throws on Windows file lock
      }
      return path.resolve(p).replace(/\\/g, "/").toLowerCase();
    };

    const isPathInsideDir = (filePath: string, dirPath: string): boolean => {
      const realFile = normalizePath(filePath);
      const realDir = normalizePath(dirPath);
      const folderName = path.basename(dirPath).toLowerCase();
      return (
        realFile.startsWith(realDir) ||
        realFile.includes(realDir) ||
        realFile.includes("/" + folderName + "/")
      );
    };

    const pkgs = ["msgpack", "pytest"];
    for (const pkg of pkgs) {
      const tmpDir = getTmpDir("nanofuzz-covscope-");
      const helperPath = path.join(tmpDir, "local_helper.py");
      const pyPath = path.join(tmpDir, "cov_scope_test.py");

      fs.writeFileSync(
        helperPath,
        `def add_one(x: int) -> int:
    return x + 1
`
      );

      const pyCode = `import ${pkg}
import local_helper

def calculate(x: int) -> int:
    val = local_helper.add_one(x)
    if "${pkg}" == "msgpack":
        _ = msgpack.packb({"a": val})
    elif "${pkg}" == "pytest":
        _ = pytest.__name__
    return val * 2
`;
      fs.writeFileSync(pyPath, pyCode);

      try {
        const program = ProgramFactory.fromSource(
          () => pyCode,
          "python",
          pyPath
        );
        const fnDef = program.functionsExported["calculate"];
        const env = createFuzzEnv(fnDef);

        // Case 1: Default 'project static' scope
        Config.override("nanofuzz.fuzzer.coverageScope", "project static");
        const runnerProject = new PythonRunner(pyPath, "calculate", env, 10000);
        await runnerProject.onRunStart();
        const resProject = await runnerProject.run([1], 10000);
        const covProject = runnerProject.coverageInfo;
        await runnerProject.onRunEnd();

        expect(resProject.result.tag).toBe("value");
        expect(covProject).toBeDefined();
        if (covProject) {
          const fileKeys = Object.keys(covProject).map((p) =>
            p.replace(/\\/g, "/")
          );
          // Positive check: Includes target file and local helper
          expect(
            fileKeys.some((f) => f.includes("cov_scope_test.py"))
          ).toBeTrue();
          expect(
            fileKeys.some((f) => f.includes("local_helper.py"))
          ).toBeTrue();

          // Strict negative check: EVERY file covered MUST be a local project file
          expect(fileKeys.every((f) => isPathInsideDir(f, tmpDir))).toBeTrue();
        }

        // Case 2: 'project directimports static' scope
        Config.override(
          "nanofuzz.fuzzer.coverageScope",
          "project directimports static"
        );
        const runnerImports = new PythonRunner(pyPath, "calculate", env, 10000);
        await runnerImports.onRunStart();
        const resImports = await runnerImports.run([1], 10000);
        const covImports = runnerImports.coverageInfo;
        await runnerImports.onRunEnd();

        expect(resImports.result.tag).toBe("value");
        expect(covImports).toBeDefined();
        if (covImports) {
          const fileKeys = Object.keys(covImports).map((p) =>
            p.replace(/\\/g, "/")
          );
          // Positive check: Includes target file, local helper, and directly imported package
          expect(
            fileKeys.some((f) => f.includes("cov_scope_test.py"))
          ).toBeTrue();
          expect(
            fileKeys.some((f) => f.includes("local_helper.py"))
          ).toBeTrue();
          expect(
            fileKeys.some((f) => f.toLowerCase().includes(pkg.toLowerCase()))
          ).toBeTrue();

          // Strict negative check: EVERY file covered MUST be either a local project file OR a non-system package
          expect(
            fileKeys.every(
              (f) =>
                isPathInsideDir(f, tmpDir) ||
                f.toLowerCase().includes(pkg.toLowerCase())
            )
          ).toBeTrue();
        }
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
          // Ignore
        }
      }
    }
  }, 30000);

  it("fails invalid coverageScope", async () => {
    const tmpDir = getTmpDir("nanofuzz-covscope-invalid-");
    const pyPath = path.join(tmpDir, "dummy.py");
    fs.writeFileSync(pyPath, "def fn(): pass\n");

    try {
      const program = ProgramFactory.fromSource(
        () => "def fn(): pass\n",
        "python",
        pyPath
      );
      const fnDef = program.functionsExported["fn"];
      const env = createFuzzEnv(fnDef);

      // Set bad coverageScope input
      Config.override("nanofuzz.fuzzer.coverageScope", "invalid-scope-value");
      const runner = new PythonRunner(pyPath, "fn", env, 2000);

      await expectAsync(runner.onRunStart()).toBeRejectedWithError(
        /Invalid coverageScope configuration 'invalid-scope-value'/
      );
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
        // Ignore
      }
    }
  }, 30000);

  it("static coverage: retains static coverage structure across test runs, timeouts, and errors", async () => {
    const tmpDir = getTmpDir("nanofuzz-static-py-");
    const pyPath = path.join(tmpDir, "static_test.py");
    const pyCode = `
def process_val(x: int) -> int:
    a = 1
    if x > 0:
        return x + a
    else:
        return -x

def uncalled_func(y: int) -> int:
    return y * 2
`;
    fs.writeFileSync(pyPath, pyCode);

    try {
      const srcCode = `
def process_val(x: int) -> int:
    pass
def uncalled_func(y: int) -> int:
    pass
`;
      const program = ProgramFactory.fromSource(
        () => srcCode,
        "python",
        pyPath
      );
      const fnDef = program.functionsExported["process_val"];
      const env = createFuzzEnv(fnDef);

      const runner = new PythonRunner(pyPath, "process_val", env, 2000);
      await runner.onRunStart();

      // 1. Check runner.coverageInfo immediately after onRunStart before running any test inputs.
      // Expect initial static analysis (executable, functions, branches) for the file.
      expect(runner.coverageInfo).toBeDefined();
      const realPyPath = getRealPath(pyPath);
      const initialCov =
        runner.coverageInfo?.[pyPath] ?? runner.coverageInfo?.[realPyPath];
      console.log(`pyPath: ${pyPath}, realPyPath: ${realPyPath}`); // !!!!!!!!!!
      console.log(`initialCov: ${JSON.stringify(initialCov, null, 2)}`); // !!!!!!!!!!
      console.log(
        `runner.coverageInfo: ${JSON.stringify(runner.coverageInfo, null, 2)}`
      ); // !!!!!!!!!!
      expect(initialCov).toBeDefined();
      expect(initialCov?.executable).toBeDefined();
      expect(initialCov?.executable?.length).toBeGreaterThan(0);
      expect(initialCov?.functions).toBeDefined();
      expect(initialCov?.functions?.length).toBeGreaterThanOrEqual(2);
      expect(initialCov?.branches).toBeDefined();

      // 2. Execute a normal test run.
      // Expect runner.coverageInfo to retain static fields (executable, functions, branches) plus dynamic fields (lines, arcs).
      const valRes = await runner.run([5], 2000);
      expect(valRes.result.tag).toBe("value");
      expect(runner.coverageInfo).toBeDefined();
      const runCov =
        runner.coverageInfo?.[pyPath] ?? runner.coverageInfo?.[realPyPath];
      expect(runCov).toBeDefined();
      expect(runCov?.executable).toBeDefined();
      expect(runCov?.executable?.length).toBeGreaterThan(0);
      expect(runCov?.functions).toBeDefined();
      expect(runCov?.lines).toBeDefined();

      // 3. Execute a test run that times out using a second runner/file.
      // Expect runner.coverageInfo to RETAIN the static structure (executable, functions, branches)
      // rather than being wiped to undefined.
      const pyPath2 = path.join(tmpDir, "timeoutModule.py");
      const pyTimeoutCode = `
def process_val(x: int) -> int:
    while True:
        pass
`;
      fs.writeFileSync(pyPath2, pyTimeoutCode);
      const runner2 = new PythonRunner(pyPath2, "process_val", env, 200);
      await runner2.onRunStart();
      const timeoutRes = await runner2.run([1], 100);
      expect(timeoutRes.result.tag).toBe("timeout");

      // Critical check: static coverage structure must NOT be lost on timeout!
      expect(runner2.coverageInfo).toBeDefined();
      const realPyPath2 = getRealPath(pyPath2);
      const timeoutCov =
        runner2.coverageInfo?.[pyPath2] ?? runner2.coverageInfo?.[realPyPath2];
      expect(timeoutCov).toBeDefined();
      expect(timeoutCov?.executable).toBeDefined();
      expect(timeoutCov?.executable?.length).toBeGreaterThan(0);
      expect(timeoutCov?.functions).toBeDefined();

      await runner.onRunEnd();
      await runner2.onRunEnd();
    } finally {
      try {
        fs.rmSync(tmpDir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // Ignore
      }
    }
  });

  it("static and dynamic coverage for top-level snippet", async () => {
    const tmpDir = getTmpDir("nanofuzz-usersnippet-py-");
    const pyPath = path.join(tmpDir, "user_snippet.py");
    const pyCode = `z = 1
z += 1
q = z
z = q

def x(val: int) -> int:
    return 1
`;
    fs.writeFileSync(pyPath, pyCode);
    const realPyPath = getRealPath(pyPath);

    const program = ProgramFactory.fromSource(
      () => pyCode,
      "python",
      realPyPath
    );
    const fnDef = program.functionsExported["x"];
    const env = createFuzzEnv(fnDef);

    const measure = new PythonCoverageMeasure();

    try {
      const runner = new PythonRunner(realPyPath, "x", env, 2000);
      await runner.onRunStart();

      // Attach PythonCoverageMeasure to runner
      measure.onRunStart([runner]);

      // 1. Initial static coverage on host connect before test execution
      const initialCov = runner.coverageInfo;
      expect(initialCov).toBeDefined();

      // 2. Execute test run calling function x(0)
      const res = await runner.run([0], 2000);
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
          validatorException: false,
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
                value: [0],
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
        counters: { inputsGenerated: 0, dupesGenerated: 0 },
        timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
      };

      const resultsStub: FuzzTestResults = {
        toolVersion: "0.0.0",
        env,
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

      const fileMapNoPath = JSON.parse(JSON.stringify(stats.files[0].fileMap));
      delete fileMapNoPath.path;

      // Single run expectation: all 6 statements are covered (1 hit each)
      expect(fileMapNoPath.s).toEqual({
        "0": 1,
        "1": 1,
        "2": 1,
        "3": 1,
        "4": 1,
        "5": 1,
      });

      // 3. Execute 2 more test runs (total 3 test runs)
      for (let tick = 1; tick <= 2; tick++) {
        measure.onBeforeNextTestExecution();
        const r = await runner.run([0], 2000);
        if (r.result.tag === "value") {
          measure.measure(
            {
              tick,
              value: [{ tag: "ArgValueTypeWrapped", value: [0] }],
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
              validatorException: false,
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

      // Top-level statements MUST stay at 1 (from initial module load, not accumulating),
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
        // Ignore
      }
    }
  });

  it("skips static coverage at init when 'static' is NOT in coverageScope", async () => {
    const tmpDir = getTmpDir("nanofuzz-nostatic-py-");
    const pyPath = path.join(tmpDir, "no_static_test.py");
    const pyCode = `z = 1
z += 1

def x(val: int) -> int:
    return 1
`;
    fs.writeFileSync(pyPath, pyCode);
    const realPyPath = getRealPath(pyPath);

    const program = ProgramFactory.fromSource(
      () => pyCode,
      "python",
      realPyPath
    );
    const fnDef = program.functionsExported["x"];
    const env = createFuzzEnv(fnDef);

    Config.override("nanofuzz.fuzzer.coverageScope", "project");

    try {
      const runner = new PythonRunner(realPyPath, "x", env, 2000);
      await runner.onRunStart();

      // 1. Initial coverage at startup is empty when static is not in coverageScope
      expect(runner.coverageInfo).toEqual({});

      // 2. Dynamic coverage is still collected during test execution
      const res = await runner.run([0], 2000);
      expect(res.result.tag).toBe("value");
      expect(
        runner.coverageInfo?.[realPyPath]?.lines ??
          runner.coverageInfo?.[pyPath]?.lines
      ).toEqual([5]);

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
        // Ignore
      }
    }
  });
});

/**
 * Generates a default FuzzEnv for testing.
 * Placed at the bottom of the module.
 */
function createFuzzEnv(
  fnDef: FunctionDef,
  optionsOverrides?: Partial<FuzzEnv["options"]>
): FuzzEnv {
  return {
    function: fnDef,
    options: {
      argDefaults: ArgDef.getDefaultOptions(),
      maxTests: 1000,
      maxDupeInputs: 1000,
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
      ...optionsOverrides,
    },
    validators: [],
    transformers: [],
  };
} // fn: createFuzzEnv
