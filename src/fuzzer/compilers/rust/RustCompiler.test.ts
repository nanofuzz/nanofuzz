import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RustCompiler } from "./RustCompiler";
import * as CompilerFactory from "../CompilerFactory";
import { RustCompilerError } from "../Types";

describe("fuzzer/compilers/rust/RustCompiler: ", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-rust-test-")
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

  it("resolves cargo and rustc toolchain executables", () => {
    const cargo = RustCompiler.resolveCargo();
    expect(cargo).toBeDefined();
    expect(typeof cargo).toBe("string");
    expect(RustCompiler.canExecute(cargo!)).toBeTrue();

    const rustc = RustCompiler.resolveRustc(cargo);
    expect(rustc).toBeDefined();
    expect(typeof rustc).toBe("string");
    expect(RustCompiler.canExecute(rustc!)).toBeTrue();

    expect(
      RustCompiler.canExecute("non_existent_binary_xyz_12345")
    ).toBeFalse();
  });

  it("detects Cargo.toml in parent directories for cargo projects", () => {
    const runtimeLib = path.resolve("./packages/runtime/rust/src/lib.rs");
    const compiler = new RustCompiler(runtimeLib);

    expect(compiler.cargoTomlPath).toBeDefined();
    expect(compiler.cargoTomlPath?.endsWith("Cargo.toml")).toBeTrue();
    expect(compiler.projectPath).toBe(path.resolve("./packages/runtime/rust"));

    const deps = compiler.getCompiledDependencies();
    expect(deps).toContain(runtimeLib);
  });

  it("handles standalone Rust files without Cargo.toml", () => {
    const standaloneRs = path.join(tempDir, "standalone.rs");
    fs.writeFileSync(standaloneRs, "pub fn answer() -> i32 { 42 }");

    const compiler = new RustCompiler(standaloneRs);
    expect(compiler.cargoTomlPath).toBeUndefined();
    expect(compiler.projectPath).toBe(tempDir);
  });

  it("compiles a valid Cargo project and records compilation metadata", () => {
    const runtimeLib = path.resolve("./packages/runtime/rust/src/lib.rs");
    const compiler = new RustCompiler(runtimeLib);

    const compiledFile = compiler.compileSync();
    expect(compiledFile).toBe(runtimeLib);

    // After compilation, it should not be stale
    const staleCheck = compiler.isStale();
    expect(staleCheck).toBeFalse();
  });

  it("compiles a Cargo project importing nanofuzz_runtime without manifest dependency", () => {
    const projDir = path.join(tempDir, "cargo_proj_nanofuzz_runtime");
    const srcDir = path.join(projDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(projDir, "Cargo.toml"),
      `[package]
name = "test_nanofuzz_runtime_import"
version = "0.1.0"
edition = "2021"

[lib]
path = "src/lib.rs"
`
    );

    const libRs = path.join(srcDir, "lib.rs");
    fs.writeFileSync(
      libRs,
      `use nanofuzz_runtime::assume;
use nanofuzz_runtime::FuzzTestResult;

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
`
    );

    const compiler = new RustCompiler(libRs);
    const compiledFile = compiler.compileSync();
    expect(compiledFile).toBe(libRs);
    expect(compiler.isStale()).toBeFalse();
  });

  it("detects source file changes and reports staleness", () => {
    const standaloneRs = path.join(tempDir, "sample.rs");
    fs.writeFileSync(
      standaloneRs,
      "pub fn add(a: i32, b: i32) -> i32 { a + b }"
    );

    const compiler = new RustCompiler(standaloneRs);
    expect(compiler.isStale()).toBe("notcompiled");

    compiler.compileSync();
    expect(compiler.isStale()).toBeFalse();

    // Touch the source file with a future timestamp
    const futureTime = new Date(Date.now() + 5000);
    fs.utimesSync(standaloneRs, futureTime, futureTime);

    expect(compiler.isStale()).toBe("sourcechanged");
  });

  it("detects compiler change and reports compilerchanged staleness", () => {
    const standaloneRs = path.join(tempDir, "compiler_test.rs");
    fs.writeFileSync(
      standaloneRs,
      "pub fn add(a: i32, b: i32) -> i32 { a + b }"
    );

    const compiler = new RustCompiler(standaloneRs);
    compiler.compileSync();
    expect(compiler.isStale()).toBeFalse();

    // Simulate compiler change
    compiler.setRustcVersionForTest("rustc 9.99.9-fake");
    expect(compiler.isStale()).toBe("compilerchanged");
  });

  it("throws RustCompilerError with diagnostic details on compilation failure", () => {
    const badRs = path.join(tempDir, "bad.rs");
    fs.writeFileSync(
      badRs,
      `pub fn broken() -> i32 {
    let x: i32 = "not a number";
    x
}`
    );

    const compiler = new RustCompiler(badRs);
    let thrownError: unknown;

    try {
      compiler.compileSync();
    } catch (e) {
      thrownError = e;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError instanceof RustCompilerError).toBeTrue();

    if (thrownError instanceof RustCompilerError) {
      expect(thrownError.details.inputFile).toBe(badRs);
      expect(thrownError.details.output).toBeDefined();
      expect(thrownError.details.output?.length).toBeGreaterThan(0);
      expect(thrownError.details.diagnostics).toBeDefined();
      expect(thrownError.details.diagnostics?.length).toBeGreaterThan(0);

      const firstDiag = thrownError.details.diagnostics![0];
      expect(firstDiag.level).toBe("error");
      expect(firstDiag.span).toBeDefined();
      expect(firstDiag.span?.lineStart).toBe(2);
    }
  });

  it("integrates with CompilerFactory", () => {
    expect(CompilerFactory.needsCompilation("test.rs")).toBeTrue();
    expect(CompilerFactory.needsCompilation("test.py")).toBeFalse();
    expect(CompilerFactory.needsCompilation("test.ts")).toBeTrue();

    const runtimeLib = path.resolve("./packages/runtime/rust/src/lib.rs");
    const compiler = CompilerFactory.fromSourcefile(runtimeLib);
    expect(compiler).toBeDefined();
    expect(compiler instanceof RustCompiler).toBeTrue();
  });

  it("cleans temporary compiler directories", () => {
    const testTmpDir = path.join(tempDir, "nanofuzz-clean-test");
    fs.mkdirSync(testTmpDir, { recursive: true });
    expect(fs.existsSync(testTmpDir)).toBeTrue();

    RustCompiler.clean(testTmpDir);
    expect(fs.existsSync(testTmpDir)).toBeFalse();
  });
});
