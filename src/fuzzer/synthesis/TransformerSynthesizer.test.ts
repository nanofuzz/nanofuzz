import * as path from "node:path";
import * as ParserAdapter from "../adapters/ParserAdapter";
import * as ProgramFactory from "../analysis/ProgramFactory";
import { synthesizeTransformer } from "./TransformerSynthesizer";

describe("src/fuzzer/synthesis/TransformerSynthesizer", () => {
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

  it("synthesizes TypeScript transformer with Parameters tuple typing", () => {
    const program = ProgramFactory.fromFile(tsFixture);
    const fnDef = program.functions["testStandardVoidReturnUndefined"];
    expect(fnDef).toBeDefined();

    const result = synthesizeTransformer(fnDef, "typescript");
    expect(result.name).toBe("testStandardVoidReturnUndefinedTransformer");
    expect(result.skeleton).toContain(
      "export function testStandardVoidReturnUndefinedTransformer(...args: Parameters<typeof testStandardVoidReturnUndefined>): Parameters<typeof testStandardVoidReturnUndefinedInputs>"
    );
    expect(result.skeleton).toContain("const [_x] = args;");
    expect(result.skeleton).toContain("return [_x];");
  });

  it("synthesizes Python transformer with typed parameters and return tuple", () => {
    const program = ProgramFactory.fromFile(pyFixture);
    const fnDef = program.functions["greeting"];
    expect(fnDef).toBeDefined();

    const result = synthesizeTransformer(fnDef, "python");
    expect(result.name).toBe("greetingTransformer");
    expect(result.skeleton).toContain(
      "def greetingTransformer(name: a) -> tuple[a]:"
    );
    expect(result.skeleton).toContain("return (name,)");
  });

  it("disambiguates transformer name when existing names conflict", () => {
    const program = ProgramFactory.fromFile(tsFixture);
    const fnDef = program.functions["testStandardVoidReturnUndefined"];

    const result = synthesizeTransformer(fnDef, "typescript", [
      "testStandardVoidReturnUndefinedTransformer",
    ]);
    expect(result.name).toBe("testStandardVoidReturnUndefinedTransformer1");
    expect(result.skeleton).toContain(
      "testStandardVoidReturnUndefinedTransformer1"
    );
  });
});
