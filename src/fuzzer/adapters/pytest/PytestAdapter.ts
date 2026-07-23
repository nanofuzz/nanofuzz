import * as vscode from "vscode";
import { FuzzTests } from "../../Fuzzer";
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

    // Auto-generated warning comment
    pytestData.push(
      `#`,
      `#              * * * DO NOT MODIFY * * *`,
      `#`,
      `# This file is auto-generated and maintained by ${nanofuzzName}.`,
      `# ${nanofuzzName} will overwrite changes made to this file.`,
      `#`,
      `# ${nanofuzzName} test file version: ${this._testSet.version}`,
      `#`,
      `import ${moduleName} as themodule`, //  <-- module under test
      `import pytest`,
      `import pytest_timeout`,
      `import time`,
      `${this.implicitOracle};`,
      ``,
      `def run_property_validator(input, testFn, validFn, timeout):`,
      `  result = { 'timeout': False, 'exception': False, 'in': input }`,
      `  result['in'] = input`,
      `  result['out'] = None`,
      `  startElapsedTime = time.time() # start timer`,
      `  try:`,
      `    result['out'] = testFn()`,
      `    result['exception'] = False`,
      `  except Exception as e:`,
      `    result['exception'] = True`,
      `  elapsedTime = time.time() - startElapsedTime # stop timer`,
      `  result['timeout'] = elapsedTime > timeout`,
      `  return validFn(result)`,
      ``
    );

    // Emit a test for each saved example
    for (const fn in this._testSet.functions) {
      const thisFn = this._testSet.functions[fn];
      const timeout = thisFn.options.fnTimeout;
      let i = -1;
      for (const testId in thisFn.tests) {
        const thisTest = thisFn.tests[testId];
        if (!thisTest.pinned) {
          continue; // Don't generate unit tests for examples that aren't pinned
        }
        i++;
        const inputArrStr = `[${thisTest.input
          .map((e) => JSON5.stringify(e.value))
          .join(",")}]`; // !!!!!!!!!! translation

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
              `@pytest.mark.timeout(${timeout} / 1000)`,
              `def test_${moduleName}_${fn}_${i}_expect_exception():`,
              `  # Expect raised exception`,
              `  with pytest.raises(Exception):`,
              `     themodule.${fn}(*${inputArrStr})`,
              ``
            );
          } else {
            pytestData.push(
              `@pytest.mark.timeout(${timeout} / 1000)`,
              `def test_${moduleName}_${fn}_${i}_expect_value():`,
              `  # Expect output value`,
              `  assert themodule.${fn}(*${inputArrStr}) == ${JSON5.stringify(expectedOutput[0].value)}`, // !!!!!!!!!! translation
              ``
            );
          }
        }
        // Property validators
        if (thisFn.options.useProperty) {
          for (const validator of thisFn.validators) {
            pytestData.push(
              `@pytest.mark.timeout(${timeout} / 1000)`,
              `def test_${moduleName}_${fn}_${i}_prop_${validator.slice(fn.length)}():`,
              `  # Expect property validator to not return "fail"`,
              `  input = ${inputArrStr}`,
              `  assert run_property_validator( input, lambda: themodule.${fn}(*input), themodule.${validator}, ${thisFn.options.fnTimeout}) != "fail"`,
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
              `@pytest.mark.timeout(${timeout} / 1000)`,
              `def test_${moduleName}_${fn}_${i}_expect_None():`,
              `  # As a void function, expect only None and no timeout or exception`,
              `  assert themodule.${fn}(*${inputArrStr}) == None`,
              ``
            );
          } else {
            pytestData.push(
              `@pytest.mark.timeout(${timeout} / 1000)`,
              `def test_${moduleName}_${fn}_${i}_heuristic():`,
              `  # Expect no timeout, exception, NaN, None, or infinity`,
              `  assert implicit_oracle(themodule.${fn}(*${inputArrStr})) != "fail"`,
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
