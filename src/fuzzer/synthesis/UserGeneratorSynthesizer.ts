import seedrandom from "seedrandom";
import { FunctionDef } from "../analysis/FunctionDef";
import { PythonProgram } from "../analysis/python/PythonProgram";
import { ProgramLanguage } from "../analysis/Types";
import { ArgDefGenerator } from "../analysis/ArgDefGenerator";
import * as ValueMapper from "../mappers/ValueMapper";
import { FuzzerCodeSnippet } from "./Types";
import { getNextAvailableFnNumber } from "./Util";

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
  const userGenPrefix = fn.getName() + "Generator";

  let userGenName = generatorNameOverride;
  if (!userGenName) {
    const fnCounter = existingFnNames
      ? getNextAvailableFnNumber(existingFnNames, userGenPrefix)
      : 0;
    userGenName = `${userGenPrefix}${fnCounter === 0 ? "" : fnCounter}`;
  }

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

    const skeleton = `\n\ndef ${userGenName}(prng: Callable[[], float]) -> ${pyTupleType}:\n  # Return an argument tuple for ${fn.getName()}, or return None when exhausted\n  return ${pyDefaultArgs}\n`;
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
    const skeleton = `\n\nexport function ${userGenName}(prng: () => number): Parameters<typeof ${fn.getName()}> | undefined {\n  // Return an argument tuple for ${fn.getName()}, or return undefined when exhausted\n  return [${tsDefaultArgs}];\n}`;
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
