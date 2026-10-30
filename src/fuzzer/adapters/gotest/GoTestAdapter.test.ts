import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as ChildProcess from "node:child_process";
import { GoTestAdapter } from "./GoTestAdapter";
import * as TestAdapterFactory from "../TestAdapterFactory";
import { FuzzTests } from "../../Types";
import * as Parser from "../ParserAdapter";
import { GoCompiler } from "../../compilers/go/GoCompiler";
import { intOptions } from "../../FuzzerTestHelper";

describe("fuzzer/adapters/gotest/GoTestAdapter: ", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-gotest-")
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

  it("produces standard Go test suite with expected structure and asserts", () => {
    const goSrc = `package mathutil

func Add(a, b int) int {
    return a + b
}
`;
    const goPath = path.join(tempDir, "math.go");
    fs.writeFileSync(goPath, goSrc);

    const testSet: FuzzTests = {
      version: "0.1.0",
      functions: {
        Add: {
          options: intOptions,
          validators: [],
          isVoid: false,
          tests: {
            test1: {
              input: [
                { name: "a", offset: 0, value: 2, origin: { type: "user" } },
                { name: "b", offset: 1, value: 3, origin: { type: "user" } },
              ],
              output: [
                {
                  name: "out",
                  offset: 0,
                  value: 5,
                  isException: false,
                  origin: { type: "user" },
                },
              ],
              pinned: true,
            },
            testPanic: {
              input: [
                { name: "a", offset: 0, value: -1, origin: { type: "user" } },
                { name: "b", offset: 1, value: 0, origin: { type: "user" } },
              ],
              output: [
                {
                  name: "out",
                  offset: 0,
                  value: 0,
                  isException: true,
                  origin: { type: "user" },
                },
              ],
              pinned: true,
            },
          },
        },
      },
    };

    const adapter = new GoTestAdapter(testSet, goPath);
    expect(adapter.toolname).toBe("GoTest");
    expect(adapter.filename.endsWith("math_nanofuzz_test.go")).toBeTrue();

    const output = adapter.toString();
    expect(output).toContain("package mathutil");
    expect(output).toContain('"testing"');
    expect(output).toContain('"reflect"');
    expect(output).toContain("func TestAdd_NaNofuzz(t *testing.T) {");
    expect(output).toContain("got := Add(2, 3)");
    expect(output).toContain("want := 5");
    expect(output).toContain("reflect.DeepEqual(got, want)");
    expect(output).toContain("defer func() {");
    expect(output).toContain("if r := recover(); r == nil {");
  });

  it("integrates with TestAdapterFactory and respects custom outputFilename", () => {
    const goPath = path.join(tempDir, "app.go");
    fs.writeFileSync(goPath, "package main\nfunc Run() {}\n");
    const testSet: FuzzTests = { version: "0.1.0", functions: {} };

    const customOut = path.join(tempDir, "custom_test.go");
    const adapter = TestAdapterFactory.fromSourceFilename(
      goPath,
      testSet,
      customOut
    );
    expect(adapter instanceof GoTestAdapter).toBeTrue();
    expect(adapter.filename).toBe(customOut);
  });

  it("generates runnable tests for compound types (structs, slices, maps, pointers)", () => {
    const goSrc = `package datatypes

type Profile struct {
    Username string
}

func GetInfo(p Profile, tags []string, counts map[string]int, ptr *int) int {
    val := 0
    if ptr != nil {
        val = *ptr
    }
    return len(p.Username) + len(tags) + counts["a"] + val
}
`;
    const goMod = "module datatypes\n\ngo 1.22\n";
    fs.writeFileSync(path.join(tempDir, "go.mod"), goMod);
    const goPath = path.join(tempDir, "data.go");
    fs.writeFileSync(goPath, goSrc);

    const testSet: FuzzTests = {
      version: "0.1.0",
      functions: {
        GetInfo: {
          options: intOptions,
          validators: [],
          isVoid: false,
          tests: {
            case1: {
              input: [
                {
                  name: "p",
                  offset: 0,
                  value: { Username: "alice" },
                  origin: { type: "user" },
                },
                {
                  name: "tags",
                  offset: 1,
                  value: ["go", "test"],
                  origin: { type: "user" },
                },
                {
                  name: "counts",
                  offset: 2,
                  value: { a: 10 },
                  origin: { type: "user" },
                },
                {
                  name: "ptr",
                  offset: 3,
                  value: 5,
                  origin: { type: "user" },
                },
              ],
              output: [
                // len("alice") [5] + 2 + 10 + 5 = 22
                {
                  name: "out",
                  offset: 0,
                  value: 22,
                  isException: false,
                  origin: { type: "user" },
                },
              ],
              pinned: true,
            },
          },
        },
      },
    };

    const adapter = new GoTestAdapter(testSet, goPath);
    const testCode = adapter.toString();
    expect(testCode).toContain("package datatypes");
    expect(testCode).toContain('Profile{Username: "alice"}');
    expect(testCode).toContain('[]string{"go", "test"}');
    expect(testCode).toContain('map[string]int{"a": 10}');
    expect(testCode).toContain("want := 22");

    fs.writeFileSync(adapter.filename, testCode);
    const goBin = GoCompiler.resolveGo();
    expect(goBin).toBeDefined();
    const res = ChildProcess.spawnSync(goBin!, ["test", "./..."], {
      cwd: tempDir,
      encoding: "utf-8",
    });
    expect(res.status).toBe(0);
  });

  it("generates a runnable Go test file that passes go test", () => {
    const goSrc = `package mathutil

func Add(a, b int) int {
    return a + b
}
`;
    const goMod = "module mathutil\n\ngo 1.22\n";
    fs.writeFileSync(path.join(tempDir, "go.mod"), goMod);
    const goPath = path.join(tempDir, "math.go");
    fs.writeFileSync(goPath, goSrc);

    const testSet: FuzzTests = {
      version: "0.1.0",
      functions: {
        Add: {
          options: intOptions,
          validators: [],
          isVoid: false,
          tests: {
            test1: {
              input: [
                { name: "a", offset: 0, value: 10, origin: { type: "user" } },
                { name: "b", offset: 1, value: 20, origin: { type: "user" } },
              ],
              output: [
                {
                  name: "out",
                  offset: 0,
                  value: 30,
                  isException: false,
                  origin: { type: "user" },
                },
              ],
              pinned: true,
            },
          },
        },
      },
    };

    const adapter = new GoTestAdapter(testSet, goPath);
    const testCode = adapter.toString();
    fs.writeFileSync(adapter.filename, testCode);

    const goBin = GoCompiler.resolveGo();
    expect(goBin).toBeDefined();
    const res = ChildProcess.spawnSync(goBin!, ["test", "./..."], {
      cwd: tempDir,
      encoding: "utf-8",
    });
    expect(res.status).toBe(0);
  });
});
