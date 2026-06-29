/* eslint-disable @typescript-eslint/switch-exhaustiveness-check */
import * as JSON5 from "json5";
import { removeParents } from "../Util";
import { parse, ParseResult } from "@babel/parser";
import _traverse, { NodePath } from "@babel/traverse";
import {
  File,
  TSEntityName,
  TSTypeAliasDeclaration,
  TSTypeAnnotation,
  TSLiteralType,
  TSType,
  Identifier,
  TSPropertySignature,
  Node,
  TypeAnnotation,
  VariableDeclarator,
  FunctionDeclaration,
} from "@babel/types";
import path from "path";
import fs from "fs";
import {
  ArgTag,
  FunctionRef,
  IdentifierName,
  ProgramImports,
  ProgramPath,
  TypeRef,
  ArgOptions,
  ArgType,
} from "../Types";
import { getErrorMessageOrJson } from "../../Util";
import { AbstractProgram } from "../AbstractProgram";
import * as ProgramFactory from "../ProgramFactory";

// Default import nonsense for node
// https://github.com/babel/babel/discussions/13093
const traverse: typeof _traverse =
  typeof _traverse === "function" ? _traverse : (_traverse as any).default;

/**
 * The TypescriptProgram class represents a TypeScript program definition in a
 * source file. It provides methods for extracting information about the
 * functions and types defined by the program, which are represented by the
 * FunctionDef and TypeDef classes.
 *
 * Limitations of the current implementation
 * - Only top-level functions and types are supported
 * - Requires type-annotated TypeScript program source
 * - Anonymous functions are not supported
 * - Re-exported functions are not supported
 * - Default imports/exports are limited to named type definitions
 * - Analysis of classes and class methods are not supported
 */
export class TypescriptProgram extends AbstractProgram {
  public readonly lang = "typescript";
  public readonly extensions = Object.freeze([".ts"]);

  protected _ast: ParseResult<File> | undefined;

  /**
   * Constructs a new ProgramDef instance using a FunctionRef object.
   * and optional set of options.
   *
   * @param src Source of the program to be analyzed
   * @param path Path to the source file (optional)
   * @param options Options for the function analysis (optional)
   */
  constructor(
    getSource: () => string,
    filename: string,
    options?: ArgOptions,
    parent?: AbstractProgram
  ) {
    super(getSource, filename, options, parent);
  } // end constructor

  // !!!!!!
  protected _parse(src: string): void {
    // Parse the program source to generate the AST
    this._ast =
      this._ast ??
      parse(src, {
        sourceType: "unambiguous",
        plugins: ["typescript"],
        attachComment: true,
        ranges: true,
      });
  }

  // !!!!!!
  protected _afterLoad(): void {
    this._ast = undefined;
  }

  /**
   * Returns the imports defined in the program
   *
   * @param ast The parsed AST for the program
   * @returns A record of the imports defined in the program
   */
  protected _findImports(): ProgramImports {
    const imports: ProgramImports = { programs: {}, identifiers: {} };
    if (this._ast === undefined) {
      throw new Error(`AST not loaded`);
    }
    const ast = this._ast;

    traverse(ast, {
      enter: (path) => {
        switch (path.node.type) {
          case "ImportDeclaration": {
            if (typeof path.node.source.value === "string") {
              // Resolve the import module
              const importModulePath = this._resolveImportModule(
                path.node.source.value
              );

              // Loop over all the imports specified
              path.node.specifiers.forEach((specifier) => {
                switch (specifier.type) {
                  // import { foo } from "bar";
                  case "ImportSpecifier": {
                    imports.identifiers[specifier.local.name] = {
                      local: specifier.local.name,
                      imported:
                        specifier.imported.type === "Identifier"
                          ? specifier.imported.name
                          : specifier.imported.value,
                      programPath: importModulePath,
                      resolved: true,
                      default: false,
                    };
                    imports.programs[importModulePath] = "?";
                    break;
                  }
                  // import * as foo from "bar";
                  case "ImportNamespaceSpecifier": {
                    imports.identifiers[specifier.local.name] = {
                      local: specifier.local.name,
                      imported: "*",
                      programPath: importModulePath,
                      resolved: false,
                      default: false,
                    };
                    imports.programs[importModulePath] = "?";
                    break;
                  }
                  // import foo from "bar";
                  case "ImportDefaultSpecifier": {
                    imports.identifiers[specifier.local.name] = {
                      local: specifier.local.name,
                      imported: "*",
                      programPath: importModulePath,
                      resolved: false,
                      default: true,
                    };
                    imports.programs[importModulePath] = "?";
                    break;
                  }
                }
              });
            }
            break;
          }
        }
      }, // enter
    }); // traverse AST
    return imports;
  } // fn: findImports()

  /**
   * Accepts a program AST and returns a default type export if defined
   * in the program.
   *
   * We don't support many types of default exports here, and the usual limitations
   * from elsewhere still apply.
   *
   * @param `ast` Program AST
   * @returns A default export, if found; otherwise, `undefined`
   */
  protected _findDefaultTypeExport(): TypeRef | undefined {
    const filename = this._filename;
    if (this._ast === undefined) {
      throw new Error(`AST not loaded`);
    }
    const ast = this._ast;
    let defaultExport: TypeRef | undefined;

    // Traverse the AST and find top-level type alias declarations
    traverse(ast, {
      enter: (path) => {
        if (defaultExport) return;
        switch (path.node.type) {
          // Implicit defaults:
          //   - export {x as default};
          case "ExportNamedDeclaration": {
            for (const specifier of path.node.specifiers) {
              const exportedName =
                specifier.exported.type === "Identifier"
                  ? specifier.exported.name
                  : specifier.exported.value;
              if (exportedName === "default") {
                switch (specifier.type) {
                  case "ExportSpecifier":
                    defaultExport = {
                      isExported: true,
                      optional: false,
                      dims: 0,
                      module: filename,
                      name: "default",
                      typeRefName: specifier.local.name,
                    };
                    return; // enter function

                  default:
                    console.debug(
                      `Unsupported implicit default export specifier '${specifier.exported.type}' in module '${filename}'`
                    );
                }
              }
            }
            break;
          }

          // Explicit default:
          //   - export default x;
          case "ExportDefaultDeclaration": {
            const decl = path.node.declaration;
            switch (decl.type) {
              case "Identifier":
                defaultExport = {
                  isExported: true,
                  optional: false,
                  dims: 0,
                  module: filename,
                  name: "default",
                  typeRefName: decl.name,
                };
                return; // enter function

              case "BooleanLiteral":
              case "StringLiteral":
              case "NumericLiteral":
                defaultExport = {
                  isExported: true,
                  optional: false,
                  dims: 0,
                  module: filename,
                  name: "default",
                  type: {
                    children: [],
                    dims: 0,
                    resolved: true,
                    type: ArgTag.LITERAL,
                    value: decl.value,
                  },
                };
                return; // enter function

              default: {
                console.debug(
                  `Unsupported explicit default export type '${path.node.declaration.type}' in module '${filename}'`
                );
              }
            }
            break;
          }
        }
      }, // enter
    }); // traverse AST

    // Resolve the default type
    if (
      defaultExport &&
      !defaultExport.type &&
      defaultExport.typeRefName &&
      defaultExport.typeRefName in this._types
    ) {
      defaultExport.type = structuredClone(
        this._types[defaultExport.typeRefName].type
      );
    }

    // No default found: return undefined
    return defaultExport;
  } // fn: findDefaultTypeExport()

  /**
   * Accepts a program AST and returns a dictionary of type aliases defined
   * in the program.
   *
   * @param ast Program AST
   * @returns A dictionary of type aliases defined in the program
   */
  protected _findTypes(): Record<IdentifierName, TypeRef> {
    const filename = this._filename;
    if (this._ast === undefined) {
      throw new Error(`AST not loaded`);
    }
    const ast = this._ast;

    // List of nodes
    const types: Record<string, TypeRef> = {};

    // Traverse the AST and find top-level type alias declarations
    traverse(ast, {
      enter: (path) => {
        // Find type alias declarations
        if (path.isTSTypeAliasDeclaration()) {
          // Skip any block scoped type alias declarations
          if (!isBlockScoped(path)) {
            // Throw an error for duplicate type aliases
            if (path.node.id.name in types) {
              throw new Error(
                `Duplicate type alias '${path.node.id.name}' found in module '${filename}'`
              );
            } else {
              types[path.node.id.name] = this._getTypeRefFromAstNode(
                path.node,
                path.parent
              );
            }
          }
        }
      }, // enter
    }); // traverse AST

    // Return the TypeRef objects
    return types;
  } // fn: findTypes()

  /**
   * Resolves a TypeRef object through the import hierarchy to a concrete
   * type definition.
   *
   * @param typeRef The TypeRef object to resolve to a concrete type
   * @returns A concrete, resolved TypeRef object
   */
  public _resolveTypeRef(typeRef: TypeRef): TypeRef {
    // Handle any resolved or partially-resolved type references
    if (typeRef.type) {
      if (typeRef.type.resolved) {
        // Base case: We found a fully-resolved type reference
        return typeRef; // Return resolved type
      } else {
        // Type is only partially resolved
        typeRef.type.children.forEach((child) => this._resolveTypeRef(child));
        typeRef.type.resolved = true;
        return typeRef; // Return resolved type
      }
    }

    if (!typeRef.typeRefName) {
      throw new Error(
        `Internal error: typeRef is undefined in Typeref (${JSON5.stringify(
          typeRef
        )})`
      );
    }

    // Type is not yet resolved. Look up and resolve the type reference
    if (typeRef.typeRefName in this._types) {
      // Resolve and use the local type reference
      const resolvedType = this._resolveTypeRef(
        this._types[typeRef.typeRefName]
      );
      typeRef.type = structuredClone(resolvedType.type);

      if (typeRef.type) {
        typeRef.type.dims += resolvedType.dims;
      }
      typeRef.optional = typeRef.optional || resolvedType.optional;

      return typeRef; // this._types[typeRef.typeRefName];
    } else {
      // Follow the imported type reference
      // Split the local name into parts (e.g., "foo.bar" => ["foo", "bar"])
      // TODO: This should be more flexible
      const localNameParts = typeRef.typeRefName.split(".");

      // Lookup the import reference
      if (!(localNameParts[0] in this._imports.identifiers)) {
        throw new Error(
          `Internal error: ${this._filename} did not find local import ${localNameParts[0]}`
        );
      }
      const importRef = this._imports.identifiers[localNameParts[0]];

      // Get the imported module
      const importProgram = ProgramFactory.fromFile(
        importRef.programPath,
        this.lang,
        this._options,
        this
      );

      // Resolve unresolved imports
      if (!importRef.resolved) {
        if (importRef.default) {
          // Default import: create one default import
          importRef.resolved = true;
          if (
            importProgram.defaultExport !== undefined &&
            importProgram.defaultExport.name
          ) {
            importRef.imported = importProgram.defaultExport.name;
          } else {
            throw new Error(
              `Unable to find default type export in module '${importProgram.filename}' when processing imports for module '${this._filename}'`
            );
          }
        } else {
          // Namespace import: create concrete imports for each of the imports
          for (const exported of Object.values(importProgram.typesExported)) {
            const localName = localNameParts[0] + "." + exported.name;
            this._imports.identifiers[localName] = {
              local: localName,
              imported: exported.name ?? "__default",
              programPath: exported.module,
              resolved: true,
              default: !exported.name,
            };
          }

          // Remove the original unresolved import reference
          //delete this._imports.identifiers[localNameParts[0]];
        }
      }

      // Find the imported type reference that corresponds with
      // this type reference
      //
      // TODO: Need to handle other naming patterns here
      if (typeRef.typeRefName in this._imports.identifiers) {
        const importName =
          this._imports.identifiers[typeRef.typeRefName].imported;
        const defaultImport =
          this._imports.identifiers[typeRef.typeRefName].default;

        if (defaultImport && importProgram.defaultExport) {
          // Resolve default export
          const resolvedType = importProgram._resolveTypeRef(
            importProgram.defaultExport
          );
          typeRef.type = structuredClone(resolvedType.type);
          if (typeRef.type) {
            typeRef.type.dims += resolvedType.dims;
          }
          typeRef.optional = typeRef.optional || resolvedType.optional;
        } else if (importName in importProgram.typesExported) {
          // Resolve named export
          const resolvedType = importProgram._resolveTypeRef(
            importProgram.typesExported[importName]
          );
          typeRef.type = structuredClone(resolvedType.type);

          if (typeRef.type) {
            typeRef.type.dims += resolvedType.dims;
          }
          typeRef.optional = typeRef.optional || resolvedType.optional;
        } else {
          // Unable to find exported type
          throw new Error(
            `Unable to find exported type '${importName}' in module '${importProgram.filename}' when processing imports for module '${this._filename}`
          );
        }
      } else {
        throw new Error(
          `Internal error: ${this._filename} did not find import: ${typeRef.typeRefName}`
        );
      }

      return typeRef;
    }
  } // fn: _resolveTypeRef()

  /**
   * Resolves the given import module to a path relative to the
   * current module.
   *
   * @param importModule The module to import
   * @returns Path to the import module
   */
  protected _resolveImportModule(importModule: string): ProgramPath {
    const extensions = [".ts", ".d.ts", ""];

    // Resolve imports relative to the current module
    // Try to resolve each extension
    for (const ext of extensions) {
      try {
        if (importModule.startsWith(".")) {
          // Resolve the module relative to the current module
          const resolved = path.resolve(
            path.dirname(this._filename),
            importModule + ext
          );

          // Only return if we find the module (if not, retry)
          if (fs.existsSync(resolved)) {
            return resolved;
          }
        } else {
          const resolved = require.resolve(importModule + ext, {
            paths: [path.dirname(this._filename)], // Resolve from the importing module's path
          });
          const extension = path.extname(resolved);

          // If node resolves a Javascript file, look for a type defintion file
          if (extension !== ".js") {
            return resolved;
          } else {
            const typeDefFile = resolved.slice(0, -3) + ".d.ts";
            if (fs.existsSync(typeDefFile)) {
              return typeDefFile;
            } else {
              return resolved;
            }
          }
        }
      } catch (_e) {
        // Eat the exception & retry
      }
    } // for: each extension

    // Throw an exception if we did not resolve the import
    throw new Error(
      `Unable to resolve import from: '${
        this._filename
      }': cannot resolve '${importModule}'. Also tried extensions: ${JSON.stringify(
        extensions
      )}.`
    );
  } // fn: resolveImportModule()

  /**
   * Returns a TypeRef object for the given AST node
   *
   * @param node An identifier, property, or type alias AST node
   * @returns The TypeRef object for the given AST node
   */
  protected _getTypeRefFromAstNode(
    node:
      | Identifier
      | TSPropertySignature
      | TSTypeAliasDeclaration
      | TSTypeAnnotation
      | TSType
      | TypeAnnotation,
    parent: Node
  ): TypeRef {
    let typeNode: TSType | TSTypeAnnotation | TypeAnnotation;
    switch (node.type) {
      case "Identifier":
      case "TSTypeAnnotation":
      case "TSTypeAliasDeclaration":
      case "TSPropertySignature": {
        // Throw an error if type annotations are missing
        if (!node.typeAnnotation) {
          throw new Error(
            `Missing type annotation (already transpiled to JS?): ${JSON5.stringify(
              node,
              removeParents
            )}`
          );
        }
        if (
          node.typeAnnotation.type === "Noop" ||
          node.typeAnnotation.type === "TypeAnnotation"
        ) {
          throw new Error(
            `This type of type annotation is not supported: ${JSON5.stringify(
              node,
              removeParents
            )}`
          );
        }
        typeNode = node.typeAnnotation;
        break;
      }
      default:
        typeNode = node;
    }

    // Add the type alias to the running list
    const thisType: TypeRef = {
      module: this._filename,
      dims: 0, // override later if needed
      optional: false, // override later if needed
      isExported:
        parent.type === "ExportNamedDeclaration" ||
        parent.type === "TSModuleBlock",
    };

    // Determine the node name
    switch (node.type) {
      case "TSPropertySignature": {
        if (node.key.type === "Identifier") {
          thisType.name = node.key.name;
        } else {
          throw new Error(
            `Unsupported property key type: ${JSON5.stringify(
              node,
              removeParents
            )}`
          );
        }
        break;
      }
      case "Identifier": {
        thisType.name = node.name;
        break;
      }
      case "TSTypeAliasDeclaration": {
        thisType.name = node.id.name;
        break;
      }
    }

    // Determine whether the argument is optional (TSTypeAliasDeclarations don't have this)
    thisType.optional =
      "optional" in node &&
      node.optional !== undefined &&
      node.optional === true;

    // Handle type references, which we will resolve later
    //
    // Note: this does not catch arrays of type references;
    // we handle those below
    if (
      "typeAnnotation" in node &&
      node.typeAnnotation?.type === "TSTypeReference"
    ) {
      thisType.typeRefName = getIdentifierName(node.typeAnnotation.typeName);
    } else {
      // Get the node's type and dimensions
      const [type, dims, typeRefNode, literalValue] = this._getTypeFromAstNode(
        typeNode,
        this._options
      );

      // Create the TypeRef data structure
      switch (type) {
        case ArgTag.STRING:
        case ArgTag.BOOLEAN:
        case ArgTag.NUMBER: {
          thisType.type = {
            dims: dims,
            type: type,
            children: [],
            resolved: true,
          };
          break;
        }
        case ArgTag.LITERAL: {
          thisType.type = {
            dims: dims,
            type: type,
            children: [],
            value: literalValue,
            resolved: true,
          };
          break;
        }
        case ArgTag.UNION:
        case ArgTag.OBJECT:
        case ArgTag.TUPLE: {
          thisType.type = {
            dims: dims,
            type: type,
            children: this._getChildrenFromNode(typeNode),
          };
          break;
        }
        case ArgTag.UNRESOLVED: {
          thisType.dims = dims;
          thisType.typeRefName = typeRefNode; // Unresolved type reference
          break;
        }
      }
    }

    return thisType;
  } // fn: _getTypeRefFromAstNode()

  /**
   * Returns the type tag, number of dimensions, and type reference name
   * for the given AST type node.
   *
   * @param node The AST type node or type annotation
   * @param options ArgOptions
   * @returns [type tag, dimensions, type reference name, literal value]
   */
  protected _getTypeFromAstNode(
    node: TSTypeAnnotation | TSType | TypeAnnotation,
    options: ArgOptions
  ): [ArgTag, number, string?, ArgType?] {
    switch (node.type) {
      case "TSAnyKeyword":
        return [options.anyType, options.anyDims];
      case "TSStringKeyword":
        return [ArgTag.STRING, 0];
      case "TSBooleanKeyword":
        return [ArgTag.BOOLEAN, 0];
      case "TSNumberKeyword":
        return [ArgTag.NUMBER, 0];
      case "TSTypeAnnotation":
        return this._getTypeFromAstNode(node.typeAnnotation, options);
      case "TSUnionType":
        return [ArgTag.UNION, 0];
      case "TSTypeLiteral": // Object literal
        return [ArgTag.OBJECT, 0];
      case "TSLiteralType":
        return [
          ArgTag.LITERAL,
          0,
          undefined,
          this._getLiteralValueFromNode(node),
        ];
      case "TSArrayType": {
        const [type, dims, typeName, literalValue] = this._getTypeFromAstNode(
          node.elementType,
          options
        );
        return [type, dims + 1, typeName, literalValue];
      }
      case "TSTupleType": {
        return [ArgTag.TUPLE, 0];
      }
      case "TSUndefinedKeyword": {
        return [ArgTag.LITERAL, 0, undefined, undefined];
      }
      case "TSParenthesizedType": {
        return this._getTypeFromAstNode(node.typeAnnotation, options);
      }
      case "TSTypeReference": {
        return [ArgTag.UNRESOLVED, 0, getIdentifierName(node.typeName)];
      }
      default:
        throw new Error(
          "Unsupported type annotation: " +
            JSON5.stringify(node, removeParents, 2)
        );
    }
  } // fn: _getTypeFromAstNode()

  /**
   * Returns an ArgType from a TSLiteralType AST Node
   *
   * @param node a TSLiteralType AST node
   * @returns an ArgType literal value
   */
  protected _getLiteralValueFromNode(node: TSLiteralType): ArgType {
    const literalNode = node.literal;
    switch (literalNode.type) {
      case "StringLiteral":
      case "BooleanLiteral":
      case "NumericLiteral": {
        return literalNode.value;
      }
      // TODO Add support for BigIntLiteral, TemplateLiteral, UnaryExpression, UpdateExpression
    }
    throw new Error(
      "Unsupported literal value type in type annotation: " +
        JSON5.stringify(node, removeParents, 2)
    );
  } // fn: _getLiteralValueFromNode()

  /**
   * Returns the child TypeRef objects for the given AST type node.
   *
   * @param node The AST type node or type annotation
   * @returns An array of child TypeRef objects
   */
  protected _getChildrenFromNode(
    node: TSTypeAnnotation | TSType | TypeAnnotation
  ): TypeRef[] {
    switch (node.type) {
      case "TSAnyKeyword":
      case "TSStringKeyword":
      case "TSBooleanKeyword":
      case "TSLiteralType":
      case "TSNumberKeyword":
        return [];
      case "TSArrayType":
        return this._getChildrenFromNode(node.elementType);
      case "TSParenthesizedType":
        return this._getChildrenFromNode(node.typeAnnotation);
      case "TSTypeReference":
        throw new Error(
          `Internal Error: Unresolved type reference found: ${JSON5.stringify(
            node,
            removeParents
          )}`
        );
      case "TSTypeLiteral": {
        return node.members.map((member) => {
          if (member.type === "TSPropertySignature")
            return this._getTypeRefFromAstNode(member, node);
          else
            throw new Error(
              "Unsupported object property type annotation: " +
                JSON5.stringify(member, removeParents, 2)
            );
        });
      }
      case "TSUnionType":
        return node.types.map((type) =>
          this._getTypeRefFromAstNode(type, node)
        );
      case "TSTypeAnnotation": {
        // Collapse array and parenthesis annotations -- we previously handled those
        let innerNode = node.typeAnnotation;
        while (
          innerNode.type === "TSArrayType" ||
          innerNode.type === "TSParenthesizedType"
        ) {
          if (innerNode.type === "TSArrayType") {
            innerNode = innerNode.elementType;
          } else {
            innerNode = innerNode.typeAnnotation;
          }
        }

        switch (innerNode.type) {
          case "TSTypeReference": {
            const typeName = getIdentifierName(innerNode.typeName);
            throw new Error(
              `Internal Error: Unable to find type reference '${typeName}' in program`
            );
          }

          case "TSTupleType":
          case "TSUnionType": {
            return this._getChildrenFromNode(innerNode);
          }

          case "TSTypeLiteral": {
            return innerNode.members.map((member) => {
              if (member.type === "TSPropertySignature")
                return this._getTypeRefFromAstNode(member, node);
              else
                throw new Error(
                  "Unsupported object property type annotation: " +
                    JSON5.stringify(member, removeParents, 2)
                );
            });
          }

          default:
            throw new Error(
              "Unsupported object type annotation: " +
                JSON5.stringify(innerNode, removeParents, 2)
            );
        }
      }

      case "TSTupleType": {
        return node.elementTypes.map((tupleMember) => {
          const type =
            // TODO: Preserve names
            tupleMember.type === "TSNamedTupleMember"
              ? tupleMember.elementType
              : tupleMember;
          return this._getTypeRefFromAstNode(type, node);
        });
      }

      default:
        throw new Error(
          "Unsupported type annotation: " +
            JSON5.stringify(node, removeParents, 2)
        );
    }
  } // fn: _getChildrenFromNode()

  /**
   * Returns an object with two fields:
   * - `supported`, a dictionary of top-level named functions defined in the program
   * - `unsupported`, a dictionary of top-level named functions that could not be processed
   *
   * @param ast Program AST
   * @returns An object with two fields, `supported` and `unsupported`
   */
  protected _findFunctions(): {
    supported: AbstractProgram["_functions"]["supported"];
    unsupported: AbstractProgram["_functions"]["unsupported"];
  } {
    if (this._ast === undefined) {
      throw new Error(`AST not loaded`);
    }
    const ast = this._ast;
    const supported: AbstractProgram["_functions"]["supported"] = {};
    const unsupported: AbstractProgram["_functions"]["unsupported"] = {};

    // Traverse the AST to find function definitions
    traverse(ast, {
      enter: (path) => {
        // Only named functions are supported
        if (!("id" in path.node && path.node.id && "name" in path.node.id)) {
          return;
        }
        const name = path.node.id.name;

        try {
          const maybeFunction = this._getFunctionFromNode(
            name,
            path,
            path.parentPath ?? undefined
          );
          if (maybeFunction) {
            supported[name] = maybeFunction;
          }
        } catch (e: unknown) {
          const msg = getErrorMessageOrJson(e);
          console.debug(
            `Error processing function '${name}' in module '${this._filename}': ${msg}`
          );
          unsupported[name] = {
            reason: msg,
            node: JSON5.stringify(path.node),
          };
        }
      }, // enter
      // TODO: Add support for class methods
    }); // traverse AST

    return {
      supported,
      unsupported,
    };
  } // fn: _findFunctions()

  /**
   * Returns a FunctionRef for the given node if it is a supported function.
   * If the node is an unsupported function, throws an error.
   * If the node is not a function, returns undefined.
   *
   * @param name The name of the function
   * @param path The node to analyze
   * @param parent The parent node of the node to analyze
   * @returns A FunctionRef if the node is a supported function
   */
  protected _getFunctionFromNode(
    name: string,
    path: NodePath<Node>,
    parent: NodePath<Node> | undefined
  ): FunctionRef | undefined {
    if (
      // Arrow Function Definition: const xyz = (): void => { ... }
      path.isVariableDeclarator() &&
      parent !== undefined &&
      parent.isVariableDeclaration() &&
      path.node.init &&
      path.node.init.type === "ArrowFunctionExpression" &&
      path.node.id.type === "Identifier" &&
      !isBlockScoped(path) // ignore inner functions
    ) {
      // ReturnType is not as important for fuzzing, so we don't throw an error
      // if we encounter something we don't support.
      let returnType = undefined;
      let isVoid = false;
      const typeNode = path.node.init.returnType;
      try {
        if (typeNode && typeNode.type !== "Noop") {
          isVoid = typeNode.typeAnnotation.type === "TSVoidKeyword";
          returnType = this._getTypeRefFromAstNode(typeNode, path.node.init);
        }
      } catch {
        if (!isVoid) {
          // !!! console.debug('Unsupported return type for function "' + name + '".');
        }
      }
      const init = path.node.init;
      if (!path.node.range) {
        throw new Error("Source code ranges missing in AST");
      }
      return {
        name,
        module: this._filename,
        src: parent.node.kind + " " + this._src.slice(...path.node.range),
        startOffset: path.node.range[0],
        endOffset: path.node.range[1],
        isExported: parent.parent.type === "ExportNamedDeclaration",
        args: path.node.init.params
          .filter((arg) => arg.type === "Identifier")
          .map((arg) => this._getTypeRefFromAstNode(arg, init)),
        returnType,
        isVoid,
        cmt: this.getFunctionComment(path),
      };
    } else if (
      // Standard Function Definition: function xyz(): void => { ... }
      path.isFunctionDeclaration() &&
      !isBlockScoped(path) // ignore inner functions
    ) {
      // ReturnType is not as important for fuzzing, so we don't throw an error
      // if we encounter something we don't support.
      let returnType = undefined;
      let isVoid = false;
      const typeNode = path.node.returnType;
      if (!path.node.range) {
        throw new Error("Source code ranges missing in AST");
      }
      try {
        if (typeNode && typeNode.type !== "Noop") {
          isVoid = typeNode.typeAnnotation.type === "TSVoidKeyword";
          returnType = this._getTypeRefFromAstNode(typeNode, path.node);
        }
      } catch {
        if (!isVoid) {
          // !!! console.debug('Unsupported return type for function "' + name + '".');
        }
      }
      return {
        name,
        module: this._filename,
        src: this._src.slice(...path.node.range),
        startOffset: path.node.range[0],
        endOffset: path.node.range[1],
        isExported: parent ? parent.type === "ExportNamedDeclaration" : false,
        args: path.node.params
          .filter((arg) => arg.type === "Identifier")
          .map((arg) => this._getTypeRefFromAstNode(arg, path.node)),
        returnType,
        isVoid,
        cmt: this.getFunctionComment(path),
      };
    }
  } // fn: _getFunctionFromNode()

  /**
   * Returns the function's leading comment, if it exists. This is
   * determined by traversing the AST upward from the node where
   * the function is declared.
   *
   * @param `path` function declaration node
   * @returns the leading comment, if found; `undefined` otherwise
   */
  protected getFunctionComment(
    path: NodePath<VariableDeclarator | FunctionDeclaration>
  ): string | undefined {
    let thisPath: NodePath<Node> = path;
    while (
      thisPath.isVariableDeclaration() ||
      thisPath.isVariableDeclarator() ||
      thisPath.isExportNamedDeclaration() ||
      thisPath.isFunctionDeclaration()
    ) {
      if (thisPath.node.leadingComments) {
        return (
          thisPath.node.leadingComments
            .filter((c) => c.type === "CommentBlock")
            .map((c) => `/*${c.value}*/`)
            .join("/n") || undefined
        );
      } else {
        thisPath = thisPath.parentPath;
      }
    }
    return undefined;
  } // fn: getFunctionComment
} // class: TypescriptProgram

/**
 * Gets a qualified identifier name for a given entity node
 *
 * @param node The node to get the identifier name for
 * @returns Qualified name as a string
 */
function getIdentifierName(node: TSEntityName): string {
  switch (node.type) {
    case "Identifier": {
      return node.name;
    }
    case "TSQualifiedName": {
      return getIdentifierName(node.left) + "." + node.right.name;
    }
  }
} // fn: getIdentifierName()

/**
 * Determines whether an AST node is block scoped
 * Note: Requires that nodes have the parent property set
 *
 * @param `node` The node to check
 * @returns `true` if the node is block scoped, `false` otherwise
 */
function isBlockScoped(node: NodePath<Node>): boolean {
  let thisNode = node;
  while (thisNode.parentPath) {
    if (thisNode.parentPath.node.type === "BlockStatement") {
      return true; // block scoped
    } else {
      thisNode = thisNode.parentPath; // move up the tree
    }
  }
  return false; // at root; block not encountered
} // fn: isBlockScoped()
