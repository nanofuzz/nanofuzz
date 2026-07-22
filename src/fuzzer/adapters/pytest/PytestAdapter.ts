import * as vscode from "vscode";
import { FuzzTests, Result } from "../../Fuzzer";
import * as JSON5 from "json5";
import * as fs from "node:fs";
import * as os from "os";
import * as path from "path";
import { AbstractTestAdapter } from "../AbstractTestAdapter";

export class PytestAdapter extends AbstractTestAdapter {
  protected _testSet;
  protected _module;
  protected _implicitOracle: string | undefined;

  constructor(testSet: FuzzTests, module: string) {
    super();
    this._testSet = testSet;
    this._module = module;
  }

  /**
   * Returns the name of the tool that uses the generated tests
   */
  public get toolname(): string {
    return "Pytest";
  }

  /**
   * Converts a set of NaNofuzz saved tests into a Jest test suite
   *
   * @param testSet list of saved NaNofuzz tests for the module under test
   * @param module path to module under test
   * @param timeout timeout for each test in ms
   * @returns string containing the Jest test suite for this module
   */
  public toString(): string {
    const pytestData: string[] = [];
    const moduleName = path
      .basename(this._module)
      .split(".")
      .slice(0, -1)
      .join("."); // remove .py
    const result: Result = {
      timeout: false,
      exception: false,
      in: [],
      out: undefined,
    };

    // Auto-generated warning comment
    pytestData.push(
      `#`,
      `#              * * * DO NOT MODIFY * * *`,
      `#`,
      `# This file is auto-generated and maintained by ${nanofuzzName}.`,
      `# ${nanofuzzName} will overwrite changes made to this file.`,
      `#`,
      `# ${nanofuzzName} test file version: ${this._testSet.version}`,
      `#`
    );

    // Emit the implicit oracle and custom validator wrappers
    pytestData.push(
      `import time`,
      `import ${moduleName} as themodule`, //  <-- module under test
      `${this.implicitOracle};`,
      ``,
      `def run_property_validator(input, testFn, validFn, timeout):`,
      `  result = {**${JSON5.stringify(result)}, output: None, input: input}`,
      `  startElapsedTime = time.time() # start timer`,
      `  try:`,
      `    result.out = testFn()`,
      `    result.exception = False`,
      `  except Exception as e:`,
      `    result.exception = True`,
      `  elapsedTime = time.time() - startElapsedTime # stop timer`,
      `  result.timeout = elapsedTime > timeout`,
      `  return validFn({**result})`,
      ``,
      `def test_${moduleName}():`
    );

    // Emit a test for each saved example
    for (const fn in this._testSet.functions) {
      const thisFn = this._testSet.functions[fn];
      //const timeout = thisFn.options.fnTimeout;
      //let i = -1;
      for (const testId in thisFn.tests) {
        const thisTest = thisFn.tests[testId];
        if (!thisTest.pinned) {
          continue; // Don't generate unit tests for examples that aren't pinned
        }
        //i++;
        let x = 0;
        let inputStr = "";
        thisTest.input
          .map((e) => e.value)
          .forEach((e) => {
            inputStr += x++ ? "," : "";
            inputStr += JSON5.stringify(e);
          });

        // Human-annotated expected output - if human validation is turned on
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
            pytestData.push(
              `  # Expect thrown exception`,
              `  with pytest.raises(Exception):`,
              `     themodule.${fn}(${inputStr})})`,
              ``
            );
          } else {
            pytestData.push(
              `  # Expect output value`,
              `  assert themodule.${fn}(${inputStr})) == ${JSON5.stringify(expectedOutput[0].value)}`,
              ``
            );
          }
        }
        // Property validators
        if (thisFn.options.useProperty) {
          for (const validator of thisFn.validators) {
            pytestData.push(
              `  # Expect property validator to not return false`,
              `  assert run_property_validator( ${JSON5.stringify(thisTest.input.map((e) => e.value))}, lambda _: themodule.${fn}(${inputStr}), themodule.${validator}, ${thisFn.options.fnTimeout}) != "fail"`,
              ``
            );
          }
        }

        // Heuristic oracle - run only if it is turned on AND no other oracle is present
        if (
          thisFn.options.useImplicit &&
          !(thisFn.options.useProperty && thisFn.validators.length) &&
          !(thisFn.options.useHuman && expectedOutput)
        ) {
          if (thisFn.isVoid) {
            pytestData.push(
              `  # As a void function, expect only None and no timeout or exception`,
              `  assert themodule.${fn}(${inputStr})) == None`,
              ``
            );
          } else {
            pytestData.push(
              `  # Expect no timeout, exception, NaN, None, or infinity`,
              `  assert implicit_oracle(themodule.${fn}(${inputStr})) != "fail"`,
              ``
            );
          }
        }
      }
    }
    pytestData.push(``);

    return pytestData.join(os.EOL);
  } // fn: toString()

  /**
   * Returns the filename where jest tests are persisted.
   *
   * @returns filename of jest tests
   */
  public get filename(): string {
    return (
      (this._module.split(".").slice(0, -1).join(".") || module) +
      "_nano_test.py"
    );
  } // fn: getFilename()

  protected get implicitOracle(): string {
    if (this._implicitOracle !== undefined) {
      return this._implicitOracle;
    }
    const oracleSource: string = module.filename.endsWith("extension.js")
      ? path.resolve(
          path.join(path.dirname(module.filename), "ImplicitOracle.py")
        ) // Running from build folder
      : path.resolve(
          path.join(
            path.dirname(module.filename),
            "..",
            "..",
            "oracles",
            "ImplicitOracle.py"
          )
        ); // Running from source (Jasmine)
    if (fs.existsSync(oracleSource)) {
      this._implicitOracle = fs.readFileSync(oracleSource).toString();
      return this._implicitOracle;
    } else {
      throw new Error(`Unable to locate ImplicitOracle.py: ${oracleSource}`);
    }
  }
} // class: JestTestAdapter

/**
 * The tool's current name (used for studies)
 */
const nanofuzzName = vscode.workspace.getConfiguration("nanofuzz").get("name");
