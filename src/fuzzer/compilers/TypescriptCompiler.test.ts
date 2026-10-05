import path from "node:path";
import fs from "node:fs";
import { TypescriptCompiler } from "./TypescriptCompiler";
import { Instrumenter } from "./Instrumenter";
import { MeasureFactory } from "../measures/MeasureFactory";
import { initParser } from "../FuzzerTestHelper";

describe("CompilerWorker", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("compileAsync: background compile & instrumentation", async () => {
    const fqModulePath = path.resolve(
      "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts"
    );
    const measures = MeasureFactory("typescript");
    const measureHash = Instrumenter.getMeasureHash(measures);

    // Call compileAsync
    await TypescriptCompiler.compileAsync(fqModulePath);

    const compiler = new TypescriptCompiler(fqModulePath);
    const cleanJsPath = compiler.getJsFilename(fqModulePath);

    // Clean compiled JS file should exist
    expect(fs.existsSync(cleanJsPath)).toBeTrue();

    // Instrumented file path should exist
    const instPath = Instrumenter.getInstrumentedPath(
      cleanJsPath,
      compiler.options.tmpDir,
      measureHash
    );
    expect(fs.existsSync(instPath)).toBeTrue();

    // Instrumented content should contain coverage instrumentation
    const instContent = fs.readFileSync(instPath, "utf8");
    expect(
      instContent.includes("__coverage__") || instContent.includes("cov_")
    ).toBeTrue();
  });
});
