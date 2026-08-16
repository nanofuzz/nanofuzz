import { PythonRunner } from "./PythonRunner";

describe("fuzzer/runners/PythonRunner", () => {
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
});
