import * as JSON5 from "json5";
import { ArgDef } from "../analysis/typescript/ArgDef";
import { RandomInputGenerator } from "./RandomInputGenerator";
import { ProgramDef } from "../analysis/typescript/ProgramDef";
import { ArgOptions, ArgValueType } from "../analysis/typescript/Types";
import { FuzzIoElement } from "fuzzer/Types";

/**
 * Provide a seed to ensure tests are deterministic.
 */
const seed: string = "qwertyuiop";

/**
 * Dummy functions used for testing: this provides an expedient way
 * to generate the ArgDef object required by the GeneratorFactory.
 */
const tsFnWithStringInput = `function test(str: string):void {"";}`;
const tsFnWithNumberInput = `function test(num: number):void {0;}`;
const tsFnWithBoolInput = `function test(bool: boolean):void {true;}`;

/**
 * Dummy program definition needed for testing
 */
const dummyProgram = ProgramDef.fromSource(() => "");

/**
 * Test that the random generators generate values within the bounds.
 *
 * TODO: These tests do not check that distributions are reasonably uniform.
 * TODO: Add tests for dimensions.
 */
describe("fuzzer/generator/GeneratorFactory:", () => {
  // -------------------------------- Strings -------------------------------- //

  it(`Random String >= "" && <= "1" len 2-2`, () => {
    testRandomString("", "1", 2, 2);
  });

  it(`Random String >= " " && <= "A" len 0-1`, () => {
    testRandomString("", "A", 0, 1);
  });

  it(`Random String >= " " && <= "A" len 1-1`, () => {
    testRandomString("", "A", 1, 1);
  });

  it(`Random String >= " " && <= " " len 2`, () => {
    testRandomString(" ", " ", 2, 2);
  });

  it(`Random String >= " " && <= "!" len 0-2`, () => {
    testRandomString(" ", "!", 0, 2);
  });

  it(`Random String >= "ABC" && <= "ABCDEF" len 3-6`, () => {
    testRandomString("ABC", "ABCDEF", 3, 6);
  });

  it(`Random String >= "ABCDEF" && <= "ABC" (invalid min/max reversal) len 3-6`, () => {
    testRandomStringException("ABCDEF", "ABC", 3, 6);
  });

  it(`Random String >= "ABC" && <= "ABCDEF" len 6-3 (invalid min/max reversal)`, () => {
    testRandomStringException("ABC", "ABCDEF", 6, 3);
  });

  it(`Random String >= "ABCDEF" && <= "ABC" len 3-6 (invalid min/max reversal x2)`, () => {
    testRandomStringException("ABCDEF", "ABC", 6, 3);
  });

  // -------------------------------- Integers -------------------------------- //

  it(`Random Int >= 0 && <= 5`, () => {
    testRandomInt(0, 5);
  });

  it(`Random Int >= -50 && <= 50`, () => {
    testRandomInt(-50, 50);
  });

  it(`Random Int >= 50 && <= -50 (invalid min/max reversal)`, () => {
    testRandomIntException(50, -50);
  });

  // -------------------------------- Floats --------------------------------- //

  it(`Random Float >= 0 && <= 0`, () => {
    testRandomFloat(0, 0);
  });

  it(`Random Float >= -5.05 && <= 5.05`, () => {
    testRandomFloat(-5.05, 5.05);
  });

  it(`Random Float >= 5.05 && <= -5.05 (invalid min/max reversal)`, () => {
    testRandomFloatException(5.05, -5.05);
  });

  // ------------------------------- Booleans -------------------------------- //

  it(`Random Bool >= false && <= true`, () => {
    testRandomBool(false, true);
  });

  it(`Random Bool >= false && <= false`, () => {
    testRandomBool(false, false);
  });

  it(`Random Bool >= true && <= true`, () => {
    testRandomBool(true, true);
  });

  // !!!!!!! Need Composite Generator Tests Here
});

/**
 * Checks that random ints generated are between floatMin and floatMax
 *
 * @param intMin Ninimum integer value
 * @param intMax Maximim integer value
 */
const testRandomInt = (intMin: number, intMax: number): void => {
  const program = ProgramDef.fromSource(() => tsFnWithNumberInput);
  const arg = program.getFunctions()["test"].getArgDefs();
  arg[0].setIntervals([{ min: intMin, max: intMax }]);
  const gen = new RandomInputGenerator(arg, seed);
  for (let i = 0; i < 1000; i++) {
    const result: ArgValueType = gen.next()[0].value;
    expect(typeof result === "number" && Number.isInteger(result)).toBeTruthy();
    expect(result).toBeGreaterThanOrEqual(intMin);
    expect(result).toBeLessThanOrEqual(intMax);
  }
};

/**
 * Checks that the exception is thrown when the int min/max are reversed.
 *
 * @param intMin Minimum integer value
 * @param intMax Maximum float value
 */
const testRandomIntException = (intMin: number, intMax: number): void => {
  expect(() => {
    testRandomInt(intMin, intMax);
  }).toThrowError();
};

/**
 * Checks that random floats generated are between floatMin and floatMax
 *
 * @param floatMin Ninimum float value
 * @param floatMax Maximim float value
 */
const testRandomFloat = (floatMin: number, floatMax: number): void => {
  const program = ProgramDef.fromSource(() => tsFnWithNumberInput);
  const arg = program.getFunctions()["test"].getArgDefs();
  arg[0].setIntervals([{ min: floatMin, max: floatMax }]);
  const gen = new RandomInputGenerator(arg, seed);
  for (let i = 0; i < 1000; i++) {
    const input: ArgValueType = gen.next()[0].value;
    expect(typeof input === "number").toBeTruthy();
    expect(input).toBeGreaterThanOrEqual(floatMin);
    expect(input).toBeLessThanOrEqual(floatMax);
  }
};

/**
 * Checks that the exception is thrown when the float min/max are reversed.
 *
 * @param floatMin Minimum float value
 * @param floatMax Maximum float value
 */
const testRandomFloatException = (floatMin: number, floatMax: number): void => {
  expect(() => {
    testRandomFloat(floatMin, floatMax);
  }).toThrowError();
};

/**
 * Checks that random bolleans generated are between boolMin and boolMax.
 * If this seems trivial, it is.  But we still need to test it.
 *
 * @param boolMin Minimum boolean value
 * @param boolMax Maximum boolean value
 */
const testRandomBool = (boolMin: boolean, boolMax: boolean): void => {
  const program = ProgramDef.fromSource(() => tsFnWithBoolInput);
  const arg = program.getFunctions()["test"].getArgDefs();
  arg[0].setIntervals([{ min: boolMin, max: boolMax }]);
  const gen = new RandomInputGenerator(arg, seed);

  // Test that the generator generates booleans within the bounds
  const inputs: ArgValueType[] = [];
  for (let i = 0; i < 1000; i++) {
    inputs[i] = gen.next()[0].value;
  }
  expect(inputs.every((e) => typeof e === "boolean")).toBeTruthy();
  expect(inputs.some((e) => e === boolMin)).toBeTruthy();
  expect(inputs.some((e) => e === boolMax)).toBeTruthy();
};

/**
 * Checks that random strings generated are between strMin and strMax
 * and its length is between the bounds of strLenMin and strLenMax.
 *
 * @param strMin Minimum string value
 * @param strMax Maximum string value
 * @param strLenMin Minimum string length
 * @param strLenMax Maximum string length
 */
const testRandomString = (
  strMin: string,
  strMax: string,
  strLenMin: number,
  strLenMax: number
): void => {
  const options: ArgOptions = {
    ...ArgDef.getDefaultOptions(),
    strLength: { min: strLenMin, max: strLenMax },
  };

  // Pad to minimum length similar to how the generator would pad
  strMin = strMin.padEnd(strLenMin, options.strCharset[0]);
  strMax = strMax.padEnd(strLenMin, options.strCharset[0]);

  const program = ProgramDef.fromSource(() => tsFnWithStringInput, options);
  const arg = program.getFunctions()["test"].getArgDefs();
  arg[0].setIntervals([{ min: strMin, max: strMax }]);
  const gen = new RandomInputGenerator(arg, seed);

  // Test that the generator generates strings within the bounds
  const inputs: ArgValueType[] = [];
  for (let i = 0; i < 1000; i++) {
    const input = gen.next()[0].value;
    inputs[i] = input;
    expect(typeof input === "string").toBeTruthy();
    if (typeof input === "string") {
      expect(input.length).toBeGreaterThanOrEqual(strLenMin);
      expect(input.length).toBeLessThanOrEqual(strLenMax);

      // expect(input >= strMin).toBeTruthy(); !!!! strMin/Max support
      // expect(input <= strMax).toBeTruthy(); !!!! strMin/Max support
    }
  }
  if (strMin !== strMax) {
    // expect(inputs.some((e) => e !== strMin)).toBeTruthy(); !!!! strMin/Max support
    // expect(inputs.some((e) => e !== strMax)).toBeTruthy(); !!!! strMin/Max support
  }
};

/**
 * Checks that the exception is thrown when the string min/max or
 * string length min/max are reversed.
 *
 * @param strMin Minimum string value
 * @param strMax Maximum string value
 * @param strLenMin Minimum string length
 * @param strLenMax Maximum string length
 */
const testRandomStringException = (
  strMin: string,
  strMax: string,
  strLenMin: number,
  strLenMax: number
): void => {
  expect(() => {
    testRandomString(strMin, strMax, strLenMin, strLenMax);
  }).toThrowError(); // Invalid configuration
};
