import {
  AST_NODE_TYPES,
  parse,
  simpleTraverse,
} from "@typescript-eslint/typescript-estree";
import { ArgDef, ArgOptionOverrides, ArgOptions, ArgType } from "./ArgDef";

/**
 * The FunctionDef class represents a function definition in a Typescript source
 * file.  It provides methods for extracting information about the function,
 * including its formal parameters, which are represented by the ArgDef clsss.
 *
 * Limitations of the current implementation
 * - Requires a type-annotated TypeScript function signature
 * - Anonymous functions are not supported
 * - Analysis of class methods is not supported
 * - Presently cannot set an entire array as a constant (only its elements)
 * - String values are compared using default sort order, regarldess of the
 *   order specified in ArgOptions.strCharset.
 */
export class FunctionDef {
  private argDefs: ArgDef<ArgType>[] = [];
  private ref: FunctionRef;

  /**
   * Constructs a new FunctionDef instance using a FunctionRef object.
   * and optional set of options.
   *
   * @param ref The function reference to be analyzed
   * @param options Options for the function analysis (optional)
   */
  constructor(ref: FunctionRef, options?: ArgOptions) {
    options = options ?? ArgDef.getDefaultOptions();
    this.ref = ref;

    this.argDefs = [];
    const ast = parse(this.ref.src, { range: true }); // Parse the source

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
            this.argDefs.push(
              ArgDef.fromAstNode(thisArg, parseInt(i), options)
            );
          } else {
            throw new Error(`Unsupported argument type: ${thisArg.type}`);
          }
        }
      }
    } else {
      throw new Error(`Unsupported function declaration`);
    }
  }

  /**
   * Returns the function name
   *
   * @returns The function name
   */
  public getName(): string {
    return this.ref.name;
  } // fn: getName()

  /**
   * Returns the function's source code
   *
   * @returns Source code of the function
   */
  public getSrc(): string {
    return this.ref.src;
  } // fn: getSrc()

  /**
   * Returns the array of function arguments
   *
   * @returns array of function arguments
   */
  public getArgDefs(): ArgDef<ArgType>[] {
    return [...this.argDefs];
  } // fn: getArgDefs()

  /**
   * Returns the starting offset of the function in the source file.
   *
   * @returns the start offset of the function in the source file
   */
  public getStartOffset(): number {
    return this.ref.startOffset;
  } // fn: getStartOffset()

  /**
   * Returns the ending offset of the function in the source file.
   *
   * @returns the end offset of the function in the source file
   */
  public getEndOffset(): number {
    return this.ref.endOffset;
  } // fn: getEndOffset()

  /**
   * Returns the module filename where the function is defined
   *
   * @returns the module filename where the function is defined
   */
  public getModule(): string {
    return this.ref.module;
  } // fn: getModule()

  /**
   * Returns the full in-source reference to the function.
   *
   * @returns the full in-source reference to the function
   */
  public getRef(): FunctionRef {
    return { ...this.ref };
  } // fn: getRef()

  /**
   * Returns true if the function is exported; false, otherwise.
   *
   * @returns true if the function is exported; false, otherwise.
   */
  public isExported(): boolean {
    return this.ref.export;
  } // fn: isExported()

  /**
   * Applies option overrides to the function definition,
   * including its arguments, that influence how the function
   * analysis is interpreted.
   *
   * @param overrides
   */
  public applyOverrides(overrides: ArgOptionOverrides): void {
    // Apply argument overrides
    for (const argName of Object.keys(overrides.argOptions)) {
      const arg = this.argDefs.find((arg) => arg.getName() === argName);
      if (arg !== undefined) arg.setOptions(overrides.argOptions[argName]);
    }
  } // fn: applyOverrides()

  /**
   * Analyzes a Typescript module and returns a list of functions and their souces that
   * are defined within the module.  If `fnName` and/or `offset` are specified, the list
   * of functions will be filtered by the provided criteria.
   *
   * @param src The module source code to be analyzed
   * @param fnName The optional function name to find
   * @param offset The optional offset inside the desired function body
   * @returns an array of `FunctionDef`s containing matching functions
   *
   * Throws an exception if the function is not supported for analysis.
   */
  public static find(
    src: string,
    module: string,
    fnName?: string,
    offset?: number,
    options?: ArgOptions
  ): FunctionDef[] {
    let ret: FunctionRef[] = [];
    const ast = parse(src, { range: true }); // Parse the source

    // Traverse the AST to find function definitions
    simpleTraverse(
      ast,
      {
        enter: (node, parent) => {
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
            ret.push({
              name: node.id.name,
              module: module,
              src:
                parent.kind + " " + src.substring(node.range[0], node.range[1]),
              startOffset: node.range[0],
              endOffset: node.range[1],
              export: parent.parent
                ? parent.parent.type === AST_NODE_TYPES.ExportNamedDeclaration
                : false,
            });
          } else if (
            // Standard Function Definition: function xyz(): void => { ... }
            node.type === AST_NODE_TYPES.FunctionDeclaration &&
            node.id !== null &&
            (!fnName || node.id.name === fnName) &&
            (!offset || (node.range[0] <= offset && node.range[1] >= offset))
          ) {
            ret.push({
              name: node.id.name,
              module: module,
              src: src.substring(node.range[0], node.range[1]),
              startOffset: node.range[0],
              endOffset: node.range[1],
              export: parent
                ? parent.type === AST_NODE_TYPES.ExportNamedDeclaration
                : false,
            });
          }
          // TODO: Add support for class methods
        }, // enter
      },
      true // set parent pointers
    ); // traverse AST

    // If offset is provided and we have multiple matches,
    // return the function that is closest to the offset
    if (offset !== undefined && ret.length > 0) {
      ret = [
        ret.reduce((best, curr) =>
          offset >= curr.startOffset &&
          offset - curr.startOffset < offset - best.startOffset
            ? curr
            : best
        ),
      ];
    }

    return ret.map((e) => new FunctionDef(e, options));
  } // fn: find

  /**
   * Analyzes a Typescript module and returns a list of potential validator functions that
   * are defined within the module.
   * (Not done; currently, it returns an array of all valid functions)
   *
   * @param src The source code to be analyzed
   * @param module module
   * @returns an array of `FunctionDef`s containing matching validator functions
   */
  public static findValidators(
    src: string,
    module: string,
    fnName?: string,
    offset?: number,
    options?: ArgOptions
  ): FunctionDef[] {
    let ret: FunctionRef[] = [];
    const ast = parse(src, { range: true }); // Parse the source

    // Traverse the AST to find function definitions
    simpleTraverse(
      ast,
      {
        enter: (node, parent) => {
          // console.log("This is node, parent:", node, parent);

          // vvvvv Do we want to support this? vvvvvvv
          // if (
          //   // Arrow Function Definition: const xyz = (): void => { ... }
          //   node.type === AST_NODE_TYPES.VariableDeclarator &&
          //   parent !== undefined &&
          //   parent.type === AST_NODE_TYPES.VariableDeclaration &&
          //   node.init &&
          //   node.init.type === AST_NODE_TYPES.ArrowFunctionExpression &&
          //   node.id.type === AST_NODE_TYPES.Identifier &&
          //   (!fnName || node.id.name === fnName) &&
          //   (!offset || (node.range[0] <= offset && node.range[1] >= offset))
          // ) {
          //   ret.push({
          //     name: node.id.name,
          //     module: module,
          //     src:
          //       parent.kind + " " + src.substring(node.range[0], node.range[1]),
          //     startOffset: node.range[0],
          //     endOffset: node.range[1],
          //     export: parent.parent
          //       ? parent.parent.type === AST_NODE_TYPES.ExportNamedDeclaration
          //       : false,
          //   });
          if (
            // Standard Function Definition: function xyz(): void => { ... }

            // Note: In order to be a potential validator function, the input and
            // output types should both be FuzzTestResult
            // For now, just include any valid functions
            node.type === AST_NODE_TYPES.FunctionDeclaration &&
            node.id !== null &&
            (!fnName || node.id.name === fnName) &&
            (!offset || (node.range[0] <= offset && node.range[1] >= offset))
          ) {
            ret.push({
              name: node.id.name,
              module: module,
              src: src.substring(node.range[0], node.range[1]),
              startOffset: node.range[0],
              endOffset: node.range[1],
              export: parent
                ? parent.type === AST_NODE_TYPES.ExportNamedDeclaration
                : false,
            });
          }
          // TODO: Add support for class methods
        }, // enter
      },
      true // set parent pointers
    ); // traverse AST

    // If offset is provided and we have multiple matches,
    // return the function that is closest to the offset
    if (offset !== undefined && ret.length > 0) {
      ret = [
        ret.reduce((best, curr) =>
          offset >= curr.startOffset &&
          offset - curr.startOffset < offset - best.startOffset
            ? curr
            : best
        ),
      ];
    }

    return ret.map((e) => new FunctionDef(e, options));
  } // fn: findValidators

  /**
   * Returns a flat array of all function arguments, including
   * the children of arguments.  The selection is depth-first.
   *
   * @returns a flat array of all function arguments.
   */
  public getArgDefsFlat(): ArgDef<ArgType>[] {
    const ret: ArgDef<ArgType>[] = [];
    for (const arg of this.argDefs) {
      ret.push(arg);
      ret.push(...arg.getChildrenFlat());
    }
    return ret;
  } // fn: getArgDefsFlat()
} // class: FunctionDef

/**
 * Represents a reference to a function in a source code file.
 */
export type FunctionRef = {
  module: string;
  name: string;
  src: string;
  startOffset: number;
  endOffset: number;
  export: boolean;
};
