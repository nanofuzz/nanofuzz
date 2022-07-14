import {
  AST_NODE_TYPES,
  parse,
  simpleTraverse,
} from "@typescript-eslint/typescript-estree";
import {
  Identifier,
  TSTypeAnnotation,
  TypeNode,
} from "@typescript-eslint/types/dist/ast-spec";

/**
 * Currently supported:
 * - Numbers
 * - Booleans
 * - Strings
 * - Homogeneous n-dimensional arrays of the above types
 * - any, provided a mapping to one of the above types
 *
 * Not currently supported (will throw an exception):
 * - Type references
 * - Tuples
 * - OR types
 * - Non-primitive types
 * - Deconstructed types
 * - Objects
 * - Generics
 *
 * Other Limitations:
 * - Analyzes type-annotated TypeScript code, not untyped JS
 * - Anonymous functions are not supported
 * - Analysis of class methods is not supported
 */

// !!! Requires TS function - NOT JS function because they lack type information
// !!! Does not handle class methods
export const getTsFnArgs = (
  src: string,
  options: ArgOptions
): ArgDef<ArgType>[] => {
  const args: ArgDef<ArgType>[] = [];
  const ast = parse(src, { range: true }); // Parse the source

  // Retrieve the function arguments
  const fnDecl = ast.body[0];
  if (
    fnDecl.type === AST_NODE_TYPES.VariableDeclaration ||
    fnDecl.type === AST_NODE_TYPES.FunctionDeclaration
  ) {
    const fnInit =
      "declarations" in fnDecl ? fnDecl.declarations[0].init : fnDecl;
    if (
      fnInit !== null &&
      (fnInit.type === AST_NODE_TYPES.FunctionExpression ||
        fnInit.type === AST_NODE_TYPES.FunctionDeclaration ||
        fnInit.type === AST_NODE_TYPES.ArrowFunctionExpression)
    ) {
      for (const i in fnInit.params) {
        const thisArg = fnInit.params[i];
        if (thisArg.type === AST_NODE_TYPES.Identifier) {
          args.push(ArgDef.fromAstNode(thisArg, parseInt(i), options));
        } else {
          throw new Error(`Unsupported argument type: ${thisArg.type}`);
        }
      }
      return args;
    }
  }
  throw new Error(`Unsupported function declaration`);
};

// !!!
export const findFnInSource = (
  src: string,
  fnName?: string,
  offset?: number
): [string, string][] => {
  const ret: [string, string][] = [];
  const ast = parse(src, { range: true }); // Parse the source

  // Traverse the AST to find function definitions
  simpleTraverse(ast, {
    enter: (node, parent) => {
      // Need to look for these situations:
      // - Variable declarations that name an arrow function
      // - Traditional function declarations
      // - TODO: Class methods
      if (
        // Arrow Function Definition: const xyz = (): void => { ... }
        node.type === AST_NODE_TYPES.VariableDeclarator &&
        parent !== undefined &&
        parent.type === AST_NODE_TYPES.VariableDeclaration &&
        node.init &&
        node.init.type === AST_NODE_TYPES.ArrowFunctionExpression &&
        node.id.type === AST_NODE_TYPES.Identifier &&
        (!fnName || node.id.name === fnName) &&
        (!offset || (node.range[0] <= offset && node.range[1] >= offset))
      ) {
        ret.push([
          node.id.name,
          parent.kind + " " + src.substring(node.range[0], node.range[1]),
        ]);
      } else if (
        // Standard Function Definition: function xyz(): void => { ... }
        node.type === AST_NODE_TYPES.FunctionDeclaration &&
        node.id !== null &&
        (!fnName || node.id.name === fnName) &&
        (!offset || (node.range[0] <= offset && node.range[1] >= offset))
      ) {
        ret.push([node.id.name, src.substring(node.range[0], node.range[1])]);
      }
    }, // enter
  }); // traverse AST

  // TODO: If pos is provided w/multiple matches, sort by offset delta !!!

  return ret;
};

// !!! Need to support:
//  - object types (currently not doing that)
//  - Can't currently set a constant for array!
//  - Better i18n w/strings: Intl.Collator
// !!!
export class ArgDef<T extends ArgType> {
  // !!! Do we want to ref the fn also?
  private name: string;
  private offset: number; // offset of the argument in the function (0-based)
  private type: ArgTag;
  private dims: number;
  private optional: boolean;
  private intervals: Interval<T>[];
  private options: ArgOptions;

  // !!!
  public constructor(
    name: string,
    offset: number,
    type: ArgTag,
    dims?: number,
    optional?: boolean,
    intervals?: Interval<T>[],
    options?: ArgOptions
  ) {
    this.name = name;
    this.offset = offset;
    this.type = type;
    this.dims = dims ?? 0;
    this.optional = optional ?? false;

    // Ensure we have a sensible set of options
    this.options = options ?? ArgDef.getDefaultOptions();

    // Fill the array dimensions w/defaults if missing or incongruent with the AST
    if (this.options.dimLength.length !== this.getDim()) {
      this.options.dimLength = Array(this.getDim()).fill(
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
      intervals === undefined || intervals.length === 0
        ? (this.getDefaultIntervals(this.type, this.options) as Interval<T>[])
        : intervals;

    // Ensure each non-array dimension is valid
    if (this.intervals.filter((e) => e.min > e.max).length) {
      throw new Error(`Invalid interval: ${JSON.stringify(this.intervals)}`);
    }
  }

  // !!!
  private getDefaultIntervals(
    type: ArgTag,
    options: ArgOptions
  ): Interval<ArgType>[] {
    switch (type) {
      case ArgTag.NUMBER:
        return [
          {
            min: options.numNegative ? -100 : 0,
            max: 100,
          },
        ];
      case ArgTag.STRING:
        return [
          {
            min: "",
            max: "~".repeat(99), // TODO: Should be based on options.charset !!!
          },
        ];
      case ArgTag.BOOLEAN:
        return [{ min: false, max: true }];
      case ArgTag.OBJECT:
        throw new Error("Unsupported type: OBJECT"); // !!!
      default:
        throw new Error(`Unsupported type: ${type}`);
    }
  }

  // !!!
  public static fromAstNode(
    node: Identifier,
    offset: number,
    options: ArgOptions
  ): ArgDef<ArgType> {
    if (node.typeAnnotation !== undefined) {
      const [type, dims] = ArgDef.getTypeFromNode(node.typeAnnotation, options);
      switch (type) {
        case ArgTag.STRING:
          return new ArgDef<string>(
            node.name,
            offset,
            type,
            dims,
            node.optional,
            undefined,
            options
          );
        case ArgTag.BOOLEAN:
          return new ArgDef<boolean>(
            node.name,
            offset,
            type,
            dims,
            node.optional,
            undefined,
            options
          );
        case ArgTag.NUMBER:
          return new ArgDef<number>(
            node.name,
            offset,
            type,
            dims,
            node.optional,
            undefined,
            options
          );
        case ArgTag.OBJECT:
          return new ArgDef<Record<string, unknown>>(
            node.name,
            offset,
            type,
            dims,
            node.optional,
            undefined,
            options
          );
      }
    } else {
      throw new Error(
        "Missing type annotation (already transpiled to JS?): " +
          JSON.stringify(node)
      );
    }
  }

  // !!!
  private static getTypeFromNode(
    node: TSTypeAnnotation | TypeNode,
    options: ArgOptions
  ): [ArgTag, number] {
    switch (node.type) {
      case AST_NODE_TYPES.TSAnyKeyword:
        return [options.anyType, 0];
      case AST_NODE_TYPES.TSStringKeyword:
        return [ArgTag.STRING, 0];
      case AST_NODE_TYPES.TSBooleanKeyword:
        return [ArgTag.BOOLEAN, 0];
      case AST_NODE_TYPES.TSNumberKeyword:
        return [ArgTag.NUMBER, 0];
      case AST_NODE_TYPES.TSTypeAnnotation:
        return ArgDef.getTypeFromNode(node.typeAnnotation, options);
      case AST_NODE_TYPES.TSArrayType: {
        const [type, dims] = ArgDef.getTypeFromNode(node.elementType, options);
        return [type, dims + 1];
      }
      default:
        throw new Error("Unsupported type annotation: " + JSON.stringify(node));
    }
  }

  // !!!
  public makeConstant(value: T): void {
    this.intervals = [{ min: value, max: value }];
  }
  // !!!
  public getName(): string {
    return this.name;
  }
  // !!!
  public getOffset(): number {
    return this.offset;
  }
  // !!!
  public getType(): ArgTag {
    return this.type;
  }
  // !!!
  public getDim(): number {
    return this.dims;
  }
  // !!!
  public isOptional(): boolean {
    return this.optional;
  }
  // !!!
  public getIntervals(): Interval<T>[] {
    return this.intervals;
  }
  // !!!
  public isConstant(): boolean {
    return (
      this.intervals.length === 1 &&
      this.intervals[0].min === this.intervals[0].max
    );
  }
  // !!!
  public getConstantValue(): T {
    if (!this.isConstant())
      throw new Error("Arg is not a constant -- check isConstant() first");
    return this.intervals[0].min;
  }
  // !!!
  public isRestrictedDomain(): boolean {
    return this.intervals.length > 0;
  }
  // !!!
  public getOptions(): ArgOptions {
    return { ...this.options };
  }
  // !!!
  public static getDefaultOptions(): ArgOptions {
    return {
      strCharset: DFT_STR_CHARSET,
      strLength: DFT_STR_LENGTH,

      numInteger: true,
      numNegative: false,

      anyType: ArgTag.NUMBER,
      anyDims: 0,

      dftDimLength: DFT_ARRAY_DIM,
      dimLength: [],
    };
  }
  // !!!
  public static getDefaultFloatOptions(): ArgOptions {
    return {
      ...ArgDef.getDefaultOptions(),
      numInteger: false,
    };
  }
}

// !!!
export type ArgOptions = {
  // For type string
  strCharset: string; // !!!
  strLength: Interval<number>; // !!!

  // For type number
  numInteger: boolean; // !!!
  numNegative: boolean; // !!!

  // For type any
  anyType: ArgTag; // !!!
  anyDims: number; // !!!

  // For args with dimensions
  dimLength: Interval<number>[]; // !!!
  dftDimLength: Interval<number>; // !!!
};

// !!!
const DFT_ARRAY_DIM: Interval<number> = { min: 0, max: 10 };
const DFT_STR_CHARSET =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
const DFT_STR_LENGTH: Interval<number> = { min: 0, max: 10 };

// !!!
export enum ArgTag {
  NUMBER = "number",
  STRING = "string",
  BOOLEAN = "boolean",
  OBJECT = "object",
}
export type ArgType = number | string | boolean | Record<string, unknown>;

// !!!
// TODO: Add support for open intervals
export type Interval<T> = {
  min: T;
  max: T;
};
