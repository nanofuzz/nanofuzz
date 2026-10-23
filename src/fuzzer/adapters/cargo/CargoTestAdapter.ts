import * as Config from "../../../Config";
import { FuzzTests } from "../../Types";
import * as ValueMapper from "../../mappers/ValueMapper";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import { AbstractProgram } from "../../analysis/AbstractProgram";
import { RustProgram } from "../../analysis/rust/RustProgram";
import { ArgDef } from "../../analysis/ArgDef";
import * as os from "os";
import * as path from "path";
import { AbstractTestAdapter } from "../AbstractTestAdapter";

export class CargoTestAdapter extends AbstractTestAdapter {
  protected _testSet: FuzzTests;
  protected _module: string;

  constructor(testSet: FuzzTests, module: string) {
    super();
    this._testSet = testSet;
    this._module = module;
  }

  /**
   * Returns the name of the tool that uses the generated tests
   */
  public get toolname(): string {
    return "Cargo";
  }

  /**
   * Returns the filename where cargo/rust tests are persisted.
   */
  public get filename(): string {
    const ext = path.extname(this._module);
    const base = ext ? this._module.slice(0, -ext.length) : this._module;
    return `${base}_nano_test.rs`;
  }

  /**
   * Converts a set of NaNofuzz saved tests into a Cargo/Rust unit test suite.
   *
   * @returns string containing the Rust test module
   */
  public toString(): string {
    const rustData: string[] = [];
    const baseFilename = path.basename(this._module);

    let pgm: AbstractProgram | undefined;
    try {
      pgm = ProgramFactory.fromFile(this._module, "rust");
    } catch {
      // ignore if AST parsing fails
    }

    const shims: string[] = [];
    const fnShimNames: Record<string, string> = {};

    const fnNames = Object.keys(this._testSet.functions);
    const unexportedFns = fnNames.filter((fn) => {
      const fnObj = pgm?.functions[fn];
      return fnObj ? !fnObj.isExported() : false;
    });

    for (const fn of unexportedFns) {
      const fnObj = pgm?.functions[fn];
      if (!fnObj) continue;
      const shimName =
        unexportedFns.length <= 1
          ? "__nanofuzz_get__"
          : `__nanofuzz_get_${fn}__`;
      fnShimNames[fn] = shimName;

      const argDefs = fnObj.getArgDefs();
      const isVoid = fnObj.isVoid();
      const isAsync = fnObj.isAsync();
      const shimParams: string[] = [];
      const shimCallArgs: string[] = [];

      for (let i = 0; i < argDefs.length; i++) {
        const arg = argDefs[i];
        const typeAnnot = RustProgram.getTypeAnnotation(arg);
        shimParams.push(`arg_${i}: ${typeAnnot}`);
        shimCallArgs.push(`arg_${i}`);
      }

      const retArg = fnObj.getReturnArg();
      const retAnnot = isVoid
        ? ""
        : retArg
          ? ` -> ${RustProgram.getTypeAnnotation(retArg)}`
          : fnObj.getReturnType()?.name
            ? ` -> ${fnObj.getReturnType()?.name}`
            : "";
      const asyncKw = isAsync ? "async " : "";
      const awaitSuffix = isAsync ? ".await" : "";
      shims.push(
        `    pub ${asyncKw}fn ${shimName}(${shimParams.join(", ")})${retAnnot} {`,
        `        ${fn}(${shimCallArgs.join(", ")})${awaitSuffix}`,
        `    }`
      );
    }

    // Auto-generated warning comment
    rustData.push(
      `//`,
      `//              * * * DO NOT MODIFY * * *`,
      `//`,
      `// This file is auto-generated and maintained by ${nanofuzzName}.`,
      `// ${nanofuzzName} will overwrite changes made to this file.`,
      `//`,
      `// ${nanofuzzName} test file version: ${this._testSet.version}`,
      `//`,
      `#![allow(dead_code, unused_imports, unused_variables, unused_mut, non_snake_case)]`,
      ``,
      `extern crate nanofuzz_runtime;`,
      `use nanofuzz_runtime::{FuzzTestResult, ValidatorResult};`,
      ``,
      `mod target {`,
      `    include!("./${baseFilename}");`,
      ...(shims.length > 0 ? shims : []),
      `}`,
      ``
    );

    for (const fn in this._testSet.functions) {
      const thisFn = this._testSet.functions[fn];

      let argDefs: ArgDef[] = [];
      let returnArg: ArgDef | undefined;
      let isAsync = thisFn.isAsync === true;
      try {
        if (pgm && fn in pgm.functions) {
          const fnObj = pgm.functions[fn];
          argDefs = fnObj.getArgDefs();
          returnArg = fnObj.getReturnArg();
          if (fnObj.isAsync()) {
            isAsync = true;
          }
        }
      } catch {
        // ignore if AST parsing fails
      }

      let i = -1;
      for (const testId in thisFn.tests) {
        const thisTest = thisFn.tests[testId];
        if (!thisTest.pinned) {
          continue;
        }
        i++;

        const inputStr = thisTest.input
          .map((e, idx) => ValueMapper.toLang("rust", e.value, argDefs[idx]))
          .join(", ");
        const targetCallName = fnShimNames[fn] ?? fn;
        const rawCall = `target::${targetCallName}(${inputStr})`;
        const callStr = isAsync
          ? `nanofuzz_runtime::block_on(${rawCall})`
          : rawCall;

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
            rustData.push(
              `#[test]`,
              `#[should_panic]`,
              `fn test_${fn}_${i}_expect() {`,
              `    let _ = ${callStr};`,
              `}`,
              ``
            );
          } else if (thisFn.isVoid) {
            rustData.push(
              `#[test]`,
              `fn test_${fn}_${i}_expect() {`,
              `    ${callStr};`,
              `}`,
              ``
            );
          } else if (
            typeof expectedOutput[0].value === "number" &&
            Number.isNaN(expectedOutput[0].value)
          ) {
            if (returnArg?.isOptional()) {
              rustData.push(
                `#[test]`,
                `fn test_${fn}_${i}_expect() {`,
                `    let actual = ${callStr};`,
                `    assert!(actual.map_or(false, |v| v.is_nan()));`,
                `}`,
                ``
              );
            } else {
              rustData.push(
                `#[test]`,
                `fn test_${fn}_${i}_expect() {`,
                `    let actual = ${callStr};`,
                `    assert!(actual.is_nan());`,
                `}`,
                ``
              );
            }
          } else {
            const expectedStr = ValueMapper.toLang(
              "rust",
              expectedOutput[0].value,
              returnArg
            );
            rustData.push(
              `#[test]`,
              `fn test_${fn}_${i}_expect() {`,
              `    let actual = ${callStr};`,
              `    assert_eq!(actual, ${expectedStr});`,
              `}`,
              ``
            );
          }
        }

        // Property validators
        if (thisFn.options.useProperty) {
          for (const validator of thisFn.validators) {
            const validatorSuffix = validator.startsWith(fn)
              ? validator.slice(fn.length)
              : validator;

            const inputArgsJson = thisTest.input.map((e) =>
              JSON.stringify(e.value)
            );

            rustData.push(
              `#[test]`,
              `fn test_${fn}_${i}_prop_${validatorSuffix}() {`,
              `    let actual = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {`,
              `        ${callStr}`,
              `    }));`,
              `    let (out_json, exception) = match actual {`,
              `        Ok(v) => (serde_json::to_value(&v).unwrap_or(serde_json::Value::Null), false),`,
              `        Err(_) => (serde_json::Value::Null, true),`,
              `    };`,
              `    let args_raw = vec![${inputArgsJson.map((s) => JSON.stringify(s)).join(", ")}];`,
              `    let ftr = nanofuzz_runtime::FuzzTestResult::new(`,
              `        args_raw.into_iter().map(|s| serde_json::from_str(&s).unwrap_or(serde_json::Value::Null)).collect(),`,
              `        out_json,`,
              `        exception,`,
              `        false,`,
              `    );`,
              `    let val_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {`,
              `        target::${validator}(&ftr)`,
              `    }));`,
              `    match val_res {`,
              `        Ok(res) => assert_ne!(nanofuzz_runtime::ValidatorResult::from(res), nanofuzz_runtime::ValidatorResult::Fail),`,
              `        Err(e) => {`,
              `            if !e.is::<nanofuzz_runtime::UnsatisfiedAssumption>() {`,
              `                panic!("Validator panicked");`,
              `            }`,
              `        }`,
              `    }`,
              `}`,
              ``
            );
          }
        }

        // Heuristic oracle - run only if turned on and no other oracle is present
        if (
          thisFn.options.useImplicit &&
          !(thisFn.options.useProperty && thisFn.validators.length) &&
          !(thisFn.options.useHuman && expectedOutput)
        ) {
          if (thisFn.isVoid) {
            rustData.push(
              `#[test]`,
              `fn test_${fn}_${i}_heuristic() {`,
              `    // As a void function, expect no panic`,
              `    ${callStr};`,
              `}`,
              ``
            );
          } else {
            rustData.push(
              `#[test]`,
              `fn test_${fn}_${i}_heuristic() {`,
              `    // Expect no panic, NaN, None, or infinity`,
              `    let res = ${callStr};`,
              `    assert!(nanofuzz_runtime::implicit_oracle(&res));`,
              `}`,
              ``
            );
          }
        }
      }
    }

    return rustData.join(os.EOL);
  } // fn: toString
} // class: CargoTestAdapter

const nanofuzzName = Config.get("nanofuzz.name", "NaNofuzz");
