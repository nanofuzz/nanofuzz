import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OxcamlCompiler } from "./OxcamlCompiler";
import * as CompilerFactory from "../CompilerFactory";
import { OxcamlCompilerError } from "../Types";

describe("fuzzer/compilers/oxcaml/OxcamlCompiler: ", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-oxcaml-test-")
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

  it("resolves dune and ocamlopt toolchain executables", () => {
    const dune = OxcamlCompiler.resolveDune();
    expect(dune).toBeDefined();
    expect(typeof dune).toBe("string");
    expect(OxcamlCompiler.canExecute(dune!)).toBeTrue();

    const ocamlopt = OxcamlCompiler.resolveOcamlopt();
    expect(ocamlopt).toBeDefined();
    expect(typeof ocamlopt).toBe("string");
    expect(OxcamlCompiler.canExecute(ocamlopt!)).toBeTrue();

    expect(
      OxcamlCompiler.canExecute("non_existent_binary_xyz_12345")
    ).toBeFalse();
  });

  it("detects dune-project in parent directories for Dune projects", () => {
    const runtimeLib = path.resolve(
      "./packages/runtime/oxcaml/src/nanofuzz_runtime.ml"
    );
    const compiler = new OxcamlCompiler(runtimeLib);

    expect(compiler.duneProjectPath).toBeDefined();
    expect(compiler.duneProjectPath?.endsWith("dune-project")).toBeTrue();
    expect(compiler.projectPath).toBe(
      path.resolve("./packages/runtime/oxcaml")
    );

    const deps = compiler.getCompiledDependencies();
    expect(deps).toContain(runtimeLib);
  });

  it("handles standalone OCaml files without dune-project", () => {
    const standaloneMl = path.join(tempDir, "standalone.ml");
    fs.writeFileSync(standaloneMl, "let answer () : int = 42");

    const compiler = new OxcamlCompiler(standaloneMl);
    expect(compiler.duneProjectPath).toBeUndefined();
    expect(compiler.projectPath).toBe(tempDir);
  });

  it("compiles a valid Dune project and records compilation metadata", () => {
    const runtimeLib = path.resolve(
      "./packages/runtime/oxcaml/src/nanofuzz_runtime.ml"
    );
    const compiler = new OxcamlCompiler(runtimeLib);

    const compiledFile = compiler.compileSync();
    expect(compiledFile).toBe(runtimeLib);

    // After compilation, it should not be stale
    const staleCheck = compiler.isStale();
    expect(staleCheck).toBeFalse();
  });

  it("detects source file changes and reports staleness", () => {
    const standaloneMl = path.join(tempDir, "sample.ml");
    fs.writeFileSync(standaloneMl, "let add (a : int) (b : int) : int = a + b");

    const compiler = new OxcamlCompiler(standaloneMl);
    expect(compiler.isStale()).toBe("notcompiled");

    compiler.compileSync();
    expect(compiler.isStale()).toBeFalse();

    // Sleep briefly to ensure stat mtime differs
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);

    fs.writeFileSync(
      standaloneMl,
      "let add (a : int) (b : int) : int = a + b + 1"
    );
    expect(compiler.isStale()).toBe("sourcechanged");
  });

  it("throws an OxcamlCompilerError on invalid syntax", () => {
    const brokenMl = path.join(tempDir, "broken.ml");
    fs.writeFileSync(brokenMl, "let x = ;;;; syntax error +++ ???");

    const compiler = new OxcamlCompiler(brokenMl);
    expect(() => {
      compiler.compileSync();
    }).toThrowError(OxcamlCompilerError);
  });

  it("integrates with CompilerFactory", () => {
    expect(CompilerFactory.needsCompilation("foo.ml")).toBeTrue();
    expect(CompilerFactory.needsCompilation("foo.mli")).toBeTrue();

    const runtimeLib = path.resolve(
      "./packages/runtime/oxcaml/src/nanofuzz_runtime.ml"
    );
    const compiler = CompilerFactory.fromSourcefile(runtimeLib);
    expect(compiler).toBeDefined();
    expect(compiler instanceof OxcamlCompiler).toBeTrue();
  });
});
