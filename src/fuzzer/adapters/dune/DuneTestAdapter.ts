import * as Config from "../../../Config";
import { FuzzTests } from "../../Types";
import * as ValueMapper from "../../mappers/ValueMapper";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import { AbstractProgram } from "../../analysis/AbstractProgram";
import { OxcamlProgram } from "../../analysis/oxcaml/OxcamlProgram";
import { ArgDef } from "../../analysis/ArgDef";
import { findInAncestor } from "../../Util";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { AbstractTestAdapter } from "../AbstractTestAdapter";

export class DuneTestAdapter extends AbstractTestAdapter {
  protected _testSet: FuzzTests;
  protected _module: string;

  constructor(testSet: FuzzTests, module: string) {
    super();
    this._testSet = testSet;
    this._module = module;
  } // constructor

  /**
   * Returns the name of the tool that uses the generated tests
   */
  public get toolname(): string {
    return "Dune";
  } // get: toolname

  /**
   * Returns the filename where OCaml/Dune tests are persisted.
   */
  public get filename(): string {
    const ext = path.extname(this._module);
    const base = ext ? this._module.slice(0, -ext.length) : this._module;
    return `${base}_nano_test.ml`;
  } // get: filename

  /**
   * Converts a set of NaNofuzz saved tests into an executable Dune / OCaml test suite.
   *
   * @returns string containing the OCaml test module
   */
  public toString(): string {
    const mlData: string[] = [];
    const baseFilename = path.basename(
      this._module,
      path.extname(this._module)
    );
    const capitalizedModName =
      baseFilename.charAt(0).toUpperCase() + baseFilename.slice(1);

    let pgm: AbstractProgram | undefined;
    try {
      pgm = ProgramFactory.fromFile(this._module, "oxcaml");
    } catch {
      // ignore if AST parsing fails
    }

    // Auto-generated warning comment
    mlData.push(
      `(*`,
      `              * * * DO NOT MODIFY * * *`,
      ``,
      `   This file is auto-generated and maintained by ${nanofuzzName}.`,
      `   ${nanofuzzName} will overwrite changes made to this file.`,
      ``,
      `   ${nanofuzzName} test file version: ${this._testSet.version}`,
      `*)`,
      ``,
      `[@@@warning "-33-26-27-32-34-37-39"]`,
      ``,
      `open Nanofuzz_runtime`
    );

    // If an ancestor dune file declares a library that is not this module, open it
    const userDune = findInAncestor(path.dirname(this._module), "dune");
    const userLibs = userDune ? extractDuneLibraries(userDune) : [];
    if (
      userLibs.length > 0 &&
      userLibs[0].toLowerCase() !== baseFilename.toLowerCase()
    ) {
      const capLib = userLibs[0].charAt(0).toUpperCase() + userLibs[0].slice(1);
      mlData.push(`open ${capLib}`);
    }

    mlData.push(
      ``,
      `module Target = struct`,
      `  include ${capitalizedModName}`,
      `end`,
      ``
    );

    const testInvocations: string[] = [];

    for (const fn in this._testSet.functions) {
      const thisFn = this._testSet.functions[fn];

      let argDefs: ArgDef[] = [];
      let returnArg: ArgDef | undefined;
      try {
        if (pgm && fn in pgm.functions) {
          const fnObj = pgm.functions[fn];
          argDefs = fnObj.getArgDefs();
          returnArg = fnObj.getReturnArg();
        }
      } catch {
        // ignore if AST parsing fails
      }

      const retType = returnArg
        ? OxcamlProgram.getTypeAnnotation(returnArg)
        : "int";

      let i = -1;
      for (const testId in thisFn.tests) {
        const thisTest = thisFn.tests[testId];
        if (!thisTest.pinned) {
          continue;
        }
        i++;

        const inputArgs = thisTest.input.map((e, idx) => {
          const formatted = ValueMapper.toLang("oxcaml", e.value, argDefs[idx]);
          return formatOxcamlArg(formatted);
        });

        const callStr =
          inputArgs.length === 0
            ? `Target.${fn} ()`
            : `Target.${fn} ${inputArgs.join(" ")}`;

        // Human-annotated expected output
        const expectedOutput = thisTest.expectedOutput;
        if (
          thisFn.options.useHuman &&
          expectedOutput &&
          expectedOutput.length
        ) {
          if (expectedOutput[0].isTimeout) {
            console.error(
              `Expected timeouts not currently supported in ${this.toolname} format`
            );
          } else if (expectedOutput[0].isException) {
            const testFnName = `test_${fn}_${i}_expect`;
            mlData.push(
              `let ${testFnName} () =`,
              `  let failed =`,
              `    try`,
              `      let _ = ${callStr} in`,
              `      false`,
              `    with _ -> true`,
              `  in`,
              `  assert_true ~message:"Expected exception was not raised" failed`,
              ``
            );
            testInvocations.push(`  ${testFnName} ();`);
          } else if (thisFn.isVoid) {
            const testFnName = `test_${fn}_${i}_expect`;
            mlData.push(`let ${testFnName} () =`, `  ${callStr}`, ``);
            testInvocations.push(`  ${testFnName} ();`);
          } else if (
            typeof expectedOutput[0].value === "number" &&
            Number.isNaN(expectedOutput[0].value)
          ) {
            const testFnName = `test_${fn}_${i}_expect`;
            mlData.push(
              `let ${testFnName} () =`,
              `  let actual = ${callStr} in`,
              `  assert_true ~message:"Expected NaN" (Float.is_nan actual)`,
              ``
            );
            testInvocations.push(`  ${testFnName} ();`);
          } else {
            const expectedStr = ValueMapper.toLang(
              "oxcaml",
              expectedOutput[0].value,
              returnArg
            );
            const testFnName = `test_${fn}_${i}_expect`;
            mlData.push(
              `let ${testFnName} () =`,
              `  let actual = ${callStr} in`,
              `  assert_equal ${expectedStr} actual`,
              ``
            );
            testInvocations.push(`  ${testFnName} ();`);
          }
        }

        // Property validators
        if (thisFn.options.useProperty) {
          for (const validator of thisFn.validators) {
            const validatorSuffix = (
              validator.startsWith(fn) ? validator.slice(fn.length) : validator
            ).replace(/^_+/, "");

            const testFnName = `test_${fn}_${i}_prop_${validatorSuffix}`;
            const serExpr = buildSerializer(retType, "actual");
            const inputArgsJson = thisTest.input.map((e) => {
              const rawJsonStr = JSON.stringify(JSON.stringify(e.value));
              return `Yojson.Safe.from_string ${rawJsonStr}`;
            });

            mlData.push(
              `let ${testFnName} () =`,
              `  let (out_json, exception_) =`,
              `    try`,
              `      let actual = ${callStr} in`,
              `      (${serExpr}, false)`,
              `    with _ -> (\`Null, true)`,
              `  in`,
              `  let args_raw = [ ${inputArgsJson.join("; ")} ] in`,
              `  let ftr = Nanofuzz_runtime.make_fuzz_test_result`,
              `    ~inputs:args_raw`,
              `    ~out:out_json`,
              `    ~exception_`,
              `    ~timeout:false`,
              `  in`,
              `  try`,
              `    let val_res = Target.${validator} ftr in`,
              `    assert_true ~message:"Property validator failed" (val_res <> Nanofuzz_runtime.Fail)`,
              `  with`,
              `  | Nanofuzz_runtime.Unsatisfied_assumption _ -> ()`,
              `  | exn -> raise (Failure ("Validator raised exception: " ^ Printexc.to_string exn))`,
              ``
            );
            testInvocations.push(`  ${testFnName} ();`);
          }
        }

        // Heuristic oracle - run only if turned on and no other oracle is present
        if (
          thisFn.options.useImplicit &&
          !(thisFn.options.useProperty && thisFn.validators.length) &&
          !(thisFn.options.useHuman && expectedOutput)
        ) {
          const testFnName = `test_${fn}_${i}_heuristic`;
          if (thisFn.isVoid) {
            mlData.push(
              `let ${testFnName} () =`,
              `  (* As a void function, expect no exception *)`,
              `  ${callStr}`,
              ``
            );
          } else {
            const serExpr = buildSerializer(retType, "actual");
            mlData.push(
              `let ${testFnName} () =`,
              `  (* Expect no exception, NaN, or null *)`,
              `  let actual = ${callStr} in`,
              `  let res_json = ${serExpr} in`,
              `  assert_true ~message:"Implicit oracle failed" (Nanofuzz_runtime.implicit_oracle_value res_json)`,
              ``
            );
          }
          testInvocations.push(`  ${testFnName} ();`);
        }
      }
    }

    mlData.push(
      `let () =`,
      ...(testInvocations.length > 0 ? testInvocations : ["  ()"]),
      `  ()`
    );

    return mlData.join(os.EOL);
  } // fn: toString
} // class: DuneTestAdapter

const nanofuzzName = Config.get("nanofuzz.name", "NaNofuzz");

/**
 * Formats an OCaml argument string so negative numbers and compound expressions are parenthesized.
 */
function formatOxcamlArg(valStr: string): string {
  const trimmed = valStr.trim();
  if (
    (trimmed.startsWith("(") && trimmed.endsWith(")")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "None"
  ) {
    return trimmed;
  }
  if (trimmed.startsWith("-") || trimmed.includes(" ")) {
    return `(${trimmed})`;
  }
  return trimmed;
} // fn: formatOxcamlArg

/**
 * Builds an OCaml expression converting a return value `valVar` into a Yojson.Safe.t.
 */
function buildSerializer(typeAnnot: string, valVar: string): string {
  const cleanType = typeAnnot.trim();
  if (cleanType === "unit") return `\`Null`;
  if (
    cleanType === "int" ||
    cleanType === "#int" ||
    cleanType === "int32" ||
    cleanType === "nativeint"
  ) {
    return `\`Int ${valVar}`;
  }
  if (cleanType === "int64") {
    return `\`Intlit (Int64.to_string ${valVar})`;
  }
  if (cleanType === "float" || cleanType === "#float") {
    return `\`Float ${valVar}`;
  }
  if (cleanType === "bool") {
    return `\`Bool ${valVar}`;
  }
  if (cleanType === "string") {
    return `\`String ${valVar}`;
  }
  if (cleanType === "char") {
    return `\`String (String.make 1 ${valVar})`;
  }
  if (cleanType === "bytes") {
    return `\`String (Bytes.to_string ${valVar})`;
  }
  if (cleanType.endsWith(" list")) {
    const elemType = cleanType.slice(0, -5).trim();
    return `\`List (List.map (fun v -> ${buildSerializer(elemType, "v")}) ${valVar})`;
  }
  if (cleanType.endsWith(" array")) {
    const elemType = cleanType.slice(0, -6).trim();
    return `\`List (Array.to_list (Array.map (fun v -> ${buildSerializer(elemType, "v")}) ${valVar}))`;
  }
  if (cleanType.endsWith(" option")) {
    const elemType = cleanType.slice(0, -7).trim();
    return `(match ${valVar} with None -> \`Null | Some v -> ${buildSerializer(elemType, "v")})`;
  }
  return `\`Null`;
} // fn: buildSerializer

/**
 * Extracts declared library names from an ancestor `dune` file.
 */
function extractDuneLibraries(dunePath: string): string[] {
  const libs: string[] = [];
  try {
    const content = fs.readFileSync(dunePath, "utf8");
    const libMatch = /\(libraries\s+([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = libMatch.exec(content)) !== null) {
      const items = match[1].split(/\s+/).filter((s) => s.length > 0);
      for (const item of items) {
        if (!item.startsWith(":") && !libs.includes(item)) {
          libs.push(item);
        }
      }
    }
  } catch {
    // ignore
  }
  return libs;
} // fn: extractDuneLibraries
