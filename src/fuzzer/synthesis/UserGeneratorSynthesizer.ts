import seedrandom from "seedrandom";
import { FunctionDef } from "../analysis/FunctionDef";
import { PythonProgram } from "../analysis/python/PythonProgram";
import { RustProgram } from "../analysis/rust/RustProgram";
import { ProgramLanguage } from "../analysis/Types";
import { CompanionManager } from "../analysis/CompanionManager";
import { ArgDefGenerator } from "../analysis/ArgDefGenerator";
import * as ValueMapper from "../mappers/ValueMapper";
import { FuzzerCodeSnippet } from "./Types";

/**
 * Synthesizes a complete user-provided input generator code skeleton for a function definition.
 *
 * @param fn Target FunctionDef to synthesize an input generator for
 * @param lang Target language (TypeScript or Python). Defaults to fn.getLang()
 * @param existingFnNames Optional list of existing function names in the source module to avoid name collision
 * @param generatorNameOverride Optional explicit generator function name
 * @returns FuzzerCodeSnippet containing function name, skeleton code, required imports, and full combined template
 */
export function synthesizeUserGenerator(
  fn: FunctionDef,
  lang?: ProgramLanguage,
  existingFnNames?: string[],
  generatorNameOverride?: string
): FuzzerCodeSnippet {
  const targetLang = lang ?? fn.getLang();
  const userGenName =
    generatorNameOverride ??
    CompanionManager.getNextAvailableName(
      existingFnNames ?? [],
      fn.getName(),
      "generator",
      targetLang
    );

  const inArgs = fn.getArgDefs();

  if (targetLang === "python") {
    const pyTupleType =
      inArgs.length === 0
        ? "tuple[()] | None"
        : `tuple[${inArgs
            .map((a) =>
              PythonProgram.getTypeAnnotation(a, { useTypeRefs: true })
            )
            .join(", ")}] | None`;

    const pyDefaultArgs =
      inArgs.length === 0
        ? "()"
        : inArgs.length === 1
          ? `(${ValueMapper.toLang(
              "python",
              ArgDefGenerator.gen(inArgs[0], seedrandom("skeleton"))
            )},)`
          : `(${inArgs
              .map((a) =>
                ValueMapper.toLang(
                  "python",
                  ArgDefGenerator.gen(a, seedrandom("skeleton"))
                )
              )
              .join(", ")})`;

    const imports = [
      {
        name: "Callable",
        stmt: `from typing import Callable\n`,
      },
    ];

    const skeleton = `\n\ndef ${userGenName}(prng: Callable[[], float]) -> ${pyTupleType}:\n  # Return an argument tuple for ${fn.getName()}, or return None when exhausted\n  # Call prng() to generate random float values in [0.0, 1.0)\n  return ${pyDefaultArgs}\n`;
    const importData = imports.map((i) => i.stmt).join("");
    const fullTemplate = `${importData}${skeleton.trimStart()}`;

    return {
      name: userGenName,
      skeleton,
      imports,
      fullTemplate,
    };
  } else if (targetLang === "rust") {
    const rustTupleType =
      inArgs.length === 0
        ? "Option<()>"
        : inArgs.length === 1
          ? `Option<(${RustProgram.getTypeAnnotation(inArgs[0], { useTypeRefs: true })},)>`
          : `Option<(${inArgs
              .map((a) =>
                RustProgram.getTypeAnnotation(a, { useTypeRefs: true })
              )
              .join(", ")})>`;

    const rustDefaultArgs =
      inArgs.length === 0
        ? "()"
        : inArgs.length === 1
          ? `(${ValueMapper.toLang(
              "rust",
              ArgDefGenerator.gen(inArgs[0], seedrandom("skeleton")),
              inArgs[0]
            )},)`
          : `(${inArgs
              .map((a) =>
                ValueMapper.toLang(
                  "rust",
                  ArgDefGenerator.gen(a, seedrandom("skeleton")),
                  a
                )
              )
              .join(", ")})`;

    const imports: { name: string; stmt: string }[] = [];
    const skeleton = `\n\npub fn ${userGenName}(mut _prng: impl FnMut() -> f64) -> ${rustTupleType} {\n  // Return an argument tuple for ${fn.getName()}, or return None when exhausted\n  // Call _prng() to generate random f64 values in [0.0, 1.0)\n  Some(${rustDefaultArgs})\n}`;
    const importData = imports.map((i) => i.stmt).join("");
    const fullTemplate = `${importData}${skeleton.trimStart()}`;

    return {
      name: userGenName,
      skeleton,
      imports,
      fullTemplate,
    };
  } else if (targetLang === "java") {
    const javaDefaultArgs =
      inArgs.length === 0
        ? "new Object[0]"
        : `new Object[] { ${inArgs
            .map((a) =>
              ValueMapper.toLang(
                "java",
                ArgDefGenerator.gen(a, seedrandom("skeleton")),
                a
              )
            )
            .join(", ")} }`;

    const imports = [
      {
        name: "DoubleSupplier",
        stmt: `import java.util.function.DoubleSupplier;\n`,
      },
    ];

    const skeleton = `\n\npublic static Object[] ${userGenName}(DoubleSupplier prng) {\n  // Return an argument array for ${fn.getName()}, or return null when exhausted\n  // Call prng.getAsDouble() to generate random double values in [0.0, 1.0)\n  return ${javaDefaultArgs};\n}`;
    const importData = imports.map((i) => i.stmt).join("");
    const fullTemplate = `${importData}${skeleton.trimStart()}`;

    return {
      name: userGenName,
      skeleton,
      imports,
      fullTemplate,
    };
  } else {
    // TypeScript
    const tsDefaultArgs =
      inArgs.length === 0
        ? ""
        : inArgs
            .map((a) =>
              ValueMapper.toLang(
                "typescript",
                ArgDefGenerator.gen(a, seedrandom("skeleton"))
              )
            )
            .join(", ");

    const imports: { name: string; stmt: string }[] = [];
    const skeleton = `\n\nexport function ${userGenName}(prng: () => number): Parameters<typeof ${fn.getName()}> | undefined {\n  // Return an argument tuple for ${fn.getName()}, or return undefined when exhausted\n  // Call prng() to generate random number values in [0.0, 1.0)\n  return [${tsDefaultArgs}];\n}`;
    const importData = imports.map((i) => i.stmt).join("");
    const fullTemplate = `${importData}${skeleton.trimStart()}`;

    return {
      name: userGenName,
      skeleton,
      imports,
      fullTemplate,
    };
  }
} // fn: synthesizeUserGenerator
