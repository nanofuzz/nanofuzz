import * as Config from "../../../Config";
import { FuzzTests, Result } from "../../Types";
import * as ValueMapper from "../../mappers/ValueMapper";
import * as os from "os";
import * as path from "path";
import { implicitOracle } from "../../oracles/ImplicitOracle";
import { AbstractTestAdapter } from "../AbstractTestAdapter";

export class JestAdapter extends AbstractTestAdapter {
  protected _testSet;
  protected _module;

  constructor(testSet: FuzzTests, module: string) {
    super();
    this._testSet = testSet;
    this._module = module;
  }

  /**
   * Returns the name of the tool that uses the generated tests
   */
  public get toolname(): string {
    return "Jest";
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
    const jestData: string[] = [];
    const moduleName = path
      .basename(this._module)
      .split(".")
      .slice(0, -1)
      .join("."); // remove .ts/.tsx
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
      ` * This file is auto-generated and maintained by ${nanofuzzName}.`,
      ` * ${nanofuzzName} will overwrite changes made to this file.`,
      ` *`,
      ` * ${nanofuzzName} test file version: ${this._testSet.version}`,
      ` */`
    );

    // Import the module under test
    jestData.push(`import * as themodule from './${moduleName}';`, ``);

    // Emit the implicit oracle and custom validator wrappers
    jestData.push(
      `// @ts-ignore`,
      `const implicitOracle: (x:unknown) => boolean = ${implicitOracle.toString()};`,
      ``,
      `// @ts-ignore`,
      `const runPropertyValidator = (input, testFn, validFn, timeout) => {`,
      `  const result = {...${ValueMapper.toLang("typescript", result)}, out: undefined, in: input};`,
      `  const startElapsedTime = performance.now(); // start timer`,
      `  try {`,
      `    result.out = testFn();`,
      `    result.exception = false;`,
      `  } catch(_e: unknown) {`,
      `    result.exception = true;`,
      `  }`,
      `  const elapsedTime = performance.now() - startElapsedTime; // stop timer`,
      `  result.timeout = elapsedTime > timeout;`,
      `  try {`,
      `    return validFn({...result});`,
      `  } catch(e: unknown) {`,
      `    if (e && typeof e === 'object' && 'name' in e && e.name === 'UnsatisfiedAssumption') {`,
      `      return 'unknown';`,
      `    }`,
      `    throw e;`,
      `  }`,
      `}`,
      ``,
      `// @ts-ignore`,
      `const runAsyncPropertyValidator = async (input, testFn, validFn, timeout) => {`,
      `  const result = {...${ValueMapper.toLang("typescript", result)}, out: undefined, in: input};`,
      `  const startElapsedTime = performance.now(); // start timer`,
      `  try {`,
      `    result.out = await testFn();`,
      `    result.exception = false;`,
      `  } catch(_e: unknown) {`,
      `    result.exception = true;`,
      `  }`,
      `  const elapsedTime = performance.now() - startElapsedTime; // stop timer`,
      `  result.timeout = elapsedTime > timeout;`,
      `  try {`,
      `    return await validFn({...result});`,
      `  } catch(e: unknown) {`,
      `    if (e && typeof e === 'object' && 'name' in e && e.name === 'UnsatisfiedAssumption') {`,
      `      return 'unknown';`,
      `    }`,
      `    throw e;`,
      `  }`,
      `}`,
      ``,
      `describe("${moduleName}", () => {`
    );

    // Emit a Jest test for each saved test
    for (const fn in this._testSet.functions) {
      const thisFn = this._testSet.functions[fn];
      const timeout = thisFn.options.fnTimeout;
      const isAsync = thisFn.isAsync === true;
      let i = -1;
      for (const testId in thisFn.tests) {
        const thisTest = thisFn.tests[testId];
        if (!thisTest.pinned) {
          continue; // Don't generate unit tests for examples that aren't pinned
        }
        i++;
        let x = 0;
        let inputStr = "";
        thisTest.input
          .map((e) => e.value)
          .forEach((e) => {
            inputStr += x++ ? "," : "";
            inputStr += ValueMapper.toLang("typescript", e);
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
            if (isAsync) {
              jestData.push(
                `  // Expect exception`,
                `  it("${fn}.${i}.expect", async () => {await expect(themodule.${fn}(${inputStr})).rejects.toThrow();},${timeout});`,
                ``
              );
            } else {
              jestData.push(
                `  // Expect exception`,
                `  it("${fn}.${i}.expect", () => {expect(() => {themodule.${fn}(${inputStr})}).toThrow();},${timeout});`,
                ``
              );
            }
          } else {
            if (isAsync) {
              jestData.push(
                `  // Expect output value`,
                `  it("${fn}.${i}.expect", async () => {expect(await themodule.${fn}(${inputStr})).toEqual(${ValueMapper.toLang(
                  "typescript",
                  expectedOutput[0].value
                )});},${timeout});`,
                ``
              );
            } else {
              jestData.push(
                `  // Expect output value`,
                `  it("${fn}.${i}.expect", () => {expect(themodule.${fn}(${inputStr})).toEqual(${ValueMapper.toLang(
                  "typescript",
                  expectedOutput[0].value
                )});},${timeout});`,
                ``
              );
            }
          }
        }
        // Property validators
        if (thisFn.options.useProperty) {
          for (const validator of thisFn.validators) {
            if (isAsync) {
              jestData.push(
                `  // Expect property validator to not return "fail"`,
                `  it("${fn}.${i}.prop.${validator.slice(fn.length)}", async () => {`,
                `    expect(await runAsyncPropertyValidator( ${ValueMapper.toLang(
                  "typescript",
                  thisTest.input.map((e) => e.value)
                )}, () => themodule.${fn}(${inputStr}), themodule.${validator}, ${thisFn.options.fnTimeout})).not.toEqual("fail");`,
                `  });`,
                ``
              );
            } else {
              jestData.push(
                `  // Expect property validator to not return "fail"`,
                `  it("${fn}.${i}.prop.${validator.slice(fn.length)}", () => {`,
                `    expect(runPropertyValidator( ${ValueMapper.toLang(
                  "typescript",
                  thisTest.input.map((e) => e.value)
                )}, () => themodule.${fn}(${inputStr}), themodule.${validator}, ${thisFn.options.fnTimeout})).not.toEqual("fail");`,
                `  });`,
                ``
              );
            }
          }
        }

        // Heuristic oracle - run only if it is turned on AND no other oracle is present
        if (
          thisFn.options.useImplicit &&
          !(thisFn.options.useProperty && thisFn.validators.length) &&
          !(thisFn.options.useHuman && expectedOutput)
        ) {
          if (thisFn.isVoid) {
            if (isAsync) {
              jestData.push(
                `  // As a void function, expect only undefined and no timeout or exception`,
                `  it("${fn}.${i}.heuristic", async () => {expect(await themodule.${fn}(${inputStr})).toBeUndefined();},${timeout});`,
                ``
              );
            } else {
              jestData.push(
                `  // As a void function, expect only undefined and no timeout or exception`,
                `  it("${fn}.${i}.heuristic", () => {expect(themodule.${fn}(${inputStr})).toBeUndefined();},${timeout});`,
                ``
              );
            }
          } else {
            if (isAsync) {
              jestData.push(
                `  // Expect no timeout, exception, NaN, null, undefined, or infinity`,
                `  it("${fn}.${i}.heuristic", async () => {expect(implicitOracle(await themodule.${fn}(${inputStr}))).toBe(true);},${timeout});`,
                ``
              );
            } else {
              jestData.push(
                `  // Expect no timeout, exception, NaN, null, undefined, or infinity`,
                `  it("${fn}.${i}.heuristic", () => {expect(implicitOracle(themodule.${fn}(${inputStr}))).toBe(true);},${timeout});`,
                ``
              );
            }
          }
        }
      }
    }
    jestData.push(`});`);

    return jestData.join(os.EOL);
  } // fn: toString()

  /**
   * Returns the filename where jest tests are persisted.
   *
   * @returns filename of jest tests
   */
  public get filename(): string {
    return (
      (this._module.split(".").slice(0, -1).join(".") || module) +
      ".nano.test.ts"
    );
  } // fn: getFilename()
} // class: JestTestAdapter

/**
 * The tool's current name (used for studies)
 */
const nanofuzzName = Config.get("nanofuzz.name", "NaNofuzz");
