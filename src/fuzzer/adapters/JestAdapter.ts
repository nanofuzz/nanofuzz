import * as vscode from "vscode";
import { FuzzTests, Result, implicitOracle } from "../Fuzzer";
import * as JSON5 from "json5";
import * as os from "os";
import * as path from "path";

/**
 * The tool's current name (used for studies)
 */
export const toolName = vscode.workspace
  .getConfiguration("nanofuzz")
  .get("name");

/**
 * Converts a set of NaNofuzz saved tests into a Jest test suite
 *
 * @param testSet list of saved NaNofuzz tests for the module under test
 * @param module path to module under test
 * @param timeout timeout for each test in ms
 * @returns string containing the Jest test suite for this module
 */
export const toString = (testSet: FuzzTests, module: string): string => {
  const jestData: string[] = [];
  const moduleFn = path.basename(module).split(".").slice(0, -1).join("."); // remove .ts/.tsx
  const result: Result = {
    timeout: false,
    exception: false,
    in: [],
    out: undefined,
  };

  // Auto-generated warning comment
  jestData.push(
    `/**`,
    ` *              * * * DO NOT MODIFY * * *`,
    ` *`,
    ` * This file is auto-generated and maintained by ${toolName}.`,
    ` * ${toolName} will overwrite changes made to this file.`,
    ` *`,
    ` * ${toolName} test file version: ${testSet.version}`,
    ` */`
  );

  // Import the module under test
  jestData.push(`import * as themodule from './${moduleFn}';`, ``);

  // Emit the implicit oracle and custom validator wrappers
  jestData.push(
    `// @ts-ignore`,
    `const implicitOracle = ${implicitOracle.toString()};`,
    ``,
    `// @ts-ignore`,
    `const runPropertyValidator = (input,testFn,validFn,timeout) => {`,
    `  const result = {...${JSON5.stringify(result)},out:undefined};`,
    `  result.in = input;`,
    `  const startElapsedTime = performance.now(); // start timer`,
    `  try {`,
    `    result.out = testFn();`,
    `  } catch(e: any) {`,
    `    result.exception = true;`,
    `  }`,
    `  const elapsedTime = performance.now() - startElapsedTime; // stop timer`,
    `  result.timeout = elapsedTime > timeout;`,
    `  return validFn({...result});`,
    `}`,
    ``
  );

  // Specify the timeout
  jestData.push(`describe("${moduleFn}", () => {`, ``);

  // Emit a Jest test for each saved test
  for (const fn in testSet.functions) {
    const thisFn = testSet.functions[fn];
    const timeout = thisFn.options.fnTimeout;
    let i = -1;
    for (const testId in thisFn.tests) {
      const thisTest = thisFn.tests[testId];
      if (!thisTest.pinned) {
        continue; // Don't generate Jest tests for saved tests that have correct icons but aren't pinned
      }
      i++;
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
      if (thisFn.options.useHuman && expectedOutput && expectedOutput.length) {
        if (expectedOutput[0].isTimeout) {
          // Expected timeouts -- not currently supported in Jest format!
          console.error(
            `Expected timeouts not currently supported in Jest format`
          );
        } else if (expectedOutput[0].isException) {
          // Expected exception
          jestData.push(
            `  // Expect thrown exception`,
            `  test("${fn}.${i}.human", () => {expect( () => {themodule.${fn}(${inputStr})}).toThrow();},${timeout});`,
            ``
          );
        } else {
          // Expected output value
          jestData.push(
            `  // Expect output value`,
            `  test("${fn}.${i}.human", () => {expect(themodule.${fn}(${inputStr})).toStrictEqual(${JSON5.stringify(
              expectedOutput[0].value
            )});},${timeout});`,
            ``
          );
        }
      }
      // Property validators
      if (thisFn.options.useProperty) {
        for (const validator of thisFn.validators) {
          // prettier-ignore
          jestData.push(
          `  // Expect property validator to not return false`,
          `  test("${fn}.${i}.${validator}", () => {`,
          `    expect(runPropertyValidator( ${JSON5.stringify(thisTest.input.map((e) => e.value))}, () => themodule.${fn}(${inputStr}), themodule.${validator}, ${thisFn.options.fnTimeout})).not.toBeFalsy();`,
          `  });`,
          ``,
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
          jestData.push(
            `  // As a void function, expect only undefined and no timeout or exception`,
            `  test("${fn}.${i}.heuristic", () => {expect(themodule.${fn}(${inputStr})).toBeUndefined();},${timeout});`,
            ``
          );
        } else {
          jestData.push(
            `  // Expect no timeout, exception, NaN, null, undefined, or infinity`,
            `  test("${fn}.${i}.heuristic", () => {expect(implicitOracle(themodule.${fn}(${inputStr}))).toBe(true);},${timeout});`,
            ``
          );
        }
      }
    }
  }
  jestData.push(`});`);

  return jestData.join(os.EOL);
}; // fn: toJest()

/**
 * Returns the filename where jest tests are persisted.
 *
 * @returns filename of jest tests
 */
export const getFilename = (module: string): string => {
  module = module.split(".").slice(0, -1).join(".") || module; // remove .ts/.tsx
  return module + ".nano.test.ts";
}; // fn: getFilename()
