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
 * - Homogeneous arrays of the above of any dimension
 *
 * !!! Not currently supported:
 * - OR types
 * - Non-primitive types
 * - Deconstructed types
 * - Objects
 * - Generics
 *
 * Function has to be named
 */

// !!! Requires TS function - NOT JS function because they lack type information
// !!! Does not handle class methods
export const getTsFnArgs = (src: string): ArgDef<ArgType>[] => {
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
          args.push(ArgDef.fromAstNode(thisArg, parseInt(i)));
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

  // Traverse the AST to find property accesses
  simpleTraverse(ast, {
    enter: (node, parent) => {
      // Need to check for these situations:
      // - Variable declarations that name an arrow function
      // - Traditional function declarations
      // - Class methods --> Not supported right now !!!

      // Arrow Function Definition: const xyz = (): void => { ... }
      if (
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

        // Standard Function Definition: function xyz(): void => { ... }
      } else if (
        node.type === AST_NODE_TYPES.FunctionDeclaration &&
        node.id !== null &&
        (!fnName || node.id.name === fnName) &&
        (!offset || (node.range[0] <= offset && node.range[1] >= offset))
      ) {
        ret.push([node.id.name, src.substring(node.range[0], node.range[1])]);
      }
    }, // enter
  }); // traverse AST

  // !!! If pos is provided w/multiple matches, sort by offset delta

  return ret;
};

// !!! Need to support:
//  - object types (currently not doing that)
//  - vector bounds (we have dims here, but not length)
//  - Can't currently set a constant for array!
//  - Options:
//     - string: length min/max, charset, locale for Intl.Collator
//     - dims: size min/max along each dimension
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

    // Ensure we have a fairly sensible set of default options
    this.options = options ?? {};
    switch (type) {
      case ArgTag.STRING:
        if (!this.options.charset)
          this.options.charset =
            " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
        if (!this.options.length) this.options.length = { min: 1, max: 10 };
        break;
      case ArgTag.NUMBER:
        if (!this.options.integer) this.options.integer = false;
        break;
    }

    // Ensure we have a length configured for each dimension
    if (dims) {
      if (this.options.dimLength === undefined) this.options.dimLength = [];
      for (let i = 0; i < this.dims - 1; i++) {
        const thisDimOpt = this.options.dimLength;
        if (!thisDimOpt[i]) {
          this.options.dimLength[i] = { min: 2, max: 2 };
        }
        if (thisDimOpt[i].min > thisDimOpt[i].max || thisDimOpt[i].min < 1) {
          throw new Error(
            `Invalid dimension length: min=${thisDimOpt[i].min} max=${thisDimOpt[i].min} arg: ${this.name}`
          );
        }
      }
    }

    // If an undefined or empty interval is provided, use the type's default
    this.intervals =
      intervals === undefined || intervals.length === 0
        ? (this.getDefaultIntervals(this.type) as Interval<T>[])
        : intervals;

    // Ensure min <= max on each interval
    for (const i in this.intervals) {
      if (this.intervals[i].min > this.intervals[i].max) {
        throw new Error(
          `Invalid interval: ${JSON.stringify(this.intervals[i])}`
        );
      }
    }
  }

  // !!!
  private getDefaultIntervals(type: ArgTag): Interval<ArgType>[] {
    switch (type) {
      case ArgTag.NUMBER:
        return [
          {
            min: Number.MIN_VALUE,
            max: Number.MAX_VALUE,
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
  public static fromAstNode(node: Identifier, offset: number): ArgDef<ArgType> {
    if (node.typeAnnotation !== undefined) {
      const [type, dims] = ArgDef.getTypeFromNode(node.typeAnnotation);
      switch (type) {
        case ArgTag.STRING:
          return new ArgDef<string>(
            node.name,
            offset,
            type,
            dims,
            node.optional
          );
        case ArgTag.BOOLEAN:
          return new ArgDef<boolean>(
            node.name,
            offset,
            type,
            dims,
            node.optional
          );
        case ArgTag.NUMBER:
          return new ArgDef<number>(
            node.name,
            offset,
            type,
            dims,
            node.optional
          );
        case ArgTag.OBJECT:
          return new ArgDef<Record<string, unknown>>(
            node.name,
            offset,
            type,
            dims,
            node.optional
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
    node: TSTypeAnnotation | TypeNode
  ): [ArgTag, number] {
    switch (node.type) {
      case AST_NODE_TYPES.TSAnyKeyword:
        //throw new Error("Unsupported type annotation: " + JSON.stringify(node));
        return [ArgTag.NUMBER, 0]; // !!!
      case AST_NODE_TYPES.TSStringKeyword:
        return [ArgTag.STRING, 0];
      case AST_NODE_TYPES.TSBooleanKeyword:
        return [ArgTag.BOOLEAN, 0];
      case AST_NODE_TYPES.TSNumberKeyword:
        return [ArgTag.NUMBER, 0];
      case AST_NODE_TYPES.TSTypeAnnotation:
        return ArgDef.getTypeFromNode(node.typeAnnotation);
      case AST_NODE_TYPES.TSArrayType: {
        const [type, dims] = ArgDef.getTypeFromNode(node.elementType);
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
}

// !!!
export enum ArgTag {
  NUMBER = "number",
  STRING = "string",
  BOOLEAN = "boolean",
  OBJECT = "object",
}
export type ArgType = number | string | boolean | Record<string, unknown>;

// !!!
// TODO: Add support for open and closed intervals
export type Interval<T> = {
  min: T;
  max: T;
};

// !!!
export type ArgOptions = {
  // For type string
  charset?: string;
  length?: Interval<number>;

  // For type number
  integer?: boolean;

  // For args with dimensions
  dimLength?: Interval<number>[];
};
