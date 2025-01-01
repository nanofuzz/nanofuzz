import seedrandom from "seedrandom";
import { ArgDef } from "../analysis/typescript/ArgDef";
import {
  ArgTag,
  ArgType,
  ArgOptions,
  Interval,
} from "../analysis/typescript/Types";

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
    case "literal":
      randFn = getLiteral;
      break;
    case "object":
      // We generate this here using arg
      randFn = <T extends ArgType>(
        prng: seedrandom.prng,
        min: T,
        max: T,
        options: ArgOptions
      ): T => {
        if (typeof min !== "object" || typeof max !== "object")
          throw new Error("Min and max must be objects");
        const outObj = {};
        for (const child of arg.getChildren()) {
          outObj[child.getName()] = GeneratorFactory(child, prng)();

          // Remove undefined object members, otherwise the
          // implicit oracle flags them.
          if (outObj[child.getName()] === undefined) {
            delete outObj[child.getName()];
          }
        }
        return outObj as T;
      };
      break;
    default:
      throw new Error(`Unsupported argument type: ${arg.getType()[0]}`);
  }

  // Setup environment for callback
  const intervals = arg.getIntervals();
  const type = arg.getType();
  const options = arg.getOptions();
  const dimLength = arg.getOptions().dimLength;
  const isOptional = arg.isOptional();

  // Callback fn to generate random value
  const randFnWrapper = () => {
    if (type === ArgTag.OBJECT) return randFn(prng, {}, {}, options);

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
 * Returns a literal value
 *
 * @param prng pesudo-random number generator
 * @param min minimum value allowed (inclusive)
 * @param max maximum value allowed (inclusive)
 * @param options argument option set
 * @returns the constant
 *
 * Throws an exception if min and max are not the same
 */
const getLiteral = <T extends ArgType>(
  prng: seedrandom.prng,
  min: T,
  max: T,
  options: ArgOptions
): T => {
  if (min === max) return min as T;
  throw new Error("Min and max must be the same for literals");
}; // getLiteral()

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

  // This generator does not currently support min and max, but we don't make
  // that option available in the UI anyway. Find the old code in v0.3.2 and fix
  // intervals for string types when it's time to implement this.
  const strLen = getRandomNumber(
    prng,
    options.strLength.min,
    options.strLength.max,
    intOptions
  ); // use default for integer selection

  // Sequentially choose each character in the string
  // Note: This provides a uniform distribution at each position, but
  //       the distribution of output is not uniform.
  const charSetLen = charSet.length - 1;
  let outStr = "";
  for (let i = 0; i < strLen; i++) {
    outStr += charSet[getRandomNumber(prng, 0, charSetLen, intOptions)];
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
