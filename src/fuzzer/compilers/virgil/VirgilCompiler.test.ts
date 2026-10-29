import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as Config from "../../../Config";
import * as CompilerFactory from "../CompilerFactory";
import {
  VirgilCompiler,
  parseVirgilCompilerOutput,
} from "./VirgilCompiler";
import { VirgilCompilerError } from "../Types";

describe("fuzzer/compilers/virgil/VirgilCompiler: ", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-v3comp-test-")
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
    Config.clearOverrides();
  });

  it("registers in CompilerFactory and recognizes .v3 source files", () => {
    const v3File = path.join(tempDir, "test.v3");
    fs.writeFileSync(v3File, "def main() {}\n");

    expect(CompilerFactory.needsCompilation(v3File)).toBeTrue();
    const compiler = CompilerFactory.fromSourcefile(v3File);
    expect(compiler).toBeDefined();
    expect(compiler instanceof VirgilCompiler).toBeTrue();
  });

  it("parses Virgil compiler diagnostics with file, line, column, and message", () => {
    const rawStderr = `
src/math.v3:14:8: type error: cannot assign int to string
src/math.v3:22:1: syntax error: unexpected token ';'
src/util.v3:5:10: warning: unused variable 'unused'
`;
    const details = parseVirgilCompilerOutput(
      "",
      rawStderr,
      "src/math.v3",
      "v3c src/math.v3"
    );

    expect(details.inputFile).toBe("src/math.v3");
    expect(details.v3cCli).toBe("v3c src/math.v3");
    expect(details.diagnostics).toBeDefined();
    expect(details.diagnostics?.length).toBe(3);

    const diag1 = details.diagnostics![0];
    expect(diag1.span?.file).toBe("src/math.v3");
    expect(diag1.span?.line).toBe(14);
    expect(diag1.span?.col).toBe(8);
    expect(diag1.message).toBe("type error: cannot assign int to string");
    expect(diag1.level).toBe("error");

    const diag3 = details.diagnostics![2];
    expect(diag3.level).toBe("warning");
  });

  it("resolves v3c compiler path via configuration override", () => {
    const fakeV3c = path.join(tempDir, "fake-v3c");
    fs.writeFileSync(fakeV3c, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeV3c, 0o755);

    Config.override("nanofuzz.virgil.v3cPath", fakeV3c);
    const resolved = VirgilCompiler.resolveV3c();
    expect(resolved).toBe(fakeV3c);
  });

  it("detects source file staleness", () => {
    const v3File = path.join(tempDir, "app.v3");
    fs.writeFileSync(v3File, "def run() {}\n");

    const compiler = new VirgilCompiler(v3File);
    expect(compiler.isStale()).toBe("notcompiled");
  });

  it("cleans temporary compilation artifacts cleanly", () => {
    const customTmp = path.join(tempDir, "artifacts");
    fs.mkdirSync(customTmp, { recursive: true });
    expect(fs.existsSync(customTmp)).toBeTrue();

    VirgilCompiler.clean(customTmp);
    expect(fs.existsSync(customTmp)).toBeFalse();
  });

  it("throws VirgilCompilerError when compiler executable is missing", () => {
    const v3File = path.join(tempDir, "test.v3");
    fs.writeFileSync(v3File, "def foo() {}\n");

    Config.override("nanofuzz.virgil.v3cPath", "/nonexistent/path/to/v3c");
    const compiler = new VirgilCompiler(v3File);

    expect(() => compiler.compileSync()).toThrowError(VirgilCompilerError);
  });
});
