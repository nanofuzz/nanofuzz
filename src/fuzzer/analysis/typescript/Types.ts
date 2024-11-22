/**
 * Represents a single import declaration within a TypeScript program
 */
export type ProgramImport = {
  local: IdentifierName; // local name of the import inside the current module
  imported: IdentifierName; // name of the import in the module being imported
  programPath: ProgramPath; // path to the module being imported
  resolved: boolean; // true if the import has been resolved; false, otherwise
  default: boolean; // true if the import is the default import; false, otherwise
};

/**
 * Represents a set of imports for a program
 */
export type ProgramImports = {
  programs: Record<ProgramPath, string>;
  identifiers: Record<IdentifierName, ProgramImport>;
};

/**
 * Represents a path to a program module file
 */
export type ProgramPath = string;

/**
 * Represents an identifier within a program
 */
export type IdentifierName = string;

/**
 * Represents a reference to a function in a source code file.
 */
export type FunctionRef = {
  module: ProgramPath; // Module where the function resides
  name: IdentifierName; // Name of the function
  src: string; // Function source code
  startOffset: number; // Starting offset of the function in the source file
  endOffset: number; // Ending offset of the function in the source file
  isExported: boolean; // True if the function is exported; false, otherwise
  args?: TypeRef[]; // Array of argument types
  returnType?: TypeRef; // Return type of the function
};

/**
 * Represents a type in a source code file.
 */
export type TypeRef = {
  module: ProgramPath; // Module where the type resides
  name?: IdentifierName; // Name of the type
  typeRefName?: IdentifierName; // Name of the type reference (if any)
  optional: boolean; // True if the type is optional; false, otherwise
  dims: number; // Number of dimensions for the type (0 for non-array types)
  type?: {
    type: ArgTag; // Concrete type of the type
    children: TypeRef[]; // Array of child types
    resolved?: boolean; // True if the type's children have been resolved; false, otherwise
  };
  isExported: boolean; // True if the type is exported; false, otherwise
};

/**
 * Indicates the primitive type of an argument
 */
export enum ArgTag {
  NUMBER = "number",
  STRING = "string",
  BOOLEAN = "boolean",
  OBJECT = "object",
  UNRESOLVED = "unresolved", // unresolved type reference
}
export type ArgType = number | string | boolean | Record<string, unknown>;

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
 * Represents a single closed interval of values for an argument.
 * TODO: Add support for open intervals
 */
export type Interval<T> = {
  min: T;
  max: T;
};
