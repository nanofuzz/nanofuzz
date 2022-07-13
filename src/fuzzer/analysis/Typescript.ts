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

/**
 * The arbitrary name we assign to the outer function when parsing
 * arrow functions.
 */
const OUTERFNNAME = "$_f";

// !!!
export class ArgDef {
  private name: string;
  private offset: number; // offset of the argument in the function (0-based)
  private type: ArgType;
  private dims: number;
  private optional: boolean;

  // !!!
  public constructor(
    name: string,
    offset: number,
    type: ArgType,
    dims?: number,
    optional?: boolean
  ) {
    this.name = name;
    this.offset = offset;
    this.type = type;
    this.dims = dims ?? 0;
    this.optional = optional ?? false;
  }

  // !!!
  public static fromAstNode(node: Identifier, offset: number): ArgDef {
    if (node.typeAnnotation !== undefined) {
      const [type, dims] = ArgDef.getTypeFromNode(node.typeAnnotation);
      return new ArgDef(node.name, offset, type, dims, node.optional);
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
  ): [ArgType, number] {
    switch (node.type) {
      case AST_NODE_TYPES.TSAnyKeyword:
        throw new Error("Unsupported type annotation: " + JSON.stringify(node));
      case AST_NODE_TYPES.TSStringKeyword:
        return [ArgType.STRING, 0];
      case AST_NODE_TYPES.TSBooleanKeyword:
        return [ArgType.BOOLEAN, 0];
      case AST_NODE_TYPES.TSNumberKeyword:
        return [ArgType.NUMBER, 0];
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
  public getName(): string {
    return this.name;
  }
  // !!!
  public getOffset(): number {
    return this.offset;
  }
  // !!!
  public getType(): [ArgType, number] {
    return [this.type, this.dims];
  }
  // !!!
  public isOptional(): boolean {
    return this.optional;
  }
}

// !!!
export enum ArgType {
  NUMBER = "number",
  STRING = "string",
  BOOLEAN = "boolean",
  OBJECT = "object",
}

// !!! Requires TS function - NOT JS function because they lack type information
// !!! Does not handle class methods
export const getTsFnArgs = (src: string): ArgDef[] => {
  const args: ArgDef[] = [];
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
): string[] => {
  const ret: string[] = [];
  const ast = parse(src, { range: true }); // Parse the source

  // Traverse the AST to fine property accesses
  simpleTraverse(ast, {
    enter: (node, parent) => {
      // Need to check for these situations:
      // - Variable declarations that name an arrow function
      // - Traditional function declarations
      // - Class methods <?> !!!

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
        ret.push(
          parent.kind + " " + src.substring(node.range[0], node.range[1])
        );

        // Std Function Definition: function xyz(): void => { ... }
      } else if (
        node.type === AST_NODE_TYPES.FunctionDeclaration &&
        node.id !== null &&
        (!fnName || node.id.name === fnName) &&
        (!offset || (node.range[0] <= offset && node.range[1] >= offset))
      ) {
        ret.push(src.substring(node.range[0], node.range[1]));
      }
    }, // enter
  }); // traverse AST

  return ret;
};
