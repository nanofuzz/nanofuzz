import * as JSON5 from "json5";
import * as vscode from "vscode";
import {
  ArgOptionOverride,
  ArgOptions,
  ArgTag,
  ArgType,
  Interval,
  TypeRef,
} from "./Types";

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
 * - Top-level type references that meet the above criteria
 * - any, provided a mapping to one of the above types
 *
 * Argument types NOT currently supported (will throw an exception):
 * - Tuples
 * - OR types
 * - Deconstructed types
 * - Generics
 */
export class ArgDef<T extends ArgType> {
  private name: string; // name of the argument
  private offset: number; // offset of the argument in the function (0-based)
  private type: ArgTag; // type of the argument
  private typeRef?: string; // type reference name (if the type is a reference)
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
  private constructor(
    name: string,
    offset: number,
    type: ArgTag,
    options: ArgOptions,
    dims?: number,
    optional?: boolean,
    intervals?: Interval<T>[],
    children?: ArgDef<ArgType>[],
    typeRef?: string
  ) {
    this.name = name;
    this.offset = offset;
    this.type = type;
    this.dims = dims ?? 0;
    this.optional = optional ?? false;
    this.children = type === ArgTag.OBJECT ? children ?? [] : [];
    this.typeRef = typeRef;

    // Ensure the options are valid before ingesting them
    if (!ArgDef.isOptionValid(options))
      throw new Error(
        `Invalid options provided.  Check intervals and length values: ${JSON5.stringify(
          options,
          null,
          2
        )}`
      );

    // Ensure the input intervals, if provided, are valid
    if (intervals !== undefined && !intervals.some((e) => e.min > e.max))
      throw new Error(
        `Invalid intervals provided. Required: min <= max. ${JSON5.stringify(
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
        `Invalid dimension length: ${JSON5.stringify(this.options.dimLength)}`
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
      throw new Error(`Invalid interval: ${JSON5.stringify(this.intervals)}`);
    }
  } // end: constructor

  /**
   * Creates an ArgDef object from a given TypeRef object that includes addition details
   * such as the argument name, offset, ranges, and option set.
   *
   * @param ref TypeRef object
   * @param options Argument options
   * @param offset Position of ArgDef object
   * @returns ArgDef object for the given TypeRef and ArgOptions
   */
  public static fromTypeRef(
    ref: TypeRef,
    options: ArgOptions,
    offset?: number
  ): ArgDef<ArgType> {
    offset = offset ?? 0;
    let i = 0; // Child counter

    // Ensure we have a resolved type
    if (!ref.type)
      throw new Error(
        `Internal error: Creating ArgDef for unresolved TypeRef: ${JSON5.stringify(
          ref
        )}`
      );

    // Use the type reference to build the ArgDef
    return new ArgDef<ArgType>(
      ref.name ?? "unknown", // name
      offset, // offset
      ref.type.type, // type
      options, // options
      ref.dims, // dims
      ref.optional, // optional
      undefined, // intervals
      ref.type.children.map((child) => ArgDef.fromTypeRef(child, options, i++)), // children
      ref.typeRefName // type reference
    );
  } // fn: fromTypeRef()

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
  } // fn: getDefaultIntervals()

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
    this.dims = 0;
  } // fn: makeConstant()

  /**
   * Returns the name of the argument.
   *
   * @returns The name of the argument
   */
  public getName(): string {
    return this.name;
  } // fn: getName()

  /**
   * Returns the offset of the argument in the function signature
   *
   * @returns The offset of the argument in the function signature (0-based)
   */
  public getOffset(): number {
    return this.offset;
  } // fn: getOffset()

  /**
   * Returns the type of the argument.
   *
   * @returns The type of the argument
   */
  public getType(): ArgTag {
    return this.type;
  } // fn: getType()

  /**
   * Returns the reference type of the argument (if it exists).
   *
   * @returns The type of the argument
   */
  public getTypeRef(): string | undefined {
    return this.typeRef;
  } // fn: getTypeRef()

  /**
   * Returns the dimensions of the argument.
   *
   * @returns The dimensions of the argument (e.g., number = 0, number[] = 1, etc)
   */
  public getDim(): number {
    return this.dims;
  } // fn: getDim()

  /**
   * Returns whether the argument is optional.
   *
   * @returns true if the argument is optional; false otherwise
   */
  public isOptional(): boolean {
    return this.optional;
  } // fn: isOptional()

  /**
   * Returns the input intervals for the argument.
   *
   * @returns The input intervals of the argument
   */
  public getIntervals(): Interval<T>[] {
    return this.intervals;
  } // fn: getIntervals()

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
        `Invalid interval provided (max>min): ${JSON5.stringify(intervals)}`
      );
    this.intervals = intervals;
  } // fn: setIntervals()

  /**
   * Sets the input intervals for the argument.
   *
   * @param intervals The input intervals to set
   *
   * Throws an exception if any interval's min>max.
   */
  public setDefaultIntervals(options: ArgOptions): void {
    const intervals = ArgDef.getDefaultIntervals(
      this.type,
      options
    ) as Interval<T>[];
    if (intervals.some((e) => e.min > e.max))
      throw new Error(
        `Invalid interval provided (max>min): ${JSON5.stringify(intervals)}`
      );
    this.intervals = intervals;
  } // fn: setIntervals()

  /**
   * Indicates whether the argument has a constant input interval.
   *
   * @returns true if the input interval represents a constant input; false otherwise
   */
  public isConstant(): boolean {
    return (
      this.intervals.length === 1 &&
      this.intervals[0].min === this.intervals[0].max &&
      this.getDim() === 0
    );
  } // fn: isConstant()

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
  } // fn: getConstantValue()

  /**
   * Returns the argument's option set.
   *
   * @returns the argument's option set
   */
  public getOptions(): ArgOptions {
    return { ...this.options };
  } // fn: getOptions()

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
        `Invalid options provided. Check intervals and length values: ${JSON5.stringify(
          newOptions,
          null,
          2
        )}`
      );
    this.options = newOptions;
  } // fn: setOptions()

  /**
   * Sets the argument's strcharset (alphabet of chars for strings).
   * @param strcharset
   */
  public setStrCharSet(strcharset: string) {
    this.options.strCharset = strcharset;
  }

  /**
   * Returns the argument's children.
   *
   * @returns the argument's children (if it is an object)
   */
  public getChildren(): ArgDef<ArgType>[] {
    return [...this.children];
  } // fn: getChildren()

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
  } // fn: getChildrenFlat()

  /**
   * Returns the base type of this ArgDef, i.e., its type without any
   * dimensions or optionality.
   */
  private getBaseType(): string {
    if (this.typeRef) {
      return this.typeRef;
    }

    if (this.type === "object") {
      // Probably an inline type given the lack of a typeRef, recursively walk
      // the children to build the type.
      const childTypeAnnotations = this.children.map(
        (child) => `${child.getName()}: ${child.getTypeAnnotation()}`
      );
      return `{ ${childTypeAnnotations.join("; ")} }`;
    }

    return this.type;
  }

  /**
   * Returns a string that works as the type annotation for the argument.
   * @returns a string that works as the type annotation for the argument
   */
  public getTypeAnnotation(): string {
    const baseType = this.getBaseType();
    const type = `${baseType}${this.dims ? "[]".repeat(this.dims) : ""}`;

    if (this.optional) {
      return `${type} | undefined`;
    }

    return type;
  } // fn: getTypeAnnotation()

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
  } // fn: getDefaultOptions()

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
  } // fn: getDefaultFloatOptions()

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
 * Default length of array dimensions
 */
const DFT_DIMENSION_LENGTH: Interval<number> = { min: 0, max: 10 };

/**
 * Default characters allowed in string input
 */
const DFT_STR_CHARSET =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
const DFT_STR_LENGTH: Interval<number> = { min: 0, max: 10 };
