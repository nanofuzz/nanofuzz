import { FunctionDef } from "../analysis/typescript/FunctionDef";
import { ArgDef } from "../analysis/typescript/ArgDef";
import { ArgOptions, ArgTag } from "../analysis/typescript/Types";
import { GeneratorFactory } from "./GeneratorFactory";
import seedrandom from "seedrandom";

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
 * Test that the random generators generate values within the bounds.
 *
 * TODO: These tests do not check that distributions are reasonably uniform.
 * TODO: Add tests for dimensions.
 */
describe("fuzzer/generator/GeneratorFactory", () => {
  // -------------------------------- Strings -------------------------------- //

  test(`Random String >= "" && <= "1" len 2-2`, () => {
    testRandomString("", "1", 2, 2);
  });

  test(`Random String >= " " && <= "A" len 0-1`, () => {
    testRandomString("", "A", 0, 1);
  });

  test(`Random String >= " " && <= "A" len 1-1`, () => {
    testRandomString("", "A", 1, 1);
  });

  test(`Random String >= " " && <= " " len 2`, () => {
    testRandomString(" ", " ", 2, 2);
  });

  test(`Random String >= " " && <= "!" len 0-2`, () => {
    testRandomString(" ", "!", 0, 2);
  });

  test(`Random String >= "ABC" && <= "ABCDEF" len 3-6`, () => {
    testRandomString("ABC", "ABCDEF", 3, 6);
  });

  test(`Random String >= "ABCDEF" && <= "ABC" (invalid min/max reversal) len 3-6`, () => {
    testRandomStringException("ABCDEF", "ABC", 3, 6);
  });

  test(`Random String >= "ABC" && <= "ABCDEF" len 6-3 (invalid min/max reversal)`, () => {
    testRandomStringException("ABC", "ABCDEF", 6, 3);
  });

  test(`Random String >= "ABCDEF" && <= "ABC" len 3-6 (invalid min/max reversal x2)`, () => {
    testRandomStringException("ABCDEF", "ABC", 6, 3);
  });

  // -------------------------------- Integers -------------------------------- //

  test(`Random Int >= 0 && <= 5`, () => {
    testRandomInt(0, 5);
  });

  test(`Random Int >= -50 && <= 50`, () => {
    testRandomInt(-50, 50);
  });

  test(`Random Int >= 50 && <= -50 (invalid min/max reversal)`, () => {
    testRandomIntException(50, -50);
  });

  // -------------------------------- Floats --------------------------------- //

  test(`Random Float >= 0 && <= 0`, () => {
    testRandomFloat(0, 0);
  });

  test(`Random Float >= -5.05 && <= 5.05`, () => {
    testRandomFloat(-5.05, 5.05);
  });

  test(`Random Float >= 5.05 && <= -5.05 (invalid min/max reversal)`, () => {
    testRandomFloatException(5.05, -5.05);
  });

  // ------------------------------- Booleans -------------------------------- //

  test(`Random Bool >= false && <= true`, () => {
    testRandomBool(false, true);
  });

  test(`Random Bool >= false && <= false`, () => {
    testRandomBool(false, false);
  });

  test(`Random Bool >= true && <= true`, () => {
    testRandomBool(true, true);
  });
});

/**
 * Checks that random ints generated are between floatMin and floatMax
 *
 * @param intMin Ninimum integer value
 * @param intMax Maximim integer value
 */
const testRandomInt = (intMin: number, intMax: number): void => {
  const prng = seedrandom(seed);
  const arg = new FunctionDef(
    {
      module: "dummy.ts",
      name: "test",
      src: tsFnWithNumberInput,
      startOffset: 0,
      endOffset: 999,
    },
    ArgDef.getDefaultOptions()
  ).getArgDefs();
  arg[0].setIntervals([{ min: intMin, max: intMax }]);
  const gen = GeneratorFactory(arg[0], prng);
  for (let i = 0; i < 1000; i++) {
    const result: number = gen();
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
  const prng = seedrandom(seed);
  const arg = new FunctionDef(
    {
      module: "dummy.ts",
      name: "test",
      src: tsFnWithNumberInput,
      startOffset: 0,
      endOffset: 999,
    },
    ArgDef.getDefaultFloatOptions()
  ).getArgDefs();
  arg[0].setIntervals([{ min: floatMin, max: floatMax }]);
  const gen = GeneratorFactory(arg[0], prng);
  for (let i = 0; i < 1000; i++) {
    const result: number = gen();
    expect(result).toBeGreaterThanOrEqual(floatMin);
    expect(result).toBeLessThanOrEqual(floatMax);
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
  const prng = seedrandom(seed);

  // Analyze the function, set the intervals, and get the generator
  const arg = new FunctionDef(
    {
      module: "dummy.ts",
      name: "test",
      src: tsFnWithBoolInput,
      startOffset: 0,
      endOffset: 999,
    },
    ArgDef.getDefaultFloatOptions()
  ).getArgDefs();
  arg[0].setIntervals([{ min: boolMin, max: boolMax }]);
  const gen = GeneratorFactory(arg[0], prng);

  // Test that the generator generates booleans within the bounds
  const results: boolean[] = [];
  for (let i = 0; i < 1000; i++) {
    results.push(gen());
  }
  expect(results.some((e) => e === boolMin)).toBeTruthy();
  expect(results.some((e) => e === boolMax)).toBeTruthy();
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
  const prng = seedrandom(seed);
  const options: ArgOptions = {
    ...ArgDef.getDefaultOptions(),
    strLength: { min: strLenMin, max: strLenMax },
  };

  // Pad to minimum length similar to how the generator would pad
  strMin = strMin.padEnd(strLenMin, options.strCharset[0]);
  strMax = strMax.padEnd(strLenMin, options.strCharset[0]);

  // Analyze the function, set the intervals, and get the generator
  const arg = new FunctionDef(
    {
      module: "dummy.ts",
      name: "test",
      src: tsFnWithStringInput,
      startOffset: 0,
      endOffset: 999,
    },
    options
  ).getArgDefs();
  arg[0].setIntervals([{ min: strMin, max: strMax }]);
  const gen = GeneratorFactory(arg[0], prng);

  // Test that the generator generates strings within the bounds
  const results: string[] = [];
  for (let i = 0; i < 1000; i++) {
    results.push(gen());
  }
  if (strMin !== strMax) {
    expect(results.some((e) => e !== strMin)).toBeTruthy();
    expect(results.some((e) => e !== strMax)).toBeTruthy();
  }
  results.forEach((result) => {
    expect(result.length).toBeGreaterThanOrEqual(strLenMin);
    expect(result.length).toBeLessThanOrEqual(strLenMax);
    expect(result >= strMin).toBeTruthy();
    expect(result <= strMax).toBeTruthy();
  });
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
