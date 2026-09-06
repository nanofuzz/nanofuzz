import * as Config from "../../Config";
import {
  ArgOptionOverride,
  ArgOptions,
  ArgTag,
  ArgType,
  Interval,
  TagToType,
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
export class ArgDef<Tag extends ArgTag = ArgTag> {
  private name: string; // name of the argument
  private offset: number; // offset of the argument in the function (0-based)
  private type: Tag; // type of the argument
  private typeRef?: string; // type reference name (if the type is a reference)
  private typeRefDims?: number; // outer dimensions attached to type reference
  private dims: number; // dimensions of the argument (e.g., number=0, number[]=1, etc)
  private optional: boolean; // whether the argument is optional
  private intervals: Interval<TagToType[Tag]>[]; // input intervals for the argument
  private options: ArgOptions; // default argument options
  private children: ArgDef[]; // child arguments (if this is an object)

  /**
   * Constructor to instantiate a new ArgDef object.
   *
   * @param name Argument name
   * @param offset Offset of the argument in the function signature (0-based)
   * @param type Type of the argument (may be inferred using ArgOptions if 'any')
   * @param options Specifies defaults to infer input intervals and any types
   * @param dims Dimensions of the value (e.g., number = 0, number[] = 1, etc.)
   * @param optional Indicates whether the argument is optional
   * @param intervals Input intervals for the argument. REQUIRED for literal types.
   * @param children Child arguments (if this is an object, unbion, or tuple)
   * @param typeRef Type reference name (if the type is a reference)
   * @param typeRefDims Outer dimensions attached to the type reference
   */
  public constructor(
    name: string,
    offset: number,
    type: Tag,
    options: ArgOptions,
    dims?: number,
    optional?: boolean,
    intervals?: Interval<TagToType[Tag]>[],
    children?: ArgDef[],
    typeRef?: string,
    typeRefDims?: number
  ) {
    this.name = name;
    this.offset = offset;
    this.type = type;
    this.dims = dims ?? 0;
    this.optional = optional ?? false;
    this.children =
      type === ArgTag.OBJECT ||
      type === ArgTag.DICTIONARY ||
      type === ArgTag.UNION ||
      type === ArgTag.TUPLE
        ? (children ?? [])
        : [];
    this.typeRef = typeRef;
    this.typeRefDims = typeRefDims;

    // Ensure the options are valid before ingesting them
    if (!ArgDef.isOptionValid(options))
      throw new Error(
        `Invalid options provided.  Check intervals and length values: ${JSON.stringify(
          options,
          null,
          2
        )}`
      );
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

    // Intervals are required for literal types !!!!!
    // if (type === ArgTag.LITERAL && (!intervals || !intervals.length)) {
    //  throw new Error(`An interval is required for the literal ArgDef type`);
    // }

    // If no interval is provided, use the type's default
    this.intervals =
      intervals === undefined ||
      intervals.length === 0 ||
      type === ArgTag.OBJECT
        ? (ArgDef.getDefaultIntervals(this.type, this.options) as Interval<
            TagToType[Tag]
          >[])
        : intervals;

    // Ensure each non-array dimension is valid
    if (
      this.intervals.filter(
        (e) =>
          e.min !== null &&
          e.min !== undefined &&
          e.max !== null &&
          e.max !== undefined &&
          e.min > e.max
      ).length
    ) {
      throw new Error(
        `Invalid interval: ${JSON.stringify(this.intervals, undefined, 2)}`
      );
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
  ): ArgDef {
    offset = offset ?? 0;

    // Ensure we have a resolved type
    if (!ref.type)
      throw new Error(
        `Internal error: unable to create ArgDef for unresolved TypeRef: ${JSON.stringify(
          ref
        )}`
      );

    let intervals: Interval<ArgType>[] | undefined = undefined;
    // An interval is mandatory for the Literal type
    if (ref.type.type === ArgTag.LITERAL) {
      intervals =
        ref.type.value !== undefined
          ? [{ min: ref.type.value, max: ref.type.value }]
          : undefined;
    } else if (ref.type.options?.numIntervals) {
      intervals = ref.type.options?.numIntervals;
    }

    // A source language may provide additional constraints for an otherwise
    // shared ArgTag. For example, Python `int` and `float` are both NUMBERs,
    // but only an int requires numInteger input generation.
    const typeOptions: ArgOptions = { ...options, ...ref.type.options };

    // Use the type reference to build the ArgDef
    return new ArgDef(
      ref.name ?? "unknown", // name
      offset, // offset
      ref.type.type, // type
      typeOptions, // options
      ref.dims + ref.type.dims, // type reference dims + concrete type dims
      ref.optional, // optional
      intervals, // intervals
      ref.type.children.map((child, i) =>
        ArgDef.fromTypeRef(child, options, i)
      ), // children
      ref.typeRefName, // type reference
      ref.dims // outer dimensions on type reference
    );
  } // fn: fromTypeRef()

  /**
   * Gets default input intervals for a given type and option set.
   *
   * @param type The type of the argument
   * @param options Default argument options
   * @returns Default input intervals based on the type and options
   */
  public static getDefaultIntervals(
    type: ArgTag,
    options: ArgOptions
  ): Interval<ArgType>[] {
    switch (type) {
      case ArgTag.NUMBER:
        return [
          {
            min: 0,
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
      case ArgTag.BYTES:
        return [{ min: new Uint8Array(0), max: new Uint8Array(0) }];
      case ArgTag.OBJECT:
      case ArgTag.DICTIONARY:
      case ArgTag.LITERAL:
      case ArgTag.UNION:
      case ArgTag.TUPLE:
        return [];
      case ArgTag.UNRESOLVED:
        throw new Error(`Unsupported type: ${type}`);
    }
  } // fn: getDefaultIntervals()

  /**
   * Sets the argument interval to be a constant value.
   *
   * @param value Constant value to set as the input
   */
  public makeConstant(value: TagToType[Tag]): void {
    this.intervals = [{ min: value, max: value }];
    if (this.type === ArgTag.STRING && typeof value === "string") {
      this.options.strLength = { min: value.length, max: value.length };
    }
    if (
      this.type === ArgTag.BYTES &&
      (value instanceof Uint8Array || Array.isArray(value))
    ) {
      this.options.byteLength = { min: value.length, max: value.length };
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
  public getType(): Tag {
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
   * Returns the outer dimensions attached to the type reference.
   *
   * @returns The outer dimensions of the type reference, if it exists; `undefined` otherwise
   */
  public getTypeRefDims(): number | undefined {
    return this.typeRefDims;
  } // fn: getTypeRefDims()

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
   * Returns whether the argument should receive input.
   *
   * Only applies to union members.
   *
   * @returns true if the argument should not receive input.
   */
  public isNoInput(): boolean {
    return this.options.isNoInput ?? false;
  } // fn: isNoInput()

  /**
   * Returns whether the argument is named.
   *
   * @returns true if the argument is named; false, otherwise.
   */
  public isNamed(): boolean {
    return this.name !== "unknown";
  } // fn: isNamed()

  /**
   * Returns the input intervals for the argument.
   *
   * @returns The input intervals of the argument
   */
  public getIntervals(): Interval<TagToType[Tag]>[] {
    return this.intervals;
  } // fn: getIntervals()

  /**
   * Sets the input intervals for the argument.
   *
   * @param intervals The input intervals to set
   *
   * Throws an exception if any interval's min>max.
   */
  public setIntervals(intervals: Interval<TagToType[Tag]>[]): void {
    if (
      intervals.some(
        (e) =>
          e.min !== null &&
          e.min !== undefined &&
          e.max !== null &&
          e.max !== undefined &&
          e.min > e.max
      )
    )
      throw new Error(
        `Invalid interval provided (max>min): ${JSON.stringify(intervals)}`
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
    ) as Interval<TagToType[Tag]>[];
    if (
      intervals.some(
        (e) =>
          e.min !== null &&
          e.min !== undefined &&
          e.max !== null &&
          e.max !== undefined &&
          e.min > e.max
      )
    )
      throw new Error(
        `Invalid interval provided (max>min): ${JSON.stringify(intervals)}`
      );
    this.intervals = intervals;
  } // fn: setDefaultIntervals()

  /**
   * Indicates whether the argument has a constant input interval.
   *
   * @returns true if the input interval represents a constant input; false otherwise
   */
  public isConstant(): boolean {
    return (
      (this.type === ArgTag.LITERAL &&
        this.intervals.length === 0) /* literal=undefined */ ||
      (this.intervals.length === 1 &&
        this.intervals[0].min === this.intervals[0].max)
    );
  } // fn: isConstant()

  /**
   * Returns the argument's constant value IF isConstant() is true.
   *
   * @returns the argument's constant input value
   *
   * Throws an exception is isConstant() is false
   */
  public getConstantValue(): TagToType[Tag] | undefined {
    if (!this.isConstant())
      throw new Error("Arg is not a constant -- check isConstant() first");
    if (
      this.type === ArgTag.STRING &&
      typeof this.intervals[0].min === "string"
    ) {
      const result = this.intervals[0].min
        .padEnd(this.options.strLength.min, this.options.strCharset[0])
        .substring(0, this.options.strLength.max);
      return result as TagToType[Tag];
    }
    if (this.type === ArgTag.LITERAL && !this.intervals.length) {
      return undefined;
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
  public setOptions(inOptions: ArgOptions | ArgOptionOverride): void {
    const options = { dimLength: this.options.dimLength, ...inOptions };

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
        this.setIntervals(options.numIntervals as Interval<TagToType[Tag]>[]);
    }

    // Merge the two option sets; incoming has precedence
    const newOptions: ArgOptions = { ...this.options, ...options };

    // Ensure this.dims-1 === dimLength.length
    while (newOptions.dimLength.length < this.dims) {
      newOptions.dimLength.push({ ...ArgDef.getDefaultOptions().dftDimLength });
    }
    newOptions.dimLength = this.dims
      ? newOptions.dimLength.slice(0, this.dims)
      : [];

    // Handle isNoInput
    if (options.isNoInput === false) {
      delete newOptions.isNoInput;
    }

    // Ensure the options are valid before ingesting them
    if (!ArgDef.isOptionValid(newOptions))
      throw new Error(
        `Invalid options provided. Check intervals and length values: ${JSON.stringify(
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
  public setStrCharSet(strcharset: string): void {
    this.options.strCharset = strcharset;
  }

  /**
   * Returns the argument's children.
   *
   * @returns the argument's children (if it is an object)
   */
  public getChildren(): ArgDef[] {
    return [...this.children];
  } // fn: getChildren()

  /**
   * Returns a flat array of all arguments, including the children
   * of arguments.  The selection is depth-first.
   *
   * @returns the argument's descendents (if it is an object)
   */
  public getChildrenFlat(): ArgDef[] {
    const ret: ArgDef[] = [];
    for (const child of this.children) {
      ret.push(child);
      ret.push(...child.getChildrenFlat());
    }
    return ret;
  } // fn: getChildrenFlat()

  /**
   * Returns the default option set.
   *
   * @returns the default option set
   */
  public static getDefaultOptions(): ArgOptions {
    return {
      // String defaults
      strCharset: Config.get("nanofuzz.argdef.strCharset", DFT_STR_CHARSET),
      strLength: {
        min: Config.get("nanofuzz.argdef.strLength.min", DFT_STR_LENGTH.min),
        max: Config.get("nanofuzz.argdef.strLength.max", DFT_STR_LENGTH.max),
      },
      strRegex: undefined,

      // Byte array defaults
      byteLength: {
        min: Config.get("nanofuzz.argdef.byteLength.min", DFT_BYTE_LENGTH.min),
        max: Config.get("nanofuzz.argdef.byteLength.max", DFT_BYTE_LENGTH.max),
      },

      // Dictionary defaults
      dictLength: {
        min: Config.get("nanofuzz.argdef.dictLength.min", DFT_DICT_LENGTH.min),
        max: Config.get("nanofuzz.argdef.dictLength.max", DFT_DICT_LENGTH.max),
      },

      // Numeric defaults
      numInteger: Config.get<boolean>("nanofuzz.argdef.numInteger", true),

      // `Any` defaults
      anyType: Config.get("nanofuzz.argdef.anyType", ArgTag.NUMBER),
      anyDims: Config.get("nanofuzz.argdef.anyDims", 0),

      // Dimensions
      dftDimLength: {
        min: Config.get(
          "nanofuzz.argdef.dftDimLength.min",
          DFT_DIMENSION_LENGTH.min
        ),
        max: Config.get(
          "nanofuzz.argdef.dftDimLength.max",
          DFT_DIMENSION_LENGTH.max
        ),
      },
      dimLength: [],
      dimsUnique: false,
    };
  } // fn: getDefaultOptions()

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
      options.byteLength.min < 0 ||
      options.byteLength.min > options.byteLength.max ||
      options.dictLength.min < 0 ||
      options.dictLength.min > options.dictLength.max ||
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
const DFT_DIMENSION_LENGTH: Interval<number> = { min: 0, max: 4 };

/**
 * Default length of dictionary entries
 */
const DFT_DICT_LENGTH: Interval<number> = { min: 0, max: 4 };

/**
 * Default characters allowed in string input
 */
const DFT_STR_CHARSET =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
const DFT_STR_LENGTH: Interval<number> = { min: 0, max: 4 };
const DFT_BYTE_LENGTH: Interval<number> = { min: 0, max: 4 };
