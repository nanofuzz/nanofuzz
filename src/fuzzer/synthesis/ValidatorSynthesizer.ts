import { FunctionDef } from "../analysis/FunctionDef";
import { TypescriptProgram } from "../analysis/typescript/TypescriptProgram";
import { PythonProgram } from "../analysis/python/PythonProgram";
import { ProgramLanguage } from "../analysis/Types";
import { FuzzerCodeSnippet } from "./Types";
import {
  getNextAvailableFnNumber,
  getIdentifierNameAvoidingConflicts,
} from "./Util";

// Candidate names for the validator result argument to avoid parameter name clashes
const resultArgCandidateNames = ["r", "result", "_r", "_result"];
const maxResultArgSuffix = 1000;

// Candidate names for the validator out variable to avoid parameter name clashes
const outVarCandidateNames = ["out", "output", "_out", "_output"];
const maxOutVarSuffix = 1000;

/**
 * Returns formatted validator argument declaration and the chosen result argument name.
 *
 * @param inArgs Input argument definitions
 * @returns Object with formatted argument string and result argument identifier name
 */
export function getValidatorArgs(
  inArgs: FunctionDef["getArgDefs"] extends () => infer R ? R : never
): {
  str: string;
  resultArgName: string;
} {
  const resultArgName = getIdentifierNameAvoidingConflicts(
    inArgs,
    resultArgCandidateNames,
    maxResultArgSuffix
  );
  const resultArgString = `${resultArgName.name}: FuzzTestResult`;
  return {
    str: `(${resultArgString})`,
    resultArgName: resultArgName.name,
  };
} // fn: getValidatorArgs

/**
 * Synthesizes a complete property validator code skeleton for a function definition.
 *
 * @param fn Target FunctionDef to synthesize a property validator for
 * @param lang Target language (TypeScript or Python). Defaults to fn.getLang()
 * @param existingFnNames Optional list of existing function names in the source module to avoid name collision
 * @param validatorNameOverride Optional explicit validator function name
 * @returns FuzzerCodeSnippet containing function name, skeleton code, required imports, and full combined template
 */
export function synthesizeValidator(
  fn: FunctionDef,
  lang?: ProgramLanguage,
  existingFnNames?: string[],
  validatorNameOverride?: string
): FuzzerCodeSnippet {
  const targetLang = lang ?? fn.getLang();
  const validatorPrefix = fn.getName() + "Validator";

  let validatorName = validatorNameOverride;
  if (!validatorName) {
    const fnCounter = existingFnNames
      ? getNextAvailableFnNumber(existingFnNames, validatorPrefix)
      : 0;
    validatorName = `${validatorPrefix}${fnCounter === 0 ? "" : fnCounter}`;
  }

  const inArgs = fn.getArgDefs();
  const validatorArgs = getValidatorArgs(inArgs);

  if (targetLang === "python") {
    const inArgLines = inArgs.map(
      (argDef, i) =>
        `  ${argDef.getName()}: ${PythonProgram.getTypeAnnotation(argDef)} = ${
          validatorArgs.resultArgName
        }['in'][${i}]`
    );
    const outTypeAsArg = fn.getReturnArg();
    const returnTypeStr = outTypeAsArg
      ? PythonProgram.getTypeAnnotation(outTypeAsArg)
      : undefined;
    const outVarName = getIdentifierNameAvoidingConflicts(
      inArgs,
      outVarCandidateNames,
      maxOutVarSuffix
    );
    const outArgLine = `  ${outVarName.name}${
      returnTypeStr ? ": " + returnTypeStr : ""
    } = ${validatorArgs.resultArgName}['out']`;

    const imports = [
      {
        name: "FuzzTestResult",
        stmt: `from nanofuzz_runtime import FuzzTestResult\n`,
      },
      {
        name: "Literal",
        stmt: `from typing import Literal\n`,
      },
    ];

    const bodyLines: string[] = [];
    if (inArgLines.length > 0) {
      bodyLines.push(...inArgLines);
    }
    bodyLines.push(outArgLine);
    bodyLines.push(`\n  return "pass"\n`);

    const skeleton = `\n\ndef ${validatorName}${validatorArgs.str} -> Literal["pass", "fail", "unknown"]:\n${bodyLines.join("\n")}`;
    const importData = imports.map((i) => i.stmt).join("");
    const fullTemplate = `${importData}${skeleton.trimStart()}`;

    return {
      name: validatorName,
      skeleton,
      imports,
      fullTemplate,
    };
  } else {
    // TypeScript
    const inArgLines = inArgs.map(
      (argDef, i) =>
        `  const ${argDef.getName()}: ${TypescriptProgram.getTypeAnnotation(
          argDef
        )} = ${validatorArgs.resultArgName}.in[${i}];`
    );
    const outTypeAsArg = fn.getReturnArg();
    const returnTypeStr = outTypeAsArg
      ? TypescriptProgram.getTypeAnnotation(outTypeAsArg)
      : undefined;
    const outVarName = getIdentifierNameAvoidingConflicts(
      inArgs,
      outVarCandidateNames,
      maxOutVarSuffix
    );
    const outArgLine = `  const ${outVarName.name}${
      returnTypeStr ? ": " + returnTypeStr : ""
    } = ${validatorArgs.resultArgName}.out;`;

    const imports = [
      {
        name: `FuzzTestResult`,
        stmt: `import { FuzzTestResult } from "@nanofuzz/runtime";\n`,
      },
    ];

    const bodyLines: string[] = [];
    if (inArgLines.length > 0) {
      bodyLines.push(...inArgLines);
    }
    bodyLines.push(outArgLine);
    bodyLines.push(`\n  return "pass";\n}`);

    const skeleton = `\n\nexport function ${validatorName}${validatorArgs.str}: "pass" | "fail" | "unknown" {\n${bodyLines.join("\n")}`;
    const importData = imports.map((i) => i.stmt).join("");
    const fullTemplate = `${importData}${skeleton.trimStart()}`;

    return {
      name: validatorName,
      skeleton,
      imports,
      fullTemplate,
    };
  }
} // fn: synthesizeValidator
