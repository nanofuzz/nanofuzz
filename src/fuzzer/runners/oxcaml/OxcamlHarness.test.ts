import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as Parser from "../../adapters/ParserAdapter";
import { instrumentOxcamlSource, buildOxcamlHarness } from "./OxcamlHarness";
import { OxcamlCompiler } from "../../compilers/oxcaml/OxcamlCompiler";

describe("fuzzer/runners/oxcaml/OxcamlHarness: ", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-oxcaml-harness-")
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

  it("instruments OCaml functions and statements", () => {
    const src = `
let add (a : int) (b : int) : int =
  a + b

let mul (x : int) (y : int) : int =
  x * y
`;
    const { instrumentedSrc, staticCov } = instrumentOxcamlSource(
      src,
      "test.ml",
      0
    );

    expect(instrumentedSrc).toContain("Nanofuzz_runtime.Coverage.hit_fn 0 0");
    expect(instrumentedSrc).toContain("Nanofuzz_runtime.Coverage.hit_stmt 0 0");
    expect(instrumentedSrc).toContain("Nanofuzz_runtime.Coverage.hit_fn 0 1");
    expect(instrumentedSrc).toContain("Nanofuzz_runtime.Coverage.hit_stmt 0 1");

    expect(Object.keys(staticCov.fnMap).length).toBe(2);
    expect(staticCov.fnMap["0"].name).toBe("add");
    expect(staticCov.fnMap["1"].name).toBe("mul");
    expect(Object.keys(staticCov.statementMap).length).toBe(2);
  });

  it("instruments OCaml if-then-else branches", () => {
    const src = `
let max_val (a : int) (b : int) : int =
  if a > b then
    a
  else
    b
`;
    const { instrumentedSrc, staticCov, branchArms } = instrumentOxcamlSource(
      src,
      "max.ml",
      0
    );

    expect(instrumentedSrc).toContain(
      "Nanofuzz_runtime.Coverage.hit_branch 0 0 0"
    );
    expect(instrumentedSrc).toContain(
      "Nanofuzz_runtime.Coverage.hit_branch 0 0 1"
    );

    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(branchArms.length).toBe(1);
    expect(branchArms[0]).toEqual([0, 2]);
  });

  it("instruments match and function expression pattern arms", () => {
    const src = `
let classify n =
  match n with
  | 0 -> "zero"
  | 1 -> "one"
  | _ -> "other"
`;
    const { instrumentedSrc, staticCov, branchArms } = instrumentOxcamlSource(
      src,
      "classify.ml",
      0
    );

    expect(instrumentedSrc).toContain(
      "Nanofuzz_runtime.Coverage.hit_branch 0 0 0"
    );
    expect(instrumentedSrc).toContain(
      "Nanofuzz_runtime.Coverage.hit_branch 0 0 1"
    );
    expect(instrumentedSrc).toContain(
      "Nanofuzz_runtime.Coverage.hit_branch 0 0 2"
    );

    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(branchArms.length).toBe(1);
    expect(branchArms[0]).toEqual([0, 3]);
  });

  it("instruments source with a specified fileId for multi-file coverage", () => {
    const src = `
let helper x =
  if x > 0 then x + 1 else x - 1
`;
    const { instrumentedSrc } = instrumentOxcamlSource(src, "helper.ml", 42);

    expect(instrumentedSrc).toContain("Nanofuzz_runtime.Coverage.hit_fn 42 0");
    expect(instrumentedSrc).toContain(
      "Nanofuzz_runtime.Coverage.hit_stmt 42 0"
    );
    expect(instrumentedSrc).toContain(
      "Nanofuzz_runtime.Coverage.hit_branch 42 0 0"
    );
    expect(instrumentedSrc).toContain(
      "Nanofuzz_runtime.Coverage.hit_branch 42 0 1"
    );
  });

  it("builds a functional harness executable and reuses cache", () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune executable not found in environment");
      return;
    }

    const targetFile = path.join(tempDir, "calc.ml");
    fs.writeFileSync(
      targetFile,
      `
let add (a : int) (b : int) : int =
  a + b
`
    );

    const harnessResult = buildOxcamlHarness(
      targetFile,
      "add",
      undefined,
      tempDir
    );

    expect(fs.existsSync(harnessResult.binaryPath)).toBeTrue();
    expect(harnessResult.harnessDir).toBeDefined();
    expect(harnessResult.staticCov).toBeDefined();
    expect(harnessResult.staticCovMap).toBeDefined();

    // Verify cache reuse on second call
    const cachedResult = buildOxcamlHarness(
      targetFile,
      "add",
      undefined,
      tempDir
    );
    expect(cachedResult.binaryPath).toBe(harnessResult.binaryPath);
  });
});
