import seedrandom from "seedrandom";
import {
  ArgDef,
  ArgOptions,
  ArgType,
  Interval,
} from "fuzzer/analysis/Typescript";

// !!! Support:
//  - different distributions (do with prng?)
//  - filtering (do at the call level -- not here)
//  - do a better job with typing on the next pass
// !!!
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

  // Setup environment for callbacks below
  const intervals = arg.getIntervals();
  const options = arg.getOptions();
  const dims: Interval<number>[] = arg.getOptions().dimLength ?? [];
  const randFnWrapper = () => {
    // TODO: weight interval selection based on the size of the interval !!!
    const interval =
      intervals[
        getRandomNumber(prng, 0, intervals.length - 1, { integer: true })
      ];
    return randFn(prng, interval.min, interval.max, options);
  };

  // Return Generators
  if (!dims.length) return randFnWrapper;
  else return () => nArray(randFnWrapper, dims);
}

// !!!
const getRandomNumber = <T extends ArgType>(
  prng: seedrandom.prng,
  min: T,
  max: T,
  options: ArgOptions
): T => {
  if (typeof min !== "number" || typeof max !== "number")
    throw new Error("Min and max must be numbers");
  if (options.integer) {
    const minNum: number = Math.ceil(min);
    const maxNum: number = Math.floor(max) + 1;
    return Math.floor(prng() * (maxNum - minNum) + minNum) as T; // Max and Min are inclusive
  } else {
    return (prng() * (max - min) + min) as T; // Max and Min are inclusive
  }
};

// !!!
const getRandomBool = <T extends ArgType>(
  prng: seedrandom.prng,
  min: T,
  max: T,
  options: ArgOptions
): T => {
  if (typeof min !== "boolean" && typeof max !== "boolean")
    throw new Error("Min and max must be booleans");
  return (prng() > 0.5) as T;
};

// !!!
const getRandomString = <T extends ArgType>(
  prng: seedrandom.prng,
  min: T,
  max: T,
  options: ArgOptions
): T => {
  if (typeof min !== "string" && typeof max !== "string")
    throw new Error("Min and max must be strings");
  throw new Error("Not yet implemented"); // !!!
};

// !!!
// Adapted from: https://stackoverflow.com/a/12588826
// !!! Need to support min and max for each dimension
const nArray = (randFn: () => ArgType, dims: Interval<number>[]): any => {
  if (!dims.length) {
    const [dim, ...rest] = dims;
    const newArray = [];
    for (let i = 0; i < dim.min; i++) {
      newArray[i] = nArray(randFn, rest);
    }
    return newArray;
  } else {
    return randFn();
  }
};
