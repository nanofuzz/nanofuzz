import { FuzzTests, FuzzTestResult, implicitOracle } from "../Fuzzer";
import * as JSON5 from "json5";
import * as os from "os";
import * as path from "path";

/**
 * Converts a set of NaNofuzz saved tests into a Jest test suite
 *
 * @param testSet list of saved NaNofuzz tests for the module under test
 * @param module path to module under test
 * @param timeout timeout for each test in ms
 * @returns string containing the Jest test suite for this module
 */
export const toString = (
  testSet: FuzzTests,
  module: string,
  timeout: number // !!!!! Should be at the fn level, not the module level
): string => {
  const jestData: string[] = [];
  const moduleFn = path.basename(module).split(".").slice(0, -1).join("."); // remove .ts/.tsx
  const result: FuzzTestResult = {
    passedImplicit: false,
    validatorException: false,
    timeout: false,
    exception: false,
    input: [],
    output: [{ name: "0", offset: 0, value: undefined }],
    elapsedTime: 0,
    category: "unknown",
    pinned: true,
  };

  // Auto-generated warning comment
  jestData.push(
    `/**`,
    ` *              * * * DO NOT MODIFY * * *`,
    ` *`,
    ` * This file is auto-generated and maintained by NaNofuzz.`,
    ` * NaNofuzz will overwrite changes made to this file.`,
    ` */`
  );

  // Import the module under test
  jestData.push(`import * as themodule from './${moduleFn}';`, ``);

  // Generate the implicit oracle
  jestData.push(
    `// @ts-ignore`,
    `const implicitOracle = ${implicitOracle.toString()};`,
    ``,
    `// @ts-ignore`,
    `const runCustomValidator = (input,testFn,validFn,timeout) => {`,
    `  const testResult = ${JSON5.stringify(result)};`,
    `  testResult.input = input;`,
    `  const startElapsedTime = performance.now(); // start timer`,
    `  try {`,
    `    testResult.output[0]["value"] = testFn();`,
    `  } catch(e: any) {`,
    `    testResult.exception = true;`,
    `    testResult["exceptionMessage"] = e.message;`,
    `  }`,
    `  testResult.elapsedTime = performance.now() - startElapsedTime; // stop timer`,
    `  testResult.passedImplicit = implicitOracle(testResult.output[0]["value"]);`,
    `  testResult["passedValidator"] = validFn({...testResult})["passedValidator"];`,
    `  testResult.timeout = testResult.elapsedTime > timeout;`,
    `  return testResult;`,
    `}`,
    ``
  );

  // Specify the timeout
  jestData.push(`describe("${moduleFn}", () => {`, ``);

  // Generate a Jest test for each saved test
  for (const fn in testSet.functions) {
    const thisFn = testSet.functions[fn];
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

      // TODO Add logic to support custom validator functions !!!!!

      // Human-annotated expected output
      const expectedOutput = thisTest.expectedOutput;
      if (expectedOutput && expectedOutput.length) {
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

      // Custom validator
      if (thisFn.validator) {
        // prettier-ignore
        jestData.push(
          `  // Expect custom validator to not return false`,
          `  // If no validator decision, fallback to implicit oracle`,
          `  test("${fn}.${i}.validator", () => {`,
          `    const testResult = runCustomValidator( ${JSON5.stringify(thisTest.input)}, () => themodule.${fn}(${inputStr}), themodule.${thisFn.validator}, ${timeout});`,
          `    expect(testResult.timeout).toBeFalsy();`,
          `    if(testResult["passedValidator"]!==undefined) {`,
          `      expect(testResult["passedValidator"]).not.toBeFalsy();`,
          `    } else {`,
          `      expect(testResult["passedImplicit"]).not.toBeFalsy();`,
          `    }`,
          `  });`,
          ``,
        );
      }

      // Implicit oracle (last resort)
      if (!thisFn.validator && !expectedOutput) {
        jestData.push(
          `  // Expect no timeout, exception, NaN, null, undefined, or infinity`,
          `  test("${fn}.${i}.implicit", () => {expect(implicitOracle(themodule.${fn}(${inputStr}))).toBe(true);},${timeout});`,
          ``
        );
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
