import * as JSON5 from "json5";
import { ArgDef } from "./ArgDef";
import { FunctionDef } from "./FunctionDef";
import { getIdentifierName, isBlockScoped, removeParents } from "./Util";
import {
  AST_NODE_TYPES,
  AST,
  parse,
  simpleTraverse,
} from "@typescript-eslint/typescript-estree";
import {
  TSTypeAliasDeclaration,
  TSTypeAnnotation,
  Identifier,
  TSPropertySignature,
  TypeNode,
} from "@typescript-eslint/types/dist/ast-spec";
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
  ProgramImport,
} from "./Types";

/**
 * The ProgramDef class represents a program definition in a TypeScript source
 * file. It provides methods for extracting information about the functions
 * and types defined by the program, which are represented by the FunctionDef
 * and TypeDef classes.
 *
 * Limitations of the current implementation
 * - Only top-level functions and types are supported
 * - Requires type-annotated TypeScript program source
 * - Anonymous functions are not supported
 * - Re-exported functions are not supported
 * - Default imports/exports are limited to named type definitions
 * - Analysis of classes and class methods are not supported
 */
export class ProgramDef {
  private _module: string; // Path to the module source file
  private _src: string; // Source code of the program
  private _options: ArgOptions; // Arg options for the program
  private _getSource: () => string; // Function to retrieve the source code

  private _root: ProgramDef; // Root program
  private _parents: Record<ProgramPath, ProgramDef> = {}; // Parent programs
  private _children: Record<ProgramPath, ProgramDef> = {}; // Child programs
  private _allChildren: Record<ProgramPath, ProgramDef> = {}; // All children of children (if root)

  private _functions: Record<IdentifierName, FunctionRef> = {}; // Functions defined in the program
  private _unsupportedFunctions: Record<
    IdentifierName,
    { reason: string; argument?: IdentifierName; function: FunctionRef }
  > = {}; // Functions defined but not supported
  private _functionCache: Record<IdentifierName, FunctionDef> = {}; // Cached FunctionDef objects
  private _exportedFunctions: Record<IdentifierName, FunctionRef> = {}; // Functions exported by the program
  private _types: Record<IdentifierName, TypeRef> = {}; // Types defined in the program
  private _exportedTypes: Record<IdentifierName, TypeRef> = {}; // Types exported by the program
  private _defaultExport: TypeRef | undefined; // Default type export, if any
  private _imports: ProgramImports = { programs: {}, identifiers: {} }; // Imported modules

  /**
   * Constructs a new ProgramDef instance using a FunctionRef object.
   * and optional set of options.
   *
   * @param src Source of the program to be analyzed
   * @param path Path to the source file (optional)
   * @param options Options for the function analysis (optional)
   */
  private constructor(
    getSource: () => string,
    module: string,
    options?: ArgOptions,
    parent?: ProgramDef
  ) {
    // Setup program information
    this._module = module;
    this._getSource = getSource;
    this._src = getSource();
    this._options = options ?? ArgDef.getDefaultOptions();

    // Make sure we're not adding this module to the hierarchy twice
    if (parent && this._module in parent._root._allChildren) {
      throw new Error(
        `Internal error: module already exists in ProgramDef hierarchy (${module})`
      );
    }

    // Setup inter-program relationships
    if (parent) {
      this._root = parent._root;
      parent._addChild(this);
    } else {
      this._root = this;
    }

    // Parse the program source to generate the AST
    const ast = parse(this._src, { range: true });

    // Retrieve the imports defined in this program
    this._imports = this._findImports(ast);

    // Extract local types
    this._types = this._findTypes(ast);
    for (const name in this._types) {
      if (this._types[name].isExported) {
        this._exportedTypes[name] = this._types[name];
      }
    }

    // Extract local functions
    this._functions = this._findFunctions(ast);
    for (const name in this._functions) {
      if (this._functions[name].isExported) {
        this._exportedFunctions[name] = this._functions[name];
      }
    }

    // Retrieve the default type export, if it exists
    // (we don't look for other default exports at this time)
    this._defaultExport = this._findDefaultTypeExport(ast);

    // If this is the root program, resolve all the imports that we need
    if (this._root === this) {
      for (const fnRef of Object.values(this._functions)) {
        let lastArgName: string | undefined;
        try {
          if (fnRef.args) {
            for (const fnArg of fnRef.args) {
              lastArgName = fnArg.name;
              if (fnArg.typeRefName && !fnArg.type) {
                this._resolveTypeRef(fnArg);
              }
            }
          }
        } catch (e: any) {
          console.debug(
            `Error resolving types for function '${fnRef.name}' argument '${
              lastArgName ?? "(unknown)"
            }'; marking fn as unsupported. Reason: ${e.message}`
          );

          // Remove functions that we couldn't resolve
          this._unsupportedFunctions[fnRef.name] = {
            reason: e.message,
            argument: lastArgName,
            function: fnRef,
          };
          delete this._functions[fnRef.name];
          delete this._exportedFunctions[fnRef.name];
        }
      }
    }
  } // end constructor

  /**
   * Returns a ProgramDef object for the given module.
   * Note: Uses a caching strategy
   *
   * @param module Path of the module to load
   * @param options Argument options
   * @param parent Parent ProgramDef parent object
   * @returns A ProgramDef object
   */
  public static fromModule(
    module: string,
    options?: ArgOptions,
    parent?: ProgramDef
  ): ProgramDef {
    module = require.resolve(module);
    const getSource = () => fs.readFileSync(module).toString(); // Callback fn to read the source code

    return ProgramDef.fromModuleAndSource(module, getSource, options, parent);
  } // fn: fromModule()

  /**
   * Returns a ProgramDef object for the given source code.
   * Note: Uses a caching strategy
   *
   * @param src Source code for the module
   * @param options Argument options
   * @returns A ProgramDef object
   */
  public static fromSource(
    getSource: () => string,
    options?: ArgOptions,
    parent?: ProgramDef
  ): ProgramDef {
    return ProgramDef.fromModuleAndSource("", getSource, options, parent);
  } // fn: fromSource()

  /**
   * Returns a ProgramDef object for the given module.
   * Note: Uses a caching strategy
   *
   * @param module Path of the module to load
   * @param src Source code for the module
   * @param options Argument options
   * @returns A ProgramDef object
   */
  public static fromModuleAndSource(
    module: string,
    getSource: () => string,
    options?: ArgOptions,
    parent?: ProgramDef
  ): ProgramDef {
    module = require.resolve(module);

    // If a ProgramDef already exists within this program hierarchy,
    // return it. Otherwise, create a new one
    if (parent && module in parent._root._allChildren) {
      return parent._root._allChildren[module];
    } else {
      return new ProgramDef(getSource, module, options, parent);
    }
  } // fn: fromModule()

  /**
   * Returns the root ProgramDef object for this hierarchy
   *
   * @returns The root ProgramDef object
   */
  public getRoot(): ProgramDef {
    return this._root;
  } // fn: getRoot()

  /**
   * Returns true if this is the root ProgramDef object
   *
   * @returns true if this is the root ProgramDef object
   */
  public isRoot(): boolean {
    return this._root === this;
  } // fn: isRoot()

  /**
   * Adds a child program to the current ProgramDef node
   *
   * @param child The child to add to this node
   */
  private _addChild(child: ProgramDef): void {
    child._parents[child._module] = child;
    this._children[child._module] = child;
    this._root._allChildren[child._module] = child;
  } // fn: addChild()

  /**
   * Returns true if the source code for any program in the hierarchy
   * has changed since the hierarchty was built.
   *
   * @returns true if the program does not match the file system
   */
  public isStale(): boolean {
    // Check each program in the hierarchy
    for (const program of Object.values(this._root._allChildren)) {
      if (program._getSource() !== program._src) {
        return true; // Change detected
      }
    }
    return false; // No changes/staleness detected
  } // fn: _isStale()

  /**
   * Returns the function's source code
   *
   * @returns Source code of the function
   */
  public getSrc(): string {
    return this._src;
  } // fn: getSrc()

  /**
   * Returns a new ProgramDef with the given source code.
   * May only be executed on a ProgramDef where isRoot() === true.
   *
   * @returns new ProgramDef object
   */
  public setSrc(getSource: () => string): ProgramDef {
    // Requires this be a root node
    if (!this.isRoot()) {
      throw new Error(
        `Cannot change module of non-root program (${this._module})`
      );
    }
    return new ProgramDef(getSource, this._module, this._options);
  } // fn: setSrc()

  /**
   * Returns the module filename where the function is defined
   *
   * @returns the module filename where the function is defined
   */
  public getModule(): string {
    return this._module;
  } // fn: getModule()

  /**
   * Returns a new ProgramDef with the given options code
   * May only be executed on a ProgramDef where isRoot() === true.
   *
   * @returns new ProgramDef object
   */
  public setModule(module: string): ProgramDef {
    // Requires this be a root node.
    if (!this.isRoot()) {
      throw new Error(
        `Cannot change module of non-root program (${this._module})`
      );
    }
    return new ProgramDef(this._getSource, module, this._options);
  } // fn: setModule()

  /**
   * Returns the module filename where the function is defined
   *
   * @returns the options for this program
   */
  public getOptions(): ArgOptions {
    return this._options;
  } // fn: getOptions()

  /**
   * Returns a new ProgramDef with the given options
   * May only be executed on a ProgramDef where isRoot() === true.
   *
   * @returns new ProgramDef object
   */
  public setOptions(options: ArgOptions): ProgramDef {
    // Requires this be a root node
    if (!this.isRoot()) {
      throw new Error(
        `Cannot change module of non-root program (${this._module})`
      );
    }
    return new ProgramDef(this._getSource, this._module, options);
  } // fn: setOptions()

  /**
   * Returns this program's imports
   *
   * @returns the list of imports by identifier name
   */
  public getImports(): Record<IdentifierName, ProgramImport> {
    return JSON5.parse(JSON5.stringify(this._imports));
  } // fn: getImports()

  /**
   * Returns the functions defined in the program
   *
   * @returns the functions defined in the program
   */
  public getFunctions(): Record<IdentifierName, FunctionDef> {
    const ret: Record<IdentifierName, FunctionDef> = {};
    for (const [key, value] of Object.entries(this._functions)) {
      if (!(key in this._functionCache)) {
        this._functionCache[key] = FunctionDef.fromFunctionRef(
          value,
          this._options
        );
      }
      ret[key] = this._functionCache[key];
    }
    return ret;
  } // fn: getFunctions()

  /**
   * Returns the functions exported by the program
   *
   * @returns the functions exported by the program
   */
  public getExportedFunctions(): Record<IdentifierName, FunctionDef> {
    const ret: Record<IdentifierName, FunctionDef> = {};
    for (const [key, value] of Object.entries(this._exportedFunctions)) {
      if (!(key in this._functionCache)) {
        this._functionCache[key] = FunctionDef.fromFunctionRef(
          value,
          this._options
        );
      }
      ret[key] = this._functionCache[key];
    }
    return ret;
  } // fn: getExportedFunctions()

  /**
   * Returns the types defined in the program
   *
   * @returns the types defined in the program
   */
  public getTypes(): Record<string, TypeRef> {
    return JSON5.parse(JSON5.stringify(this._types));
  } // fn: getTypes()

  /**
   * Returns the types exported by the program
   *
   * @returns the types exported by the program
   */
  public getExportedTypes(): Record<string, TypeRef> {
    return JSON5.parse(JSON5.stringify(this._exportedTypes));
  } // fn: getExportedTypes()

  /**
   * Returns the imports defined in the program
   *
   * @param ast The parsed AST for the program
   * @returns A record of the imports defined in the program
   */
  private _findImports(
    ast: AST<{
      range: true;
    }>
  ): ProgramImports {
    const imports: ProgramImports = { programs: {}, identifiers: {} };

    simpleTraverse(
      ast,
      {
        enter: (node) => {
          switch (node.type) {
            case AST_NODE_TYPES.ImportDeclaration: {
              if (typeof node.source.value === "string") {
                // Resolve the import module
                const importModulePath = this._resolveImportModule(
                  node.source.value
                );

                // Loop over all the imports specified
                node.specifiers.forEach((specifier) => {
                  switch (specifier.type) {
                    // import { foo } from "bar";
                    case AST_NODE_TYPES.ImportSpecifier: {
                      imports.identifiers[specifier.local.name] = {
                        local: specifier.local.name,
                        imported: specifier.imported.name,
                        programPath: importModulePath,
                        resolved: true,
                        default: false,
                      };
                      imports.programs[importModulePath] = "?";
                      break;
                    }
                    // import * as foo from "bar";
                    case AST_NODE_TYPES.ImportNamespaceSpecifier: {
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
                    case AST_NODE_TYPES.ImportDefaultSpecifier: {
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
      },
      true // set parent pointers
    ); // traverse AST
    return imports;
  } // fn: findImports()

  /**
   * Accepts a program AST and returns a default type export if defined
   * in the program.
   *
   * We don't support literal or function exports here. Just types, and
   * the usual limitations from elsewhere still apply (no OR types, etc).
   *
   * @param ast Program AST
   * @returns A default export, if found
   */
  private _findDefaultTypeExport(
    ast: AST<{
      range: true;
    }>
  ): TypeRef | undefined {
    const module = this._module;
    let defaultExport: TypeRef | undefined;

    // Traverse the AST and find top-level type alias declarations
    simpleTraverse(
      ast,
      {
        enter: (node) => {
          switch (node.type) {
            // Implicit defaults:
            //   - export {x as default};
            case AST_NODE_TYPES.ExportNamedDeclaration: {
              node.specifiers.forEach((specifier) => {
                if (specifier.exported.name === "default") {
                  // build and return the type reference
                  switch (specifier.local.type) {
                    case AST_NODE_TYPES.Identifier: {
                      defaultExport = {
                        isExported: true,
                        optional: false,
                        dims: 0,
                        module: module,
                        name: "default",
                        typeRefName: specifier.local.name,
                      };
                      return; // enter function
                    }
                    default: {
                      console.debug(
                        `Unsupported implicit default export specifier '${specifier.local.type}' in module '${module}'`
                      );
                    }
                  }
                }
              });
              break;
            }

            // Explicit default:
            //   - export default x;
            case AST_NODE_TYPES.ExportDefaultDeclaration: {
              switch (node.declaration.type) {
                case AST_NODE_TYPES.Identifier: {
                  defaultExport = {
                    isExported: true,
                    optional: false,
                    dims: 0,
                    module: module,
                    name: "default",
                    typeRefName: node.declaration.name,
                  };
                  return; // enter function
                }
                default: {
                  console.debug(
                    `Unsupported explicit default export type '${node.declaration.type}' in module '${module}'`
                  );
                }
              }
              break;
            }
          }
        }, // enter
      },
      true // set parent pointers
    ); // traverse AST

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
  private _findTypes(
    ast: AST<{
      range: true;
    }>
  ): Record<IdentifierName, TypeRef> {
    const module = this._module;

    // List of nodes
    const types: Record<string, TypeRef> = {};

    // Traverse the AST and find top-level type alias declarations
    simpleTraverse(
      ast,
      {
        enter: (node) => {
          // Find type alias declarations
          if (node.type === AST_NODE_TYPES.TSTypeAliasDeclaration) {
            // Skip any block scoped type alias declarations
            if (!isBlockScoped(node)) {
              // Throw an error for duplicate type aliases
              if (node.id.name in types) {
                throw new Error(
                  `Duplicate type alias '${node.id.name}' found in module '${module}'`
                );
              } else {
                types[node.id.name] = this._getTypeRefFromAstNode(node);
              }
            }
          }
        }, // enter
      },
      true // set parent pointers
    ); // traverse AST

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
  private _resolveTypeRef(typeRef: TypeRef): TypeRef {
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
      typeRef.type = JSON5.parse(JSON5.stringify(resolvedType.type));
      return this._types[typeRef.typeRefName];
    } else {
      // Follow the imported type reference
      // Split the local name into parts (e.g., "foo.bar" => ["foo", "bar"])
      // TODO: This should be more flexible
      const localNameParts = typeRef.typeRefName.split(".");

      // Lookup the import reference
      if (!(localNameParts[0] in this._imports.identifiers)) {
        throw new Error(
          `Internal error: ${this._module} did not find local import ${localNameParts[0]}`
        );
      }
      const importRef = this._imports.identifiers[localNameParts[0]];

      // Get the imported module
      const importProgram = ProgramDef.fromModule(
        importRef.programPath,
        this._options,
        this
      );

      // Resolve unresolved imports
      if (!importRef.resolved) {
        if (importRef.default) {
          // Default import: create one default import
          importRef.resolved = true;
          if (
            importProgram._defaultExport !== undefined &&
            importProgram._defaultExport.name
          ) {
            importRef.imported = importProgram._defaultExport.name;
          } else {
            throw new Error(
              `Unable to find default type export in module '${importProgram._module}' when processing imports for module '${this._module}'`
            );
          }
        } else {
          // Namespace import: create concrete imports for each of the imports
          for (const exported of Object.values(importProgram._exportedTypes)) {
            const localName = localNameParts[0] + "." + exported.name;
            const newImport = JSON5.parse(JSON5.stringify(exported));
            newImport.local = localName;
            newImport.imported = exported.name;
            newImport.resolved = true;
            this._imports.identifiers[localName] = newImport;
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

        if (defaultImport && importProgram._defaultExport) {
          // Resolve default export
          const resolvedType = importProgram._resolveTypeRef(
            importProgram._defaultExport
          );
          typeRef.type = JSON5.parse(JSON5.stringify(resolvedType.type));
        } else if (importName in importProgram._exportedTypes) {
          // Resolve named export
          const resolvedType = importProgram._resolveTypeRef(
            importProgram._exportedTypes[importName]
          );
          typeRef.type = JSON5.parse(JSON5.stringify(resolvedType.type));
        } else {
          // Unable to find exported type
          throw new Error(
            `Unable to find exported type '${importName}' in module '${importProgram._module}' when processing imports for module '${this._module}`
          );
        }
      } else {
        throw new Error(
          `Internal error: ${this._module} did not find import: ${typeRef.typeRefName}`
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
  private _resolveImportModule(importModule: string): ProgramPath {
    const extensions = [".ts", ".d.ts", ""];

    // Resolve imports relative to the current module
    // Try to resolve each extension
    for (const ext of extensions) {
      try {
        if (importModule.startsWith(".")) {
          // Resolve the module relative to the current module
          const resolved = path.resolve(
            path.dirname(this._module),
            importModule + ext
          );

          // Only return if we find the module (if not, retry)
          if (fs.existsSync(resolved)) {
            return resolved;
          }
        } else {
          const resolved = require.resolve(importModule + ext, {
            paths: [path.dirname(this._module)], // Resolve from the importing module's path
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
      } catch (e) {
        // Eat the exception & retry
      }
    } // for: each extension

    // Throw an exception if we did not resolve the import
    throw new Error(
      `Unable to resolve import from: '${
        this._module
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
  private _getTypeRefFromAstNode(
    node: Identifier | TSPropertySignature | TSTypeAliasDeclaration
  ): TypeRef {
    // Throw an error if type annotations are missing
    if (node.typeAnnotation === undefined) {
      throw new Error(
        `Missing type annotation (already transpiled to JS?): ${JSON5.stringify(
          node,
          removeParents
        )}`
      );
    }

    // Add the type alias to the running list
    const thisType: TypeRef = {
      module: this._module,
      dims: 0, // override later if needed
      optional: false, // override later if needed
      isExported:
        node.parent?.type === AST_NODE_TYPES.ExportNamedDeclaration ||
        node.parent?.type === AST_NODE_TYPES.TSModuleBlock,
    };

    // Determine the node name
    switch (node.type) {
      case AST_NODE_TYPES.TSPropertySignature: {
        if (node.key.type === AST_NODE_TYPES.Identifier) {
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
      case AST_NODE_TYPES.Identifier: {
        thisType.name = node.name;
        break;
      }
      case AST_NODE_TYPES.TSTypeAliasDeclaration: {
        thisType.name = node.id.name;
        break;
      }
    }

    // Determine whether the argument is optional (TSTypeAliasDeclarations don't have this)
    thisType.optional = "optional" in node && (node.optional ?? false);

    // Handle type references, which we will resolve later
    //
    // Note: this does not catch arrays of type references;
    // we handle those below)
    if (node.typeAnnotation.type === AST_NODE_TYPES.TSTypeReference) {
      thisType.typeRefName = getIdentifierName(node.typeAnnotation.typeName);
    } else {
      // Get the node's type and dimensions
      const [type, dims, typeRefNode] = this._getTypeFromAstNode(
        node.typeAnnotation,
        this._options
      );
      thisType.dims = dims;

      // Create the TypeRef data structure
      switch (type) {
        case ArgTag.STRING:
        case ArgTag.BOOLEAN:
        case ArgTag.NUMBER: {
          thisType.type = {
            type: type,
            children: [],
            resolved: true,
          };
          break;
        }
        case ArgTag.OBJECT: {
          thisType.type = {
            type: type,
            children: this._getChildrenFromNode(node.typeAnnotation),
          };
          break;
        }
        case ArgTag.UNRESOLVED: {
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
   * @returns The type tag, number of dimensions, and type reference name
   */
  private _getTypeFromAstNode(
    node: TSTypeAnnotation | TypeNode,
    options: ArgOptions
  ): [ArgTag, number, string?] {
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
        return this._getTypeFromAstNode(node.typeAnnotation, options);
      case AST_NODE_TYPES.TSTypeLiteral:
        return [ArgTag.OBJECT, 0];
      case AST_NODE_TYPES.TSArrayType: {
        const [type, dims, typeName] = this._getTypeFromAstNode(
          node.elementType,
          options
        );
        return [type, dims + 1, typeName];
      }
      case AST_NODE_TYPES.TSTypeReference: {
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
   * Returns the child TypeRef objects for the given AST type node.
   *
   * @param node The AST type node or type annotation
   * @returns An array of child TypeRef objects
   */
  private _getChildrenFromNode(node: TSTypeAnnotation | TypeNode): TypeRef[] {
    switch (node.type) {
      case AST_NODE_TYPES.TSAnyKeyword:
      case AST_NODE_TYPES.TSStringKeyword:
      case AST_NODE_TYPES.TSBooleanKeyword:
      case AST_NODE_TYPES.TSNumberKeyword:
        return [];
      case AST_NODE_TYPES.TSArrayType:
        return this._getChildrenFromNode(node.elementType);
      case AST_NODE_TYPES.TSTypeReference:
        throw new Error(
          `Internal Error: Unresolved type reference found: ${JSON5.stringify(
            node,
            removeParents
          )}`
        );
      case AST_NODE_TYPES.TSTypeLiteral: {
        return node.members.map((member) => {
          if (member.type === AST_NODE_TYPES.TSPropertySignature)
            return this._getTypeRefFromAstNode(member);
          else
            throw new Error(
              "Unsupported object property type annotation: " +
                JSON5.stringify(member, removeParents, 2)
            );
        });
      }
      case AST_NODE_TYPES.TSTypeAnnotation: {
        // Collapse array annotations -- we previously handled those
        while (node.typeAnnotation.type === AST_NODE_TYPES.TSArrayType)
          node.typeAnnotation = node.typeAnnotation.elementType;

        switch (node.typeAnnotation.type) {
          case AST_NODE_TYPES.TSTypeReference: {
            const typeName = getIdentifierName(node.typeAnnotation.typeName);
            throw new Error(
              `Internal Error: Unable to find type reference '${typeName}' in program`
            );
          }
          case AST_NODE_TYPES.TSTypeLiteral: {
            return node.typeAnnotation.members.map((member) => {
              if (member.type === AST_NODE_TYPES.TSPropertySignature)
                return this._getTypeRefFromAstNode(member);
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
                JSON5.stringify(node.typeAnnotation, removeParents, 2)
            );
        }
      }
      default:
        throw new Error(
          "Unsupported type annotation: " +
            JSON5.stringify(node, removeParents, 2)
        );
    }
  } // fn: _getChildrenFromNode()

  /**
   * Returns a dictionary of top-level named functions defined in the program
   *
   * @param ast Program AST
   * @returns A dictionary of top-level named functions defined in the program
   */
  private _findFunctions(
    ast: AST<{
      range: true;
    }>
  ): Record<IdentifierName, FunctionRef> {
    const ret: Record<IdentifierName, FunctionRef> = {};

    // Traverse the AST to find function definitions
    simpleTraverse(
      ast,
      {
        enter: (node, parent) => {
          try {
            if (
              // Arrow Function Definition: const xyz = (): void => { ... }
              node.type === AST_NODE_TYPES.VariableDeclarator &&
              parent !== undefined &&
              parent.type === AST_NODE_TYPES.VariableDeclaration &&
              node.init &&
              node.init.type === AST_NODE_TYPES.ArrowFunctionExpression &&
              node.id.type === AST_NODE_TYPES.Identifier &&
              !isBlockScoped(node)
            ) {
              ret[node.id.name] = {
                name: node.id.name,
                module: this._module,
                src:
                  parent.kind +
                  " " +
                  this._src.substring(node.range[0], node.range[1]),
                startOffset: node.range[0],
                endOffset: node.range[1],
                isExported: parent.parent
                  ? parent.parent.type === AST_NODE_TYPES.ExportNamedDeclaration
                  : false,
                args: node.init.params
                  .filter((arg) => arg.type === AST_NODE_TYPES.Identifier)
                  .map((arg) => this._getTypeRefFromAstNode(arg as Identifier)),
              };
            } else if (
              // Standard Function Definition: function xyz(): void => { ... }
              node.type === AST_NODE_TYPES.FunctionDeclaration &&
              node.id !== null &&
              !isBlockScoped(node)
            ) {
              ret[node.id.name] = {
                name: node.id.name,
                module: this._module,
                src: this._src.substring(node.range[0], node.range[1]),
                startOffset: node.range[0],
                endOffset: node.range[1],
                isExported: parent
                  ? parent.type === AST_NODE_TYPES.ExportNamedDeclaration
                  : false,
                args: node.params
                  .filter((arg) => arg.type === AST_NODE_TYPES.Identifier)
                  .map((arg) => this._getTypeRefFromAstNode(arg as Identifier)),
              };
            }
          } catch (e: any) {
            console.warn(
              `Error processing function '${this._src.substring(
                node.range[0],
                node.range[1]
              )}' in module '${this._module}': ${e.message}`
            );
          }
        },
        // TODO: Add support for class methods
      }, // enter
      true // set parent pointers
    ); // traverse AST

    return ret;
  } // fn: findFunctions()
} // class: ProgramDef
