import * as Config from "../../../Config";
import { FuzzTests } from "../../Types";
import * as GoValueMapper from "../../mappers/go/GoValueMapper";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import { AbstractProgram } from "../../analysis/AbstractProgram";
import { GoProgram } from "../../analysis/go/GoProgram";
import * as path from "path";
import { AbstractTestAdapter } from "../AbstractTestAdapter";

export class GoTestAdapter extends AbstractTestAdapter {
  protected _testSet: FuzzTests;
  protected _module: string;
  protected _outputFilename?: string;

  constructor(testSet: FuzzTests, module: string, outputFilename?: string) {
    super();
    this._testSet = testSet;
    this._module = module;
    this._outputFilename = outputFilename;
  } // constructor

  public get toolname(): string {
    return "GoTest";
  }

  public get filename(): string {
    if (this._outputFilename) {
      return this._outputFilename;
    }
    const ext = path.extname(this._module);
    const base = ext ? this._module.slice(0, -ext.length) : this._module;
    return `${base}_nanofuzz_test.go`;
  }

  public toString(): string {
    const lines: string[] = [];
    const nanofuzzName = Config.get("nanofuzz.name", "NaNofuzz");

    let pgm: AbstractProgram | undefined;
    try {
      pgm = ProgramFactory.fromFile(this._module, "go");
    } catch {
      // ignore
    }

    const goPgm = pgm instanceof GoProgram ? pgm : undefined;
    const pkgName = goPgm?.getPackageName() || "main";

    lines.push(
      "//",
      "//              * * * DO NOT MODIFY * * *",
      "//",
      `// This file is auto-generated and maintained by ${nanofuzzName}.`,
      `// ${nanofuzzName} will overwrite changes made to this file.`,
      "//",
      `package ${pkgName}`,
      "",
      'import (',
      '\t"reflect"',
      '\t"testing"',
      ")",
      ""
    );

    const fnNames = Object.keys(this._testSet.functions);
    for (const fnName of fnNames) {
      const thisFn = this._testSet.functions[fnName];
      if (!thisFn || !thisFn.tests) continue;

      const fnObj = pgm?.functions[fnName];
      const argDefs = fnObj?.getArgDefs() ?? [];
      const isVoid = fnObj?.isVoid() ?? false;
      const returnArg = fnObj?.getReturnArg();

      const safeFnName = fnName.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`func Test${safeFnName}_NaNofuzz(t *testing.T) {`);

      let testIdx = 0;
      for (const testId in thisFn.tests) {
        const t = thisFn.tests[testId];
        if (!t.pinned) continue;
        const testLabel = `case_${testIdx++}`;
        const formattedArgs = t.input.map((e, idx) =>
          GoValueMapper.toGo(e.value, argDefs[idx])
        );

        lines.push(`\tt.Run("${testLabel}", func(t *testing.T) {`);

        if (t.output.some((o) => o.isException)) {
          lines.push(
            "\t\tdefer func() {",
            "\t\t\tif r := recover(); r == nil {",
            `\t\t\t\tt.Errorf("expected panic calling ${fnName}, got none")`,
            "\t\t\t}",
            "\t\t}()",
            `\t\t${fnName}(${formattedArgs.join(", ")})`
          );
        } else if (isVoid) {
          lines.push(`\t\t${fnName}(${formattedArgs.join(", ")})`);
        } else {
          const expectedVal =
            t.expectedOutput && t.expectedOutput.length > 0
              ? t.expectedOutput[0].value
              : t.output.length > 0
                ? t.output[0].value
                : undefined;
          const formattedExpected = GoValueMapper.toGo(
            expectedVal,
            returnArg
          );
          lines.push(
            `\t\tgot := ${fnName}(${formattedArgs.join(", ")})`,
            `\t\twant := ${formattedExpected}`,
            "\t\tif !reflect.DeepEqual(got, want) {",
            `\t\t\tt.Errorf("${fnName}() = %v, want %v", got, want)`,
            "\t\t}"
          );
        }

        lines.push("\t})");
      }

      lines.push("}\n");
    }

    return lines.join("\n");
  } // fn: toString
} // class: GoTestAdapter
