import { FunctionDef } from "../analysis/FunctionDef";
import { PythonProgram } from "../analysis/python/PythonProgram";
import { ProgramLanguage } from "../analysis/Types";
import { FuzzerCodeSnippet } from "./Types";
import { getNextAvailableFnNumber } from "./Util";

/**
 * Synthesizes a complete input transformer code skeleton for a function definition.
 *
 * @param fn Target FunctionDef to synthesize an input transformer for
 * @param lang Target language (TypeScript or Python). Defaults to fn.getLang()
 * @param existingFnNames Optional list of existing function names in the source module to avoid name collision
 * @param transformerNameOverride Optional explicit transformer function name
 * @returns FuzzerCodeSnippet containing function name, skeleton code, required imports, and full combined template
 */
export function synthesizeTransformer(
  fn: FunctionDef,
  lang?: ProgramLanguage,
  existingFnNames?: string[],
  transformerNameOverride?: string
): FuzzerCodeSnippet {
  const targetLang = lang ?? fn.getLang();
  const transformerPrefix = fn.getName() + "Transformer";

  let transformerName = transformerNameOverride;
  if (!transformerName) {
    const fnCounter = existingFnNames
      ? getNextAvailableFnNumber(existingFnNames, transformerPrefix)
      : 0;
    transformerName = `${transformerPrefix}${fnCounter === 0 ? "" : fnCounter}`;
  }

  const inArgs = fn.getArgDefs();
  const inputsTypeName = `${fn.getName()}Inputs`;
  const argDestructuring = inArgs.map((argDef) => argDef.getName()).join(", ");

  if (targetLang === "python") {
    const pyParams = inArgs
      .map(
        (a) =>
          `${a.getName()}: ${PythonProgram.getTypeAnnotation(a, {
            useTypeRefs: true,
          })}`
      )
      .join(", ");
    const pyTupleType =
      inArgs.length === 0
        ? "tuple[()]"
        : `tuple[${inArgs
            .map((a) =>
              PythonProgram.getTypeAnnotation(a, { useTypeRefs: true })
            )
            .join(", ")}]`;
    const pyReturnTuple =
      inArgs.length === 0
        ? "()"
        : inArgs.length === 1
          ? `(${argDestructuring},)`
          : `(${argDestructuring})`;

    const skeleton = `\n\ndef ${transformerName}(${pyParams}) -> ${pyTupleType}:\n  # 'raise UnsatisfiedAssumption(message)' to skip this input\n  # Otherwise, return the transformed inputs\n  return ${pyReturnTuple}\n`;

    return {
      name: transformerName,
      skeleton,
      imports: [],
      fullTemplate: skeleton.trimStart(),
    };
  } else {
    // TypeScript
    const tsDestructuring =
      inArgs.length === 0 ? "" : `  const [${argDestructuring}] = args;\n`;
    const skeleton = `\n\nexport function ${transformerName}(...args: Parameters<typeof ${fn.getName()}>): Parameters<typeof ${inputsTypeName}> {\n${tsDestructuring}  // 'throw new UnsatisfiedAssumption(message)' to skip this input\n  // Otherwise, return the transformed inputs\n  return [${argDestructuring}];\n}`;

    return {
      name: transformerName,
      skeleton,
      imports: [],
      fullTemplate: skeleton.trimStart(),
    };
  }
} // fn: synthesizeTransformer
