import seedrandom from "seedrandom";
import { ArgDef, ArgOptions, ArgType, Interval } from "../analysis/Typescript";

/**
 * Builds and returns a generator function that generates a pseudo-
 * random value of the given type within an ArgDef's input interval.
 *
 * @param arg the argument definition for which to generate an input
 * @param prng pseudo-random number generator
 * @returns a function that generates pseudo-random input values
 *
 * Throws an exception if the argument type is not supported.
 *
 * TODO: bias selection of input interval based on interval size
 */
export function GeneratorFactory<T extends ArgType>(
  arg: ArgDef<T>,
  prng: seedrandom.prng
): () => any {
  // For constant values, return the constant
  if (arg.isConstant()) return () => arg.getConstantValue();

  let randFn: typeof getRandomNumber;

  switch (arg.getType()) {
    case "number":
      randFn = getRandomNumber;
      break;
    case "boolean":
      randFn = getRandomBool;
      break;
    case "string":
      randFn = getRandomString;
      break;
    case "object": // fallthrough !!!
    default:
      throw new Error(`Unsupported argument type: ${arg.getType()[0]}`);
  }

  // Setup environment for callback
  const intervals = arg.getIntervals();
  const options = arg.getOptions();
  const dimLength = arg.getOptions().dimLength;
  const isOptional = arg.isOptional();

  // Callback fn to generate random value
  const randFnWrapper = () => {
    // TODO: weight interval selection based on the size of the interval !!!
    const interval =
      intervals[
        getRandomNumber(
          prng,
          0,
          intervals.length - 1,
          ArgDef.getDefaultOptions() // use defaults for interval selection
        )
      ];
    return randFn(prng, interval.min, interval.max, options);
  };

  // If the arg is an array, return the array generator
  const randArgValueWrapper = !dimLength.length
    ? randFnWrapper
    : () => nArray(prng, randFnWrapper, dimLength, options);

  // Inject undefined values into arg only if it is optional
  return isOptional
    ? () => {
        if (prng() >= 0.5) return undefined;
        else return randArgValueWrapper();
      }
    : randArgValueWrapper; // mandatory arg
} // GeneratorFactory()

/**
 * Returns a random number >= min and <= max
 *
 * @param prng pseudo-random number generator
 * @param min minimum value allowed (inclusive)
 * @param max maximum value allowed (inclusive)
 * @param options argument option set
 * @returns random number >= min and <= max
 *
 * Throws an exception if min and max are not numbers
 */
const getRandomNumber = <T extends ArgType>(
  prng: seedrandom.prng,
  min: T,
  max: T,
  options: ArgOptions
): T => {
  if (typeof min !== "number" || typeof max !== "number")
    throw new Error("Min and max must be numbers");

  if (options.numInteger) {
    const minInt: number = Math.ceil(min);
    const maxInt: number = Math.floor(max) + 1;
    return Math.floor(prng() * (maxInt - minInt) + minInt) as T; // Max and Min are inclusive
  } else {
    return (prng() * (max - min) + min) as T; // Max and Min are inclusive
  }
}; // getRandomNumber()

/**
 * Returns a random number >= min and <= max
 *
 * @param prng pesudo-random number generator
 * @param min minimum value allowed (inclusive)
 * @param max maximum value allowed (inclusive)
 * @param options argument option set
 * @returns random boolean >= min and <= max
 *
 * Throws an exception if min and max are not booleans
 */
const getRandomBool = <T extends ArgType>(
  prng: seedrandom.prng,
  min: T,
  max: T,
  options: ArgOptions
): T => {
  if (typeof min !== "boolean" || typeof max !== "boolean")
    throw new Error("Min and max must be booleans");
  if (min && max) return true as T;
  if (!min && !max) return false as T;
  return (prng() >= 0.5) as T;
}; // getRandomBool()

/**
 * Returns a random string >= min and <= max with
 * length <= options.strLength.max and >= options.strLength.min.
 *
 * Note: If min or max length < options.strLength.min, min and max
 * are padded to the minimum length using options.strCharset[0].
 * Likewise, if min or max length > options.strLength.max, min
 * and max are truncated to options.strLength.max.
 *
 * @param prng pseudo-random number generator
 * @param min minimum value allowed (inclusive)
 * @param max maximum value allowed (inclusive)
 * @param options argument option set
 * @returns random string >= min and <= max
 *
 * Throws an exception if min and max are not strings
 *
 * TODO: Min and max may cause a non-uniform distribution of inputs.
 */
const getRandomString = <T extends ArgType>(
  prng: seedrandom.prng,
  min: T,
  max: T,
  options: ArgOptions
): T => {
  if (typeof min !== "string" || typeof max !== "string")
    throw new Error("Min and max must be strings");

  const charSet = options.strCharset;
  const intOptions = ArgDef.getDefaultOptions(); // use default for integer selection

  // Happify tsc
  let minStr: string = min;
  let maxStr: string = max;

  // Determine the length of the output string
  const strLen =
    options.strLength.min === options.strLength.max
      ? options.strLength.min
      : getRandomNumber(
          prng,
          Math.max(options.strLength.min, min.length),
          options.strLength.max,
          intOptions
        ); // use default for integer selection

  // Pad min and max to the minimum length, if required
  if (minStr.length < strLen) minStr = minStr.padEnd(strLen, charSet[0]);
  if (maxStr.length < strLen) maxStr = maxStr.padEnd(strLen, charSet[0]);

  // Sequentially choose each character in the string
  // Note: This provides a uniform distribution at each position, but
  //       the distribution of output is not uniform.
  let outStr = "";
  for (let i = 0; i < strLen; i++) {
    const minThisCharPos = charSet.indexOf(
      outStr === minStr.substring(0, i) ? minStr[i] : charSet[0]
    );
    const maxThisCharPos = charSet.indexOf(
      outStr === maxStr.substring(0, i)
        ? maxStr[i]
        : charSet[charSet.length - 1]
    );
    const thisChar =
      charSet[
        minThisCharPos === maxThisCharPos
          ? minThisCharPos
          : getRandomNumber(prng, minThisCharPos, maxThisCharPos, intOptions)
      ];
    outStr += thisChar;

    // Break out of the loop if we reach the max padded value
    if (outStr === max.padEnd(options.strLength.min, options.strCharset[0]))
      break;
  }

  return outStr as T;
}; // getRandomString()

/**
 * Adapted from: https://stackoverflow.com/a/12588826
 *
 * Returns an n-dimensional array of random values. The dimensions
 * and length of each dimension are specified in dimLengths. The
 * genFn function produces inputs with the appropriate type and
 * range for each array element.
 *
 * @param prng pseudo-random number generator
 * @param genFn generator for array element inputs
 * @param dimLength array of lengths for each n-dimension
 * @param options argument option set
 * @returns n-dimensional array of random values
 */
const nArray = (
  prng: seedrandom.prng,
  genFn: () => ArgType,
  dimLength: Interval<number>[],
  options: ArgOptions
): any => {
  if (dimLength.length) {
    const [dim, ...rest] = dimLength; // split the array: head, tail
    const newArray = []; // output array
    const thisDim = getRandomNumber(
      prng,
      dim.min,
      dim.max,
      ArgDef.getDefaultOptions()
    );
    for (let i = 0; i < thisDim; i++) {
      newArray[i] = nArray(prng, genFn, rest, options);
    }
    return newArray;
  } else {
    return genFn(); // Base case -- just an array of values
  }
}; // nArray()
