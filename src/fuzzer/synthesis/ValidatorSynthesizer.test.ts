import * as path from "node:path";
import * as ParserAdapter from "../adapters/ParserAdapter";
import * as ProgramFactory from "../analysis/ProgramFactory";
import { synthesizeValidator } from "./ValidatorSynthesizer";

describe("src/fuzzer/synthesis/ValidatorSynthesizer", () => {
  const tsFixture = path.resolve(
    __dirname,
    "../test_fixtures/Fuzzer.testfixtures.ts"
  );
  const pyFixture = path.resolve(
    __dirname,
    "../test_fixtures/Fuzzer.testfixtures.py"
  );

  beforeAll(async () => {
    await ParserAdapter.init();
  });

  it("synthesizes TypeScript validator with correct signature and argument unpacking", () => {
    const program = ProgramFactory.fromFile(tsFixture);
    const fnDef = program.functions["testStandardVoidReturnUndefined"];
    expect(fnDef).toBeDefined();

    const result = synthesizeValidator(fnDef, "typescript");
    expect(result.name).toBe("testStandardVoidReturnUndefinedValidator");
    expect(result.imports.length).toBe(1);
    expect(result.imports[0].name).toBe("FuzzTestResult");
    expect(result.skeleton).toContain(
      'export function testStandardVoidReturnUndefinedValidator(r: FuzzTestResult): "pass" | "fail" | "unknown"'
    );
    expect(result.skeleton).toContain("const _x: number = r.in[0];");
    expect(result.skeleton).toContain("const out = r.out;");
    expect(result.fullTemplate).toContain(
      'import { FuzzTestResult } from "@nanofuzz/runtime";'
    );
  });

  it("synthesizes Python validator with correct signature and dictionary unpacking", () => {
    const program = ProgramFactory.fromFile(pyFixture);
    const fnDef = program.functions["greeting"];
    expect(fnDef).toBeDefined();

    const result = synthesizeValidator(fnDef, "python");
    expect(result.name).toBe("greetingValidator");
    expect(result.imports.length).toBe(2);
    expect(result.skeleton).toContain(
      'def greetingValidator(r: FuzzTestResult) -> Literal["pass", "fail", "unknown"]:'
    );
    expect(result.skeleton).toContain("name: a = r['in'][0]");
    expect(result.skeleton).toContain("out: a = r['out']");
    expect(result.fullTemplate).toContain(
      "from nanofuzz_runtime import FuzzTestResult"
    );
    expect(result.fullTemplate).toContain("from typing import Literal");
  });

  it("disambiguates validator name when existing names conflict", () => {
    const program = ProgramFactory.fromFile(tsFixture);
    const fnDef = program.functions["testStandardVoidReturnUndefined"];

    const result = synthesizeValidator(fnDef, "typescript", [
      "testStandardVoidReturnUndefinedValidator",
      "testStandardVoidReturnUndefinedValidator1",
    ]);
    expect(result.name).toBe("testStandardVoidReturnUndefinedValidator2");
    expect(result.skeleton).toContain(
      "testStandardVoidReturnUndefinedValidator2"
    );
  });
});
