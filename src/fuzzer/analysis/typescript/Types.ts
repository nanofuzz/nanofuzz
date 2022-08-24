/**
 * Represents a reference to a function in a source code file.
 */
export type FunctionRef = {
  module: URL;
  name: string;
  src: string;
  startOffset: number;
  endOffset: number;
};

// !!!
export type FunctionRefWeak = Optional<
  FunctionRef,
  "endOffset" | "name" | "startOffset" | "src"
>;

// !!! https://stackoverflow.com/a/61108377
export type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

/**
 * The set of options for an argument.  This option set is used to "fill in" information
 * that is not provided by analyzing the function.  For instance, a function signature
 * may indicate an argument is numeric, but not whether it is a float or an integer.
 */
export type ArgOptions = {
  // For type string
  strCharset: string; // string representing the characters allowed in the input
  strLength: Interval<number>; // length of characters allowed in the input

  // For type number
  numInteger: boolean; // true if the numeric argument input is an integer
  numSigned: boolean; // true if the numeric argument input is signed

  // For type any
  anyType: ArgTag; // the type to interpret for 'any' types
  anyDims: number; // the dimensions to interpret for 'any' types

  // For args with dimensions (when ArgDef.getDims() > 0)
  dimLength: Interval<number>[]; // Fine-grained length of each dimension.  For example,
  // for number[][]: dimLength[0] = length of 1st dimension
  // and dimLength[1] = length of 2nd dimension.
  dftDimLength: Interval<number>; // Length of any dimension not specified in dimLength.
};

/**
 * A set of option overrides for a set of arguments.
 */
export type ArgOptionOverrides = {
  [k: string]: ArgOptionOverride;
};

/**
 * Argument option overrides
 */
export type ArgOptionOverride = {
  numInteger?: boolean;
  numSigned?: boolean;
  numIntervals?: Interval<number>[];
  dimLength?: Interval<number>[];
  strLength?: Interval<number>;
  strCharset?: string;
  children?: ArgOptionOverrides;
};

/**
 * Indicates the primitive type of an argument
 */
export enum ArgTag {
  NUMBER = "number",
  STRING = "string",
  BOOLEAN = "boolean",
  OBJECT = "object",
}
export type ArgType = number | string | boolean | Record<string, unknown>;

/**
 * Represents a single closed interval of values for an argument.
 * TODO: Add support for open intervals
 */
export type Interval<T> = {
  min: T;
  max: T;
};
