import { AST_NODE_TYPES } from "@typescript-eslint/typescript-estree";
import {
  Identifier,
  TSTypeAnnotation,
  TSPropertySignature,
  TypeNode,
} from "@typescript-eslint/types/dist/ast-spec";
import * as vscode from "vscode";

/**
 * The ArgDef class describes a Typescript function argument using three input sources:
 *  1. The argument's function signature --> type, dimension, optionality, offset
 *  2. ArgOptions --> input intervals, how to handle any types
 *  3. User overrides --> all values
 *
 * Argument types that are currently supported:
 * - Numbers
 * - Booleans
 * - Strings
 * - Homogeneous n-dimensional arrays of the above types
 * - Literal object types
 * - any, provided a mapping to one of the above types
 *
 * Argument types NOT currently supported (will throw an exception):
 * - Type references
 * - Tuples
 * - OR types
 * - Deconstructed types
 * - Generics
 */
export class ArgDef<T extends ArgType> {
  private name: string; // name of the argument
  private offset: number; // offset of the argument in the function (0-based)
  private type: ArgTag; // type of the argument
  private dims: number; // dimensions of the argument (e.g., number=0, number[]=1, etc)
  private optional: boolean; // whether the argument is optional
  private intervals: Interval<T>[]; // input intervals for the argument
  private options: ArgOptions; // default argument options
  private children: ArgDef<ArgType>[]; // child arguments (if this is an object)

  /**
   * Constructor to instantiate a new ArgDef object.
   *
   * @param name Argument name
   * @param offset Offset of the argument in the function signature (0-based)
   * @param type Type of the argument (may be inferred using ArgOptions if 'any')
   * @param options Specifies defaults to infer input intervals and any types
   * @param dims Dimensions of the value (e.g., number = 0, number[] = 1, etc.)
   * @param optional Indicates whether the argument is optional
   * @param intervals Input intervals for the argument
   */
  constructor(
    name: string,
    offset: number,
    type: ArgTag,
    options: ArgOptions,
    dims?: number,
    optional?: boolean,
    intervals?: Interval<T>[],
    children?: ArgDef<ArgType>[]
  ) {
    this.name = name;
    this.offset = offset;
    this.type = type;
    this.dims = dims ?? 0;
    this.optional = optional ?? false;
    this.children = type === ArgTag.OBJECT ? children ?? [] : [];

    // Ensure the options are valid before ingesting them
    if (!ArgDef.isOptionValid(options))
      throw new Error(
        `Invalid options provided.  Check intervals and length values: ${JSON.stringify(
          options,
          null,
          2
        )}`
      );

    // Ensure the input intervals, if provided, are valid
    if (intervals !== undefined && !intervals.some((e) => e.min > e.max))
      throw new Error(
        `Invalid intervals provided. Required: min <= max. ${JSON.stringify(
          options,
          null,
          2
        )}`
      );

    // Ensure we have a sensible set of options. Watch out for mutable state here.
    this.options = { ...options };

    // Fill the array dimensions w/defaults if missing or incongruent with the AST
    if (this.options.dimLength.length !== this.getDim()) {
      this.options.dimLength = new Array(this.getDim()).fill(
        this.options.dftDimLength
      );
    }

    // Ensure each array dimension interval is valid
    if (
      this.options.dimLength.filter((e) => e.min > e.max || e.min < 0).length
    ) {
      throw new Error(
        `Invalid dimension length: ${JSON.stringify(this.options.dimLength)}`
      );
    }

    // If no interval is provided, use the type's default
    this.intervals =
      intervals === undefined ||
      intervals.length === 0 ||
      type === ArgTag.OBJECT
        ? (ArgDef.getDefaultIntervals(this.type, this.options) as Interval<T>[])
        : intervals;

    // Ensure each non-array dimension is valid
    if (this.intervals.filter((e) => e.min > e.max).length) {
      throw new Error(`Invalid interval: ${JSON.stringify(this.intervals)}`);
    }
  } // end: constructor

  /**
   * Gets default input intervals for a given type and option set.
   *
   * @param type The type of the argument
   * @param options Default argument options
   * @returns Default input intervals based on the type and options
   */
  private static getDefaultIntervals(
    type: ArgTag,
    options: ArgOptions
  ): Interval<ArgType>[] {
    switch (type) {
      case ArgTag.NUMBER:
        return [
          {
            min: options.numSigned ? -100 : 0,
            max: 100,
          },
        ];
      case ArgTag.STRING:
        return [
          {
            min: "",
            max: options.strCharset[options.strCharset.length - 1].repeat(99),
          },
        ];
      case ArgTag.BOOLEAN:
        return [{ min: false, max: true }];
      case ArgTag.OBJECT:
        return [];
      default:
        throw new Error(`Unsupported type: ${type}`);
    }
  } // getDefaultIntervals()

  /**
   * Constructs an ArgDef object from a function argument's AST node.
   *
   * @param node AST node of the function argument identifier.
   * @param offset The offset of the argument in the function signature (0-based)
   * @param options Default argument options
   * @returns ArgDef object
   *
   * Throws an exception if the argument is missing a type annotation.
   */
  public static fromAstNode(
    node: Identifier | TSPropertySignature,
    offset: number,
    options: ArgOptions
  ): ArgDef<ArgType> {
    if (node.typeAnnotation !== undefined) {
      let name: string;

      if (node.type === AST_NODE_TYPES.Identifier) {
        name = node.name;
      } else {
        if (node.key.type === AST_NODE_TYPES.Identifier) {
          name = node.key.name;
        } else {
          throw new Error("Unsupported key type: " + node.key.type);
        }
      }

      // Get the node's type and dimensions
      const [type, dims] = ArgDef.getTypeFromNode(node.typeAnnotation, options);

      // Create the argument definition
      switch (type) {
        case ArgTag.STRING:
          return new ArgDef<string>(
            name,
            offset,
            type,
            options,
            dims,
            node.optional
          );
        case ArgTag.BOOLEAN:
          return new ArgDef<boolean>(
            name,
            offset,
            type,
            options,
            dims,
            node.optional
          );
        case ArgTag.NUMBER:
          return new ArgDef<number>(
            name,
            offset,
            type,
            options,
            dims,
            node.optional
          );
        case ArgTag.OBJECT:
          return new ArgDef<Record<string, unknown>>(
            name,
            offset,
            type,
            options,
            dims,
            node.optional,
            undefined,
            ArgDef.getChildrenFromNode(node.typeAnnotation, options)
          );
      }
    } else {
      throw new Error(
        "Missing type annotation (already transpiled to JS?): " +
          JSON.stringify(node)
      );
    }
  } // fromAstNode()

  /**
   * Accepts a function argument's type annotation AST node and returns a tuple
   * of the argument type and dimensions.
   *
   * @param node AST node of the function argument's type annotation.
   * @param options Default argument options
   * @returns A tuple containing the type and dimensions of the argument
   *
   * Throws an exception of the argument type is unsupported
   */
  private static getTypeFromNode(
    node: TSTypeAnnotation | TypeNode,
    options: ArgOptions
  ): [ArgTag, number] {
    switch (node.type) {
      case AST_NODE_TYPES.TSAnyKeyword:
        return [options.anyType, options.anyDims];
      case AST_NODE_TYPES.TSStringKeyword:
        return [ArgTag.STRING, 0];
      case AST_NODE_TYPES.TSBooleanKeyword:
        return [ArgTag.BOOLEAN, 0];
      case AST_NODE_TYPES.TSNumberKeyword:
        return [ArgTag.NUMBER, 0];
      case AST_NODE_TYPES.TSTypeAnnotation:
        return ArgDef.getTypeFromNode(node.typeAnnotation, options);
      case AST_NODE_TYPES.TSTypeLiteral:
        return [ArgTag.OBJECT, 0];
      case AST_NODE_TYPES.TSArrayType: {
        const [type, dims] = ArgDef.getTypeFromNode(node.elementType, options);
        return [type, dims + 1];
      }
      default:
        throw new Error(
          "Unsupported type annotation: " + JSON.stringify(node, null, 2)
        );
    }
  } // getTypeFromNode()

  /**
   * Getts the children of an object using its argument node as input.
   *
   * @param node argument's type annotation AST node
   * @param options Default argument options
   * @returns array of ArgDef objects representing the argument's children
   */
  private static getChildrenFromNode(
    node: TSTypeAnnotation,
    options: ArgOptions
  ): ArgDef<ArgType>[] {
    // Collapse array annotations -- we previously handled those
    while (node.typeAnnotation.type === AST_NODE_TYPES.TSArrayType)
      node.typeAnnotation = node.typeAnnotation.elementType;

    switch (node.typeAnnotation.type) {
      case AST_NODE_TYPES.TSTypeLiteral: {
        let i = 0;
        return node.typeAnnotation.members.map((member) => {
          if (member.type === AST_NODE_TYPES.TSPropertySignature)
            return ArgDef.fromAstNode(member, i++, options);
          else
            throw new Error(
              "Unsupported object property type annotation: " +
                JSON.stringify(member, null, 2)
            );
        });
      }
      default:
        throw new Error(
          "Unsupported object type annotation: " + JSON.stringify(node, null, 2)
        );
    }
  } // getChildrenFromNode()

  /**
   * Sets the argument interval to be a constant value.
   *
   * @param value Constant value to set as the input
   */
  public makeConstant(value: T): void {
    this.intervals = [{ min: value, max: value }];
    if (this.type === ArgTag.STRING && typeof value === "string") {
      this.options.strLength = { min: value.length, max: value.length };
    }
  }

  /**
   * Returns the name of the argument.
   *
   * @returns The name of the argument
   */
  public getName(): string {
    return this.name;
  }

  /**
   * Returns the offset of the argument in the function signature
   *
   * @returns The offset of the argument in the function signature (0-based)
   */
  public getOffset(): number {
    return this.offset;
  }

  /**
   * Returns the type of the argument.
   *
   * @returns The type of the argument
   */
  public getType(): ArgTag {
    return this.type;
  }

  /**
   * Returns the dimensions of the argument.
   *
   * @returns The dimensions of the argument (e.g., number = 0, number[] = 1, etc)
   */
  public getDim(): number {
    return this.dims;
  }

  /**
   * Returns whether the argument is optional.
   *
   * @returns true if the argument is optional; false otherwise
   */
  public isOptional(): boolean {
    return this.optional;
  }

  /**
   * Returns the input intervals for the argument.
   *
   * @returns The input intervals of the argument
   */
  public getIntervals(): Interval<T>[] {
    return this.intervals;
  }

  /**
   * Sets the input intervals for the argument.
   *
   * @param intervals The input intervals to set
   *
   * Throws an exception if any interval's min>max.
   */
  public setIntervals(intervals: Interval<T>[]): void {
    if (intervals.some((e) => e.min > e.max))
      throw new Error(
        `Invalid interval provided (max>min): ${JSON.stringify(intervals)}`
      );
    this.intervals = intervals;
  }

  /**
   * Indicates whether the argument has a constant input interval.
   *
   * @returns true if the input interval represents a constant input; false otherwise
   */
  public isConstant(): boolean {
    return (
      this.intervals.length === 1 &&
      this.intervals[0].min === this.intervals[0].max
    );
  }

  /**
   * Returns the argument's constant value IF isConstant() is true.
   *
   * @returns the argument's constant input value
   *
   * Throws an exception is isConstant() is false
   */
  public getConstantValue(): T {
    if (!this.isConstant())
      throw new Error("Arg is not a constant -- check isConstant() first");
    if (
      this.type === ArgTag.STRING &&
      typeof this.intervals[0].min === "string"
    ) {
      const result = this.intervals[0].min
        .padEnd(this.options.strLength.min, this.options.strCharset[0])
        .substring(0, this.options.strLength.max);
      return result as T;
    }
    return this.intervals[0].min;
  }

  /**
   * Returns the argument's option set.
   *
   * @returns the argument's option set
   */
  public getOptions(): ArgOptions {
    return { ...this.options };
  }

  /**
   * Sets the argument's option set.
   *
   * @param options the argument's option set
   */
  public setOptions(options: ArgOptions | ArgOptionOverride): void {
    // Cascade child options to child arguments
    if ("children" in options) {
      for (const child in options.children) {
        const childArg = this.children.find((e) => e.getName() === child);
        if (childArg !== undefined) {
          childArg.setOptions(options.children[child]);
        } else {
          throw new Error(`Child argument ${child} not found in ${this.name}`);
        }
      }
      delete options.children;
    }

    // Handle numMin and numMax overrides
    if (this.type === ArgTag.NUMBER) {
      if ("numIntervals" in options && options.numIntervals !== undefined)
        this.setIntervals(options.numIntervals as Interval<T>[]);
    }

    // Merge the two option sets; incoming has precedence
    const newOptions = { ...this.options, ...options };
    delete newOptions["children"], newOptions["numMin"], newOptions["numMax"];

    // Ensure the options are valid before ingesting them
    if (!ArgDef.isOptionValid(newOptions))
      throw new Error(
        `Invalid options provided.  Check intervals and length values: ${JSON.stringify(
          newOptions,
          null,
          2
        )}`
      );
    this.options = newOptions;
  }

  /**
   * Returns the argument's children.
   *
   * @returns the argument's children (if it is an object)
   */
  public getChildren(): ArgDef<ArgType>[] {
    return [...this.children];
  }

  /**
   * Returns a flat array of all arguments, including the children
   * of arguments.  The selection is depth-first.
   *
   * @returns the argument's descendents (if it is an object)
   */
  public getChildrenFlat(): ArgDef<ArgType>[] {
    const ret: ArgDef<ArgType>[] = [];
    for (const child of this.children) {
      ret.push(child);
      ret.push(...child.getChildrenFlat());
    }
    return ret;
  }

  /**
   * Returns the default option set for signed integer values.
   *
   * @returns the default option set for signed integer values
   */
  public static getDefaultOptions(): ArgOptions {
    return {
      // String defaults
      strCharset: vscode.workspace
        .getConfiguration("nanofuzz.argdef")
        .get("strCharset", DFT_STR_CHARSET),
      strLength: {
        min: vscode.workspace
          .getConfiguration("nanofuzz.argdef.strLength")
          .get("min", DFT_STR_LENGTH.min),
        max: vscode.workspace
          .getConfiguration("nanofuzz.argdef.strLength")
          .get("max", DFT_STR_LENGTH.max),
      },

      // Numeric defaults
      numInteger: vscode.workspace
        .getConfiguration("nanofuzz.argdef")
        .get("numInteger", true),
      numSigned: vscode.workspace
        .getConfiguration("nanofuzz.argdef")
        .get("numSigned", false),

      // `Any` defaults
      anyType: vscode.workspace
        .getConfiguration("nanofuzz.argdef")
        .get("anyType", ArgTag.NUMBER),
      anyDims: vscode.workspace
        .getConfiguration("nanofuzz.argdef")
        .get("anyDims", 0),

      // Dimensions
      dftDimLength: {
        min: vscode.workspace
          .getConfiguration("nanofuzz.argdef.dftDimLength")
          .get("min", DFT_DIMENSION_LENGTH.min),
        max: vscode.workspace
          .getConfiguration("nanofuzz.argdef.dftDimLength")
          .get("max", DFT_DIMENSION_LENGTH.max),
      },
      dimLength: [],
    };
  }

  /**
   * Returns the default option set for signed float values.
   *
   * @returns the default option set for signed float values
   */
  public static getDefaultFloatOptions(): ArgOptions {
    return {
      ...ArgDef.getDefaultOptions(),
      numInteger: false,
    };
  }

  /**
   * Accepts an option set and returns true if it is valid; false otherwise.
   *
   * @param options an option set to validate
   * @returns true if the option set is valid; false otherwise
   */
  public static isOptionValid(options: ArgOptions): boolean {
    return !(
      options.strCharset.length === 0 ||
      options.strLength.min < 0 ||
      options.strLength.min > options.strLength.max ||
      options.anyDims < 0 ||
      options.dimLength.some((dim) => dim.min < 0 || dim.min > dim.max) ||
      options.dftDimLength.min < 0 ||
      options.dftDimLength.min > options.dftDimLength.max
    );
  } // fn: isOptionValid
} // class: ArgDef

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
 * Default length of array dimensions
 */
const DFT_DIMENSION_LENGTH: Interval<number> = { min: 0, max: 10 };

/**
 * Default characters allowed in string input
 */
const DFT_STR_CHARSET =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
const DFT_STR_LENGTH: Interval<number> = { min: 0, max: 10 };

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
