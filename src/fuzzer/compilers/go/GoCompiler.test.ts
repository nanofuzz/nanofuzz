import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GoCompiler, parseGoCompilerErrors } from "./GoCompiler";
import * as CompilerFactory from "../CompilerFactory";
import { GoCompilerError } from "../Types";

describe("fuzzer/compilers/go/GoCompiler: ", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-go-test-")
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

  it("resolves go toolchain executable", () => {
    const go = GoCompiler.resolveGo();
    expect(go).toBeDefined();
    expect(typeof go).toBe("string");
    expect(GoCompiler.canExecute(go!)).toBeTrue();

    const version = GoCompiler.getGoVersion(go);
    expect(version).toBeDefined();
    expect(typeof version).toBe("string");

    expect(GoCompiler.canExecute("non_existent_binary_xyz_12345")).toBeFalse();
  });

  it("detects go.mod in ancestor directory and gathers dependencies", () => {
    const goMod = path.join(tempDir, "go.mod");
    fs.writeFileSync(goMod, "module example.com/test\n\ngo 1.22\n");
    const pkgDir = path.join(tempDir, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    const file1 = path.join(pkgDir, "a.go");
    const file2 = path.join(pkgDir, "b.go");
    fs.writeFileSync(file1, "package pkg\nfunc A() {}\n");
    fs.writeFileSync(file2, "package pkg\nfunc B() {}\n");

    const compiler = new GoCompiler(file1);
    expect(compiler.goModPath).toBe(goMod);
    expect(compiler.projectPath).toBe(tempDir);

    const deps = compiler.getCompiledDependencies();
    expect(deps).toContain(file1);
    expect(deps).toContain(file2);
    expect(deps).toContain(goMod);
  });

  it("parses compiler errors into structured GoCompilerError diagnostics", () => {
    const rawError = `
pkg/a.go:12:5: undefined: missingFunction
pkg/a.go:15:10: cannot use "foo" (type string) as type int in assignment
`;
    const err = parseGoCompilerErrors(rawError, "pkg/a.go", "go vet");
    expect(err instanceof GoCompilerError).toBeTrue();
    expect(err.details.diagnostics?.length).toBe(2);
    expect(err.details.diagnostics?.[0].span?.line).toBe(12);
    expect(err.details.diagnostics?.[0].span?.col).toBe(5);
    expect(err.details.diagnostics?.[0].message).toBe("undefined: missingFunction");
    expect(err.details.diagnostics?.[1].span?.line).toBe(15);
  });

  it("integrates with CompilerFactory", () => {
    const goFile = path.join(tempDir, "main.go");
    fs.writeFileSync(goFile, "package main\nfunc main() {}\n");

    expect(CompilerFactory.needsCompilation(goFile)).toBeTrue();
    const comp = CompilerFactory.fromSourcefile(goFile);
    expect(comp instanceof GoCompiler).toBeTrue();
  });
});
