import { CompanionManager } from "./CompanionManager";
import * as ProgramFactory from "./ProgramFactory";
import * as Parser from "../adapters/ParserAdapter";

describe("CompanionManager", () => {
  beforeAll(async () => {
    await Parser.init();
  });
  describe("identification and target resolution", () => {
    it("recognizes TypeScript camelCase companion names", () => {
      expect(CompanionManager.isValidator("addValidator", "typescript")).toBe(
        true
      );
      expect(
        CompanionManager.isTransformer("addTransformer", "typescript")
      ).toBe(true);
      expect(
        CompanionManager.isUserGenerator("addGenerator", "typescript")
      ).toBe(true);

      expect(
        CompanionManager.getValidatorTarget("addValidator", "typescript")
      ).toBe("add");
      expect(
        CompanionManager.getTransformerTarget("addTransformer", "typescript")
      ).toBe("add");
      expect(
        CompanionManager.getUserGeneratorTarget("addGenerator", "typescript")
      ).toBe("add");
    });

    it("recognizes numbered TypeScript companions", () => {
      expect(CompanionManager.isValidator("addValidator1", "typescript")).toBe(
        true
      );
      expect(
        CompanionManager.getValidatorTarget("addValidator1", "typescript")
      ).toBe("add");

      const match = CompanionManager.matchCompanion(
        "addValidator2",
        "validator",
        "typescript"
      );
      expect(match).toEqual({ target: "add", index: 2 });
    });

    it("recognizes Rust snake_case companion names", () => {
      expect(CompanionManager.isValidator("add_validator", "rust")).toBe(true);
      expect(CompanionManager.isTransformer("add_transformer", "rust")).toBe(
        true
      );
      expect(CompanionManager.isUserGenerator("add_generator", "rust")).toBe(
        true
      );

      expect(CompanionManager.getValidatorTarget("add_validator", "rust")).toBe(
        "add"
      );
      expect(
        CompanionManager.getTransformerTarget("add_transformer", "rust")
      ).toBe("add");
      expect(
        CompanionManager.getUserGeneratorTarget("add_generator", "rust")
      ).toBe("add");
    });

    it("recognizes numbered Rust companions with underscores", () => {
      expect(CompanionManager.isValidator("add_validator_1", "rust")).toBe(
        true
      );
      expect(
        CompanionManager.getValidatorTarget("add_validator_1", "rust")
      ).toBe("add");

      const match = CompanionManager.matchCompanion(
        "add_validator_3",
        "validator",
        "rust"
      );
      expect(match).toEqual({ target: "add", index: 3 });
    });

    it("supports legacy PascalCase companion names in Rust and Python", () => {
      expect(CompanionManager.isValidator("addValidator", "rust")).toBe(true);
      expect(CompanionManager.isTransformer("addTransformer", "rust")).toBe(
        true
      );
      expect(CompanionManager.isUserGenerator("addGenerator", "rust")).toBe(
        true
      );

      expect(CompanionManager.isValidator("addValidator", "python")).toBe(true);
      expect(CompanionManager.isTransformer("addTransformer", "python")).toBe(
        true
      );
      expect(CompanionManager.isUserGenerator("addGenerator", "python")).toBe(
        true
      );
    });

    it("handles targets that contain underscores", () => {
      expect(
        CompanionManager.getValidatorTarget("calculate_tax_validator", "rust")
      ).toBe("calculate_tax");
      expect(
        CompanionManager.getValidatorTarget("calculate_tax_validator_2", "rust")
      ).toBe("calculate_tax");
      expect(
        CompanionManager.getTransformerTarget(
          "normalize_user_input_transformer",
          "python"
        )
      ).toBe("normalize_user_input");
    });

    it("rejects non-companion and empty target names", () => {
      expect(CompanionManager.isValidator("Validator", "typescript")).toBe(
        false
      );
      expect(CompanionManager.isValidator("_validator", "rust")).toBe(false);
      expect(CompanionManager.isValidator("add_validator_extra", "rust")).toBe(
        false
      );
      expect(
        CompanionManager.isTransformer("randomFunction", "typescript")
      ).toBe(false);
    });

    it("rejects internal fuzzer generator classes", () => {
      expect(
        CompanionManager.isUserGenerator("RandomInputGenerator", "typescript")
      ).toBe(false);
      expect(
        CompanionManager.isUserGenerator("UserInputGenerator", "typescript")
      ).toBe(false);
      expect(
        CompanionManager.isUserGenerator("random_input_generator", "rust")
      ).toBe(false);
    });
  });

  describe("name formatting and disambiguation", () => {
    it("formats companion names according to language conventions", () => {
      expect(
        CompanionManager.formatName("add", "validator", "typescript", 0)
      ).toBe("addValidator");
      expect(
        CompanionManager.formatName("add", "validator", "typescript", 1)
      ).toBe("addValidator1");

      expect(CompanionManager.formatName("add", "validator", "rust", 0)).toBe(
        "add_validator"
      );
      expect(CompanionManager.formatName("add", "validator", "rust", 1)).toBe(
        "add_validator_1"
      );

      expect(
        CompanionManager.formatName("add", "transformer", "python", 0)
      ).toBe("add_transformer");
      expect(
        CompanionManager.formatName("add", "transformer", "python", 2)
      ).toBe("add_transformer_2");
    });

    it("finds next available index and name", () => {
      const existingRust = ["add", "add_validator"];
      expect(
        CompanionManager.getNextAvailableIndex(
          existingRust,
          "add",
          "validator",
          "rust"
        )
      ).toBe(1);
      expect(
        CompanionManager.getNextAvailableName(
          existingRust,
          "add",
          "validator",
          "rust"
        )
      ).toBe("add_validator_1");

      const existingRustWithNumbered = [
        "add",
        "add_validator",
        "add_validator_1",
      ];
      expect(
        CompanionManager.getNextAvailableIndex(
          existingRustWithNumbered,
          "add",
          "validator",
          "rust"
        )
      ).toBe(2);
      expect(
        CompanionManager.getNextAvailableName(
          existingRustWithNumbered,
          "add",
          "validator",
          "rust"
        )
      ).toBe("add_validator_2");

      const existingTypeScript = ["add", "addValidator"];
      expect(
        CompanionManager.getNextAvailableName(
          existingTypeScript,
          "add",
          "validator",
          "typescript"
        )
      ).toBe("addValidator1");
    });
  });

  describe("program discovery", () => {
    it("discovers validators, transformers, and user generators from a TypeScript program", () => {
      const tsCode = `
        import { FuzzTestResult } from "@nanofuzz/runtime";
        export function add(a: number, b: number): number { return a + b; }
        export function addValidator(r: FuzzTestResult): string { return "pass"; }
        export function addTransformer(a: number, b: number): [number, number] { return [a, b]; }
        export function addGenerator(prng: () => number): [number, number] { return [1, 2]; }
        export function otherValidator(r: FuzzTestResult): string { return "pass"; }
      `;
      const program = ProgramFactory.fromSource(() => tsCode, "typescript");
      const addFn = program.functions["add"];
      expect(addFn).toBeDefined();

      const validators = CompanionManager.getValidators(program, addFn);
      expect(validators.map((v) => v.name)).toEqual(["addValidator"]);

      const transformers = CompanionManager.getTransformers(program, addFn);
      expect(transformers.map((t) => t.name)).toEqual(["addTransformer"]);

      const generators = CompanionManager.getUserGenerators(program, addFn);
      expect(generators.map((g) => g.name)).toEqual(["addGenerator"]);
    });

    it("discovers snake_case companions from a Rust program", () => {
      const rsCode = `
        use nanofuzz_runtime::{FuzzTestResult, ValidatorResult};
        pub fn multiply(a: i32, b: i32) -> i32 { a * b }
        pub fn multiply_validator(r: &FuzzTestResult) -> &'static str { "pass" }
        pub fn multiply_transformer(a: i32, b: i32) -> (i32, i32) { (a, b) }
        pub fn multiply_generator(mut prng: impl FnMut() -> f64) -> Option<(i32, i32)> { Some((1, 2)) }
      `;
      const program = ProgramFactory.fromSource(() => rsCode, "rust");
      const mulFn = program.functions["multiply"];
      expect(mulFn).toBeDefined();

      const validators = CompanionManager.getValidators(program, mulFn);
      expect(validators.map((v) => v.name)).toEqual(["multiply_validator"]);

      const transformers = CompanionManager.getTransformers(program, mulFn);
      expect(transformers.map((t) => t.name)).toEqual(["multiply_transformer"]);

      const generators = CompanionManager.getUserGenerators(program, mulFn);
      expect(generators.map((g) => g.name)).toEqual(["multiply_generator"]);
    });
  });
});
