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
    expect(result.name).toBe("greeting_validator");
    expect(result.imports.length).toBe(2);
    expect(result.skeleton).toContain(
      'def greeting_validator(r: FuzzTestResult) -> Literal["pass", "fail", "unknown"]:'
    );
    expect(result.skeleton).toContain("name: a = r['in'][0]");
    expect(result.skeleton).toContain("out: a = r['out']");
    expect(result.fullTemplate).toContain(
      "from nanofuzz_runtime import FuzzTestResult"
    );
    expect(result.fullTemplate).toContain("from typing import Literal");
  });

  it("synthesizes Rust validator with correct signature and FuzzTestResult unpacking", () => {
    const src = `pub fn add(a: i32, b: f64) -> i32 { a + (b as i32) }`;
    const program = ProgramFactory.fromSource(() => src, "rust");
    const fnDef = program.functionsExported["add"];
    expect(fnDef).toBeDefined();

    const result = synthesizeValidator(fnDef, "rust");
    expect(result.name).toBe("add_validator");
    expect(result.imports.length).toBe(2);
    expect(result.imports[0].name).toBe("FuzzTestResult");
    expect(result.imports[1].name).toBe("ValidatorResult");
    expect(result.skeleton).toContain(
      "pub fn add_validator(r: &FuzzTestResult) -> ValidatorResult {"
    );
    expect(result.skeleton).toContain("let a: i32 = r.get_in(0).unwrap();");
    expect(result.skeleton).toContain("let b: f64 = r.get_in(1).unwrap();");
    expect(result.skeleton).toContain("let out: i32 = r.get_out().unwrap();");
    expect(result.skeleton).toContain("ValidatorResult::Pass");
    expect(result.skeleton).toContain("// Extract input arguments");
    expect(result.skeleton).toContain("// Validate properties");
    expect(result.fullTemplate).toContain(
      "use nanofuzz_runtime::FuzzTestResult;\nuse nanofuzz_runtime::ValidatorResult;\n"
    );
  });

  it("synthesizes Rust validator converting reference types to owned deserializable types", () => {
    const src = `pub fn parse_expr(s: &str, items: &[i32]) -> &'static str { s }`;
    const program = ProgramFactory.fromSource(() => src, "rust");
    const fnDef = program.functionsExported["parse_expr"];
    expect(fnDef).toBeDefined();

    const result = synthesizeValidator(fnDef, "rust");
    expect(result.skeleton).toContain("let s: String = r.get_in(0).unwrap();");
    expect(result.skeleton).toContain(
      "let items: Vec<i32> = r.get_in(1).unwrap();"
    );
    expect(result.skeleton).toContain(
      "let out: String = r.get_out().unwrap();"
    );
  });

  it("synthesizes OxCaml validator with Nanofuzz_runtime open and types", () => {
    const src = `let add (a : int) (b : int) : int = a + b`;
    const program = ProgramFactory.fromSource(() => src, "oxcaml");
    const fnDef = program.functionsExported["add"];
    expect(fnDef).toBeDefined();

    const result = synthesizeValidator(fnDef, "oxcaml");
    expect(result.name).toBe("add_validator");
    expect(result.imports.length).toBe(1);
    expect(result.imports[0].name).toBe("Nanofuzz_runtime");
    expect(result.skeleton).toContain(
      "let add_validator (r : Nanofuzz_runtime.fuzz_test_result) : Nanofuzz_runtime.validator_result ="
    );
    expect(result.skeleton).toContain("Nanofuzz_runtime.Pass");
    expect(result.fullTemplate).toContain("open Nanofuzz_runtime\n");
  });

  it("synthesizes Java validator with correct signature and FuzzTestResult unpacking", () => {
    const src = `public class MathOps { public static int add(int a, double b) { return (int)(a + b); } }`;
    const program = ProgramFactory.fromSource(() => src, "java");
    const fnDef = program.functionsExported["add"];
    expect(fnDef).toBeDefined();

    const result = synthesizeValidator(fnDef, "java");
    expect(result.name).toBe("addValidator");
    expect(result.imports.length).toBe(2);
    expect(result.imports[0].name).toBe("FuzzTestResult");
    expect(result.imports[1].name).toBe("ValidatorResult");
    expect(result.skeleton).toContain(
      "public static ValidatorResult addValidator(FuzzTestResult r) {"
    );
    expect(result.skeleton).toContain("int a = r.getIn(0);");
    expect(result.skeleton).toContain("double b = r.getIn(1);");
    expect(result.skeleton).toContain("int out = r.getOut();");
    expect(result.skeleton).toContain("return ValidatorResult.PASS;");
    expect(result.fullTemplate).toContain(
      "import com.nanofuzz.runtime.FuzzTestResult;\nimport com.nanofuzz.runtime.ValidatorResult;\n"
    );
  });

  it("synthesizes Virgil validator with correct signature and FuzzTestResult unpacking", () => {
    const src = `def add(a: int, b: float) -> int { return a; }`;
    const program = ProgramFactory.fromSource(() => src, "virgil");
    const fnDef = program.functionsExported["add"];
    expect(fnDef).toBeDefined();

    const result = synthesizeValidator(fnDef, "virgil");
    expect(result.name).toBe("addValidator");
    expect(result.skeleton).toContain(
      "def addValidator(r: FuzzTestResult) -> bool {"
    );
    expect(result.skeleton).toContain("var a: int = r.get_in_string(0);");
    expect(result.skeleton).toContain("var b: float = r.get_in_string(1);");
    expect(result.skeleton).toContain("var out: int = r.get_out_string();");
    expect(result.skeleton).toContain("return true;");
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
