import seedrandom from "seedrandom";
import { ArgDef } from "./ArgDef";
import * as RegexStringBuilder from "./RegexStringBuilder";
import * as JSONN from "../../Jsonn";
import {
  ArgTag,
  ArgValueType,
  ArgOptions,
  Interval,
  ArgValueTypeWrapped,
} from "./Types";

/**
 * Pseudo-randomly generates example values that conform to an ArgDef spec.
 */
export class ArgDefGenerator {
  protected _gens: PublicRandFn[] = []; // functions that generate example values
  protected _prng; // Pseudo random number generator

  /**
   * Creates a generator object
   *
   * @param `argDefs` array of ArgDef specs that describe the shape of values
   * @param `prng` pseudo-random number generator
   */
  public constructor(argDefs: ArgDef[], prng: seedrandom.prng) {
    this._prng = prng;
    this._gens = argDefs.map((argDef) =>
      generateRandomInputFn(argDef, this._prng)
    );
  } // fn: constructor

  /**
   * Generates the next example value.
   *
   * @returns value that conforms to the ArgDef specs
   */
  public next(): ArgValueTypeWrapped[] {
    return this._gens.map((e) => {
      return { tag: "ArgValueTypeWrapped", value: e() };
    });
  } // fn: next

  /**
   * Static function that generates a single set of values in one call.
   *
   * @param `spec` ArgDef spec that describes the shape of the values
   * @param `prng` pseudo random number generator
   * @param `genDims` generate array dimensions? (default: `true`)
   * @param `allowOptional` permit optional arguments to generate undefined? (default: `true`)
   *        E.g., ArgDefMutator sets this to `false` to force generation of a new value
   *        for an optional object member that was previously missing.
   * @returns value that conforms to the ArgDef specs
   */
  public static gen(
    spec: ArgDef,
    prng: seedrandom.prng,
    genDims = true,
    allowOptional = true
  ): ArgValueType {
    return generateRandomInputFn(spec, prng, genDims, allowOptional)();
  }
} // class: ArgDefGenerator

// Definition of a private random input generator function
type PrivateRandFn = (
  prng: seedrandom.prng,
  min: ArgValueType,
  max: ArgValueType,
  options: ArgOptions
) => ArgValueType;

// Definition of a public random input generator function
type PublicRandFn = () => ArgValueType;

/**
 * Builds and returns a generator function that generates a pseudo-
 * random value of the given type within an ArgDef's input interval.
 *
 * @param `arg` the argument definition for which to generate an input
 * @param `prng` pseudo-random number generator
 * @param `genDims` whether to generate dimensions for array arguments
 * @param `allowOptional` whether optional arguments may generate undefined
 * @returns a function that generates pseudo-random input values
 *
 * Throws an exception if the argument type is not supported.
 *
 * TODO: bias selection of input interval based on interval size
 */
function generateRandomInputFn(
  arg: ArgDef,
  prng: seedrandom.prng,
  genDims = true /* true=generate array dimensions if present;
                    false=generate only the value */,
  allowOptional = true
): PublicRandFn {
  let randFn: PrivateRandFn;

  // For constant values of no dimensions, return the constant
  //if (arg.isConstant() && arg.getDim() === 0 && !arg.isNoInput())
  //  return () => arg.getConstantValue();

  const argType = arg.getType();
  switch (argType) {
    case ArgTag.NUMBER:
      randFn = getRandomNumber;
      break;
    case ArgTag.BOOLEAN:
      randFn = getRandomBool;
      break;
    case ArgTag.STRING:
      randFn = getRandomString;
      break;
    case ArgTag.BYTES:
      randFn = getRandomBytes;
      break;
    case ArgTag.LITERAL:
      randFn = getLiteral;
      break;
    case ArgTag.UNION:
      // We generate this here using arg
      randFn = (
        prng: seedrandom.prng,
        min: ArgValueType,
        max: ArgValueType
      ): ArgValueType => {
        if (typeof min !== "object" || typeof max !== "object")
          throw new Error("Min and max must be objects");
        let children = arg.getChildren().filter((child) => !child.isNoInput());
        if (!children.length) {
          children = arg.getChildren();
        }
        const rn = getRandomNumber(
          prng,
          0,
          children.length - 1,
          ArgDef.getDefaultOptions() // use defaults for union member selection
        );
        return generateRandomInputFn(children[rn], prng)();
      };
      break;
    case ArgTag.OBJECT:
      // We generate this here using arg
      randFn = (
        prng: seedrandom.prng,
        min: ArgValueType,
        max: ArgValueType
      ): ArgValueType => {
        if (typeof min !== "object" || typeof max !== "object")
          throw new Error("Min and max must be objects");
        const outObj: { [key: string]: ArgValueType } = {};
        for (const child of arg.getChildren().filter((e) => !e.isNoInput())) {
          outObj[child.getName()] = generateRandomInputFn(child, prng)();

          // Remove undefined object members, otherwise the
          // implicit oracle flags them.
          if (outObj[child.getName()] === undefined) {
            delete outObj[child.getName()];
          }
        }
        return outObj;
      };
      break;

    case ArgTag.DICTIONARY:
      randFn = (
        prng: seedrandom.prng,
        min: ArgValueType,
        max: ArgValueType
      ): ArgValueType => {
        if (typeof min !== "object" || typeof max !== "object")
          throw new Error("Min and max must be objects");
        const [keySpec, valueSpec] = arg.getChildren();
        if (!keySpec || !valueSpec) {
          throw new Error("Dictionary arguments require key and value types");
        }
        // The number of key-value entries is sampled dictLength times.
        const dictLen = arg.getOptions().dictLength;
        const count = getRandomNumber(
          prng,
          dictLen.min,
          dictLen.max,
          ArgDef.getDefaultOptions()
        );
        const out: { [key: string]: ArgValueType } = {};
        const keyGen = generateRandomInputFn(keySpec, prng);
        const valGen = generateRandomInputFn(valueSpec, prng);

        entryLoop: for (let i = 0; i < count; i++) {
          let attempts = 0;
          while (true) {
            const keyStr = String(keyGen());
            if (!Object.prototype.hasOwnProperty.call(out, keyStr)) {
              out[keyStr] = valGen();
              continue entryLoop;
            }
            if (++attempts > 50) {
              if (Object.keys(out).length >= dictLen.min) {
                break entryLoop;
              }
              throw new Error(
                "Unable to generate enough unique dictionary keys. Are constraints possible to meet?"
              );
            }
          }
        }
        return out;
      };
      break;

    case ArgTag.TUPLE:
      randFn = (
        prng: seedrandom.prng,
        min: ArgValueType,
        max: ArgValueType
      ): ArgValueType => {
        if (typeof min !== "object" || typeof max !== "object")
          throw new Error("Min and max must be objects");
        const outTuple: ArgValueType[] = [];
        for (const child of arg.getChildren().filter((e) => !e.isNoInput())) {
          outTuple.push(generateRandomInputFn(child, prng)());
        }
        return outTuple;
      };
      break;

    case ArgTag.UNRESOLVED:
      throw new Error(`Unsupported argument type: ${argType[0]}`);
  }

  // Setup environment for callback
  const intervals = arg.getIntervals();
  const type = arg.getType();
  const options = arg.getOptions();
  const dimLength = arg.getOptions().dimLength;
  const isOptional = arg.isOptional();
  const regexGenerator =
    type === ArgTag.STRING && options.strRegex !== undefined
      ? RegexStringBuilder.create(options.strRegex, prng, options)
      : undefined;

  // Callback fn to generate value
  const randFnWrapper: PublicRandFn = () => {
    if (arg.isNoInput()) return undefined;
    if (
      type === ArgTag.OBJECT ||
      type === ArgTag.DICTIONARY ||
      type === ArgTag.TUPLE
    ) {
      return randFn(prng, {}, {}, options);
    }
    if (type === ArgTag.UNION) {
      if (arg.getChildren().filter((child) => !child.isNoInput()).length) {
        return randFn(prng, {}, {}, options);
      } else {
        return undefined; // no active union members
      }
    }
    if (type === ArgTag.LITERAL && !intervals.length) return undefined;
    if (regexGenerator) return regexGenerator();

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
  let randArgValueWrapper: PublicRandFn;
  const constantLeaves =
    dimLength.length === 1 &&
    genDims &&
    options.dimsUnique &&
    type === ArgTag.UNION
      ? getDiscreteConstantLeaves(arg)
      : undefined;

  if (constantLeaves !== undefined) {
    randArgValueWrapper = () => {
      const dim = dimLength[0];
      const targetLen = getRandomNumber(
        prng,
        dim.min,
        dim.max,
        ArgDef.getDefaultOptions()
      );

      if (constantLeaves.length < targetLen) {
        return nArray(prng, randFnWrapper, dimLength, options);
      }

      // Partial Fisher-Yates shuffle over constant leaf indices
      const indices = Array.from(
        { length: constantLeaves.length },
        (_, idx) => idx
      );
      for (let i = 0; i < targetLen; i++) {
        const j = getRandomNumber(
          prng,
          i,
          constantLeaves.length - 1,
          ArgDef.getDefaultOptions()
        );
        const temp = indices[i];
        indices[i] = indices[j];
        indices[j] = temp;
      }

      // Generate values for the targetLen selected unique constant leaves
      const result: ArgValueType[] = [];
      for (let i = 0; i < targetLen; i++) {
        result.push(
          generateRandomInputFn(constantLeaves[indices[i]], prng, false)()
        );
      }
      return result;
    };
  } else {
    randArgValueWrapper =
      dimLength.length && genDims
        ? () => nArray(prng, randFnWrapper, dimLength, options)
        : randFnWrapper;
  }

  // Inject undefined values into arg only if it is optional
  // and we are not generating values inside an array
  return isOptional && genDims && allowOptional
    ? () => {
        if (prng() >= 0.5) return undefined;
        else return randArgValueWrapper();
      }
    : randArgValueWrapper; // mandatory arg
} // fn: generateRandomInput

/**
 * Returns a random number >= min and <= max
 *
 * @param `prng` pseudo-random number generator
 * @param `min` minimum value allowed (inclusive)
 * @param `max` maximum value allowed (inclusive)
 * @param `options` argument option set
 * @returns random number >= min and <= max
 *
 * Throws an exception if min and max are not numbers
 */
const getRandomNumber = (
  prng: seedrandom.prng,
  min: ArgValueType,
  max: ArgValueType,
  options: ArgOptions
): number => {
  if (typeof min !== "number" || typeof max !== "number")
    throw new Error("Min and max must be numbers");

  if (options.numInteger) {
    const minInt: number = Math.ceil(min);
    const maxInt: number = Math.floor(max) + 1;
    return Math.floor(prng() * (maxInt - minInt) + minInt); // Max and Min are inclusive
  } else {
    return prng() * (max - min) + min; // Max and Min are inclusive
  }
}; // fn: getRandomNumber

/**
 * Returns a random number >= min and <= max
 *
 * @param `prng` pesudo-random number generator
 * @param `min` minimum value allowed (inclusive)
 * @param `max` maximum value allowed (inclusive)
 * @param `options` argument option set
 * @returns random boolean >= min and <= max
 *
 * Throws an exception if min and max are not booleans
 */
const getRandomBool: PrivateRandFn = (
  prng: seedrandom.prng,
  min: ArgValueType,
  max: ArgValueType
): boolean => {
  if (typeof min !== "boolean" || typeof max !== "boolean")
    throw new Error("Min and max must be booleans");
  if (min && max) return true;
  if (!min && !max) return false;
  return prng() >= 0.5;
}; // fn: getRandomBool

/**
 * Returns a literal value
 *
 * @param `prng` pesudo-random number generator
 * @param `min` minimum value allowed (inclusive)
 * @param `max` maximum value allowed (inclusive)
 * @param `options` argument option set
 * @returns the constant
 *
 * Throws an exception if min and max are not the same
 */
const getLiteral: PrivateRandFn = (
  prng: seedrandom.prng,
  min: ArgValueType,
  max: ArgValueType
): ArgValueType => {
  if (min === max) return min;
  throw new Error("Min and max must be the same for literals");
}; // fn: getLiteral

/**
 * Returns a random string >= min and <= max with
 * length <= options.strLength.max and >= options.strLength.min.
 *
 * Note: If min or max length < options.strLength.min, min and max
 * are padded to the minimum length using options.strCharset[0].
 * Likewise, if min or max length > options.strLength.max, min
 * and max are truncated to options.strLength.max.
 *
 * @param `prng` pseudo-random number generator
 * @param `min` minimum value allowed (inclusive)
 * @param `max` maximum value allowed (inclusive)
 * @param `options` argument option set
 * @returns random string >= min and <= max
 *
 * Throws an exception if min and max are not strings
 *
 * TODO: Min and max may cause a non-uniform distribution of inputs.
 */
const getRandomString: PrivateRandFn = (
  prng: seedrandom.prng,
  min: ArgValueType,
  max: ArgValueType,
  options: ArgOptions
): string => {
  if (typeof min !== "string" || typeof max !== "string")
    throw new Error("Min and max must be strings");

  const charSet = Array.from(options.strCharset);
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
  const outChars: string[] = [];
  for (let i = 0; i < strLen; i++) {
    outChars.push(charSet[getRandomNumber(prng, 0, charSetLen, intOptions)]);
  }

  return outChars.join("");
}; // fn: getRandomString

const getRandomBytes: PrivateRandFn = (
  prng: seedrandom.prng,
  _min: ArgValueType,
  _max: ArgValueType,
  options: ArgOptions
): Uint8Array => {
  const intOptions = ArgDef.getDefaultOptions();
  const bytesLen = getRandomNumber(
    prng,
    options.byteLength.min,
    options.byteLength.max,
    intOptions
  );
  const outBytes = new Uint8Array(bytesLen);
  for (let i = 0; i < bytesLen; i++) {
    outBytes[i] = getRandomNumber(prng, 0, 255, intOptions);
  }
  return outBytes;
}; // fn: getRandomBytes

/**
 * Adapted from: https://stackoverflow.com/a/12588826
 *
 * Returns an n-dimensional array of random values. The dimensions
 * and length of each dimension are specified in dimLengths. The
 * genFn function produces inputs with the appropriate type and
 * range for each array element.
 *
 * @param `prng` pseudo-random number generator
 * @param `genFn` generator for array element inputs
 * @param `dimLength` array of lengths for each n-dimension
 * @param `options` argument option set
 * @param `currDepth` current depth of recursion (default: 0)
 * @returns n-dimensional array of random values
 */
const nArray = (
  prng: seedrandom.prng,
  genFn: PublicRandFn,
  dimLength: Interval<number>[],
  options: ArgOptions,
  currDepth = 0
): ArgValueType => {
  if (dimLength.length) {
    const [dim, ...rest] = dimLength; // split the array: head, tail
    const newArray: ArgValueType[] = []; // output array
    const seen =
      currDepth === 0 && options.dimsUnique ? new Set<string>() : undefined;
    const thisDim = getRandomNumber(
      prng,
      dim.min,
      dim.max,
      ArgDef.getDefaultOptions()
    );
    // Only outer elements must be unique; nested dimensions may repeat. When
    // a finite value domain is exhausted, keep the generated prefix if it
    // already satisfies the minimum dimension length, or fail if it cannot.
    elementLoop: for (let i = 0; i < thisDim; i++) {
      let attempts = 0;
      while (true) {
        // TODO: generate unique by construction when dims>0 && dimUnique
        const value = nArray(prng, genFn, rest, options, currDepth + 1);
        if (!seen) {
          newArray[i] = value;
          continue elementLoop;
        }

        const serializedValue = JSONN.stringify(value);
        if (!seen.has(serializedValue)) {
          seen.add(serializedValue);
          newArray[i] = value;
          continue elementLoop;
        }

        if (++attempts > 50) {
          if (newArray.length >= dim.min) {
            break elementLoop; // return if it satisfies the min length constraint
          }
          throw new Error(
            "Unable to generate enough unique array element. Are constraints possible to meet?"
          );
        }
      }
    }
    return newArray;
  } else {
    return genFn(); // Base case -- just an array of values
  }
}; // fn: nArray

/**
 * Recursively collects discrete, constant leaf ArgDefs from a UNION argument.
 * Returns undefined if any non-constant or non-discrete child is present.
 */
const getDiscreteConstantLeaves = (arg: ArgDef): ArgDef[] | undefined => {
  const leaves: ArgDef[] = [];
  const visited = new Set<string>();

  function collect(node: ArgDef): boolean {
    if (node.isNoInput()) return true;
    if (node.getType() === ArgTag.UNION) {
      const children = node.getChildren().filter((c) => !c.isNoInput());
      if (children.length === 0) return false;
      for (const child of children) {
        if (!collect(child)) return false;
      }
      return true;
    }
    if (node.getDim() === 0 && node.isConstant()) {
      const val = JSONN.stringify(node.getConstantValue());
      if (!visited.has(val)) {
        visited.add(val);
        leaves.push(node);
      }
      return true;
    }
    return false;
  }

  if (collect(arg) && leaves.length > 0) {
    return leaves;
  }
  return undefined;
};
