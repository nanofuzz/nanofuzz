import { ProgramDef } from "./ProgramDef";
import { parse, simpleTraverse } from "@typescript-eslint/typescript-estree";
import {
  AST_NODE_TYPES,
  TSTypeAliasDeclaration,
  EntityName,
  Node,
  Identifier,
  TSPropertySignature,
} from "@typescript-eslint/types/dist/ast-spec";
import { TSTypeReference } from "@typescript-eslint/types/dist/ast-spec";
import { ArgOptions, ArgDef, ArgTag, ArgType } from "./ArgDef";

/**
 * Represents either a TypeDef or a TypeDefProxy
 */
export interface ITypeDef {
  getName(): string;
  getType(): [ArgTag, number];
  getArgDef(): ArgDef<ArgType>;
}

/**
 * Represents a type definition in a TypeScript program
 */
export class TypeDef implements ITypeDef {
  private _program: ProgramDef; // Program where the type is defined
  private _name: string; // Name of the type
  private _type: [ArgTag, number]; // Type of the type
  private _argDef: ArgDef<ArgType>; // ArgDef object

  /**
   * Constructs a new TypeDef instance
   *
   * @param program The containing program
   * @param name The type's name
   * @param type The concrete type and dimension of the type
   * @param argDef The underlying ArgDef object (!!!! refactor)
   * @param children The type's children
   */
  constructor(
    program: ProgramDef,
    name: string,
    type: [ArgTag, number],
    argDef: ArgDef<ArgType>
  ) {
    this._program = program;
    this._name = name;
    this._type = type;
    this._argDef = argDef;
  } // end constructor

  /**
   * Finds type definitions in a program
   *
   * @param program The containing program
   * @param name The name of the type (optional; not currently used)
   * @param offset The offset of the type (optional; not currently used)
   * @param options Options (optional)
   */
  public static find(
    program: ProgramDef,
    name?: string,
    offset?: number,
    options: ArgOptions = program.getOptions()
  ): ITypeDef[] {
    const src = program.getSrc();
    const module = program.getModule();
    const ast = parse(src, { range: true }); // Parse the source

    // List of nodes
    const typeAliasNodes: Record<string, TSTypeAliasDeclaration> = {};
    const typeRefNodes: Record<string, TSTypeReference> = {};

    // Traverse the AST and find:
    // 1. Top-level type alias declarations
    // 2. Type references, which we'll try to resolve later
    simpleTraverse(
      ast,
      {
        enter: (node) => {
          // Find type alias declarations
          if (node.type === AST_NODE_TYPES.TSTypeAliasDeclaration) {
            // Skip any block scoped type alias declarations
            if (!TypeDef.isBlockScoped(node)) {
              // Throw an error for duplicate type aliases
              if (node.id.name in typeAliasNodes) {
                throw new Error(
                  `Duplicate type alias '${node.id.name}' found in module '${module}'`
                );
              } else {
                // Add the type alias to the running list
                typeAliasNodes[node.id.name] = node;
              }
            }
          }

          // Find type references
          if (node.type === AST_NODE_TYPES.TSTypeReference) {
            typeRefNodes[TypeDef.getIdentifierName(node.typeName)] = node;
          }
        }, // enter
      },
      true // set parent pointers
    ); // traverse AST

    // Replace each type reference with the corresponding type definition
    for (const name in typeRefNodes) {
      // Is the type reference present?
      if (name in typeAliasNodes) {
        const refNode = typeRefNodes[name];
        const typeNode = typeAliasNodes[name].typeAnnotation;

        // In-place rewrite the ref node as a type node
        // (kind of dirty, but we throw away the AST anyway)
        for (const key in typeNode) {
          if (key !== "parent") {
            refNode[key] = typeNode[key];
          }
        }
      }
    }

    // Build the corresponding TypeDef objects
    const ret: ITypeDef[] = [];
    for (const name in typeAliasNodes) {
      const node = typeAliasNodes[name];
      ret.push(new TypeDefProxy(name, program, node, 0, options));
    }

    // Return the TypeDef objects
    return ret;
  } // end fn: find()

  /**
   * Creates a TypeDef object from an ArgDef object
   *
   * @param arg ArgDef object
   * @returns TypeDef object
   */
  public static fromArgDef(arg: ArgDef<ArgType>): TypeDef {
    return new TypeDef(
      arg.getProgram(),
      arg.getName(),
      [arg.getType(), arg.getDim()],
      arg
    );
  } // fn: fromArgDef()

  /**
   * Gets a qualified identifier name for a given entity node
   * (!!!! refactor: should be private)
   *
   * @param node The node to get the identifier name for
   * @returns Qualified name as a string
   */
  public static getIdentifierName(node: EntityName): string {
    switch (node.type) {
      case AST_NODE_TYPES.Identifier: {
        return node.name;
      }
      case AST_NODE_TYPES.TSQualifiedName: {
        return TypeDef.getIdentifierName(node.left) + "." + node.right.name;
      }
    }
  } // fn: getIdentifierName()

  /**
   * Determines whether a node is block scoped
   * Note: Requires nodes have the parent property set
   *
   * @param node The node to check
   * @returns true if the node is block scoped, false otherwise
   */
  private static isBlockScoped(node: Node): boolean {
    let thisNode: Node = node;
    while (!(thisNode.parent === undefined)) {
      if (thisNode.parent.type === AST_NODE_TYPES.BlockStatement) {
        return true; // block scoped
      } else {
        thisNode = thisNode.parent; // move up the tree
      }
    }
    return false; // at root; block not encountered
  } // fn: isBlockScoped()

  /**
   * Gets the name of the type in the program
   *
   * @returns The name of the type
   */
  public getName(): string {
    return this._name;
  } // fn: getName()

  /**
   * Gets the concrete type of the type
   *
   * @returns The type of the type
   */
  public getType(): [ArgTag, number] {
    return this._type;
  } // fn: getType()

  /**
   * Gets the underlying ArgDef for the type
   * (!!!! refactor: ArgDef should contain TypeDef, not the other way around)
   *
   * @returns The underlying ArgDef
   */
  public getArgDef(): ArgDef<ArgType> {
    return this._argDef;
  } // fn: getArgDef()
} // class: TypeDef

/**
 * Represents a proxy for a type definition in a TypeScript program.
 * The purpose of this proxy class is to delay the construction of the underlying
 * TypeDef/ArgDef until after all the types have been loaded into the Program.
 */
class TypeDefProxy implements ITypeDef {
  private _typeDef?: TypeDef; // The TypeDef instance proxied
  private _name: string; // Alias of the type
  private _program: ProgramDef; // Program where the type is defined
  private _node: Identifier | TSPropertySignature | TSTypeAliasDeclaration; // Node where the type is defined
  private _offset: number; // Offset of the type
  private _options: ArgOptions; // Options

  /**
   * Constructs a new TypeDefProxy instance
   *
   * @param name The name of the type (e.g., its alias)
   * @param program The program that contains the type
   * @param node The node where the type is defined
   * @param offset The offset for creating the ArgDef (note: should always be 0)
   * @param options The options for creating the ArgDef
   */
  constructor(
    name: string,
    program: ProgramDef,
    node: Identifier | TSPropertySignature | TSTypeAliasDeclaration,
    offset: number,
    options: ArgOptions
  ) {
    this._name = name;
    this._program = program;
    this._node = node;
    this._offset = offset;
    this._options = options;
  } // end constructor

  /**
   * Gets the TypeDef instance (creates the instance if necessary)
   *
   * @returns The TypeDef instance (creates the instance if necessary)
   */
  private getTypeDef(): TypeDef {
    if (this._typeDef === undefined) {
      return TypeDef.fromArgDef(
        ArgDef.fromAstNode(
          this._program,
          this._node,
          this._offset,
          this._options
        )
      );
    } else {
      return this._typeDef;
    }
  }
  /**
   * Gets the name of the TypeDef
   *
   * @returns The name/alias of the TypeDef
   */
  public getName(): string {
    return this._name;
  } // fn: getName()

  /**
   * Gets the concrete type and dimensions of the Typedef
   *
   * @returns The concrete type and dimensions of the Typedef
   */
  public getType(): [ArgTag, number] {
    return (this._typeDef ?? this.getTypeDef()).getType();
  } // fn: getType()

  /**
   * Gets the underlying ArgDef for the type
   *
   * @returns The underlying ArgDef
   */
  public getArgDef(): ArgDef<ArgType> {
    return (this._typeDef ?? this.getTypeDef()).getArgDef();
  } // fn: getArgDef()
}
