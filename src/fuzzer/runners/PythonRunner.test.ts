import { PythonRunner } from "./PythonRunner";
import { FuzzEnv } from "../Fuzzer";
import { ArgDef } from "../analysis/ArgDef";
import * as ProgramFactory from "../analysis/ProgramFactory";
import * as Parser from "../adapters/ParserAdapter";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("fuzzer/runners/PythonRunner", () => {
  beforeAll(async () => {
    await Parser.init();
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-runner-"));
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
      const env: FuzzEnv = {
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
        },
        validators: [],
        transformers: [],
      };

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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-runner-"));
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
      const env: FuzzEnv = {
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
        },
        validators: [],
        transformers: [],
      };

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
});
