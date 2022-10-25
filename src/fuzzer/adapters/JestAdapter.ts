import { FuzzSavedTest, implicitOracle } from "../Fuzzer";
import * as os from "os";
import * as path from "path";

/**
 * Converts a set of NaNofuzz saved tests into a Jest test suite
 *
 * @param savedTests list of saved NaNofuzz tests for the module under test
 * @param module path to module under test
 * @param timeout timeout for each test in ms
 * @returns string containing the Jest test suite for this module
 */
export const toString = (
  savedTests: Record<string, Record<string, FuzzSavedTest>>,
  module: string,
  timeout: number
): string => {
  const jestData: string[] = [];
  const moduleFn = path.basename(module).split(".").slice(0, -1).join("."); // remove .ts/.tsx

  // Auto-generated warning comment
  jestData.push(
    `/**`,
    ` * DO NOT MODIFY`,
    ` * This file is auto-generated and maintained by NaNofuzz,`,
    ` * which will overwrite any changes made to this file.`,
    ` */`
  );

  // Import the module under test
  jestData.push(`import * as themodule from './${moduleFn}';`, ``);

  // Generate the implicit oracle
  jestData.push(`// @ts-ignore`);
  jestData.push(`const implicitOracle = ${implicitOracle.toString()};`, ``);

  // Specify the timeout
  jestData.push(`jest.setTimeout(${timeout});`, ``);

  // Generate a Jest test for each saved test
  for (const fn in savedTests) {
    let i = 0;
    for (const testId in savedTests[fn]) {
      let x = 0;
      let str = "";
      savedTests[fn][testId].input
        .map((e) => e.value)
        .forEach((e) => {
          str += x++ ? "," : "";
          str += JSON.stringify(e);
        });
      jestData.push(
        `test("${fn}.${i++}", () => {expect(implicitOracle(themodule.${fn}(${str}))).toBe(true);});`,
        ``
      );
    }
  }

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
