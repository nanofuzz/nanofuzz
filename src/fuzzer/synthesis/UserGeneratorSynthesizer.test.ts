import * as path from "node:path";
import * as ParserAdapter from "../adapters/ParserAdapter";
import * as ProgramFactory from "../analysis/ProgramFactory";
import { synthesizeUserGenerator } from "./UserGeneratorSynthesizer";

describe("src/fuzzer/synthesis/UserGeneratorSynthesizer", () => {
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

  it("synthesizes TypeScript user input generator with prng callable and Parameters return type", () => {
    const program = ProgramFactory.fromFile(tsFixture);
    const fnDef = program.functions["targetUserGen"];
    expect(fnDef).toBeDefined();

    const result = synthesizeUserGenerator(fnDef, "typescript");
    expect(result.name).toBe("targetUserGenGenerator");
    expect(result.skeleton).toContain(
      "export function targetUserGenGenerator(prng: () => number): Parameters<typeof targetUserGen> | undefined"
    );
    expect(result.skeleton).toContain("return [");
    expect(result.fullTemplate).toContain(
      "export function targetUserGenGenerator"
    );
  });

  it("synthesizes Python user input generator with Callable prng and tuple return type", () => {
    const program = ProgramFactory.fromFile(pyFixture);
    const fnDef = program.functions["py_user_gen"];
    expect(fnDef).toBeDefined();

    const result = synthesizeUserGenerator(fnDef, "python");
    expect(result.name).toBe("py_user_genGenerator");
    expect(result.imports.length).toBe(1);
    expect(result.imports[0].stmt).toContain("from typing import Callable");
    expect(result.skeleton).toContain(
      "def py_user_genGenerator(prng: Callable[[], float]) -> tuple[int, str] | None:"
    );
    expect(result.skeleton).toContain("return (");
    expect(result.fullTemplate).toContain("from typing import Callable");
  });

  it("disambiguates generator name when existing names conflict", () => {
    const program = ProgramFactory.fromFile(tsFixture);
    const fnDef = program.functions["targetUserGen"];

    const result = synthesizeUserGenerator(fnDef, "typescript", [
      "targetUserGenGenerator",
    ]);
    expect(result.name).toBe("targetUserGenGenerator1");
    expect(result.skeleton).toContain("targetUserGenGenerator1");
  });
});
