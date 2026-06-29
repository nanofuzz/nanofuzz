import { ArgDef } from "./ArgDef";
import { FunctionDef } from "./FunctionDef";
import {
  FunctionRef,
  IdentifierName,
  ProgramImports,
  ProgramPath,
  TypeRef,
  ArgOptions,
  ProgramImport,
} from "./Types";
import { getErrorMessageOrJson } from "../Util";
import { ProgramLanguage } from "./ProgramFactory";

/**
 * The AbstractProgram class represents a program definition in a source
 * file. It provides abstract methods for extracting information about the
 * functions and types defined by the program, which are represented by the
 * FunctionDef and TypeDef classes.
 *
 * Extending support for specific programming languages is achieved, first,
 * by implementing a language-specific concrete class that extends this one.
 */
export abstract class AbstractProgram {
  public static readonly lang: ProgramLanguage = "*"; // Must override!
  public static readonly extensions: readonly string[] = []; // Must override!

  protected _filename: string; // Path to the module source file
  protected _src: string; // Source code of the program
  protected _options: ArgOptions; // Arg options for the program
  protected _getSource: () => string; // Function to retrieve the source code

  protected _root: AbstractProgram; // Root program
  protected _parents: Record<ProgramPath, AbstractProgram> = {}; // Parent programs
  protected _children: Record<ProgramPath, AbstractProgram> = {}; // Child programs
  protected _allChildren: Record<ProgramPath, AbstractProgram> = {}; // All children of children (if root)
  protected _functions: {
    supported: Record<IdentifierName, FunctionRef>;
    unsupported: Record<
      IdentifierName,
      {
        reason: string;
      } & (
        | {
            // Functions that are unsupported due to an argument type that could not be resolved
            argument?: IdentifierName;
            function: FunctionRef;
          }
        | {
            // Functions that are supported due to being unrepresentable using FunctionRef,
            // e.g., use of unsupported types
            node: string; // AST Node Representation
          }
      )
    >;
  } = { supported: {}, unsupported: {} }; // Functions defined
  protected _functionCache: Record<IdentifierName, FunctionDef> = {}; // Cached FunctionDef objects
  protected _exports: {
    functions: Record<IdentifierName, FunctionRef>;
    types: Record<IdentifierName, TypeRef>;
    default?: TypeRef;
  } = { functions: {}, types: {} }; // Supported exports of the program
  protected _types: Record<IdentifierName, TypeRef> = {}; // Types defined in the program
  protected _imports: ProgramImports = { programs: {}, identifiers: {} }; // Imported modules

  /**
   * Constructs a new ProgramDef instance using a FunctionRef object.
   * and optional set of options.
   *
   * @param src Source of the program to be analyzed
   * @param path Path to the source file (optional)
   * @param options Options for the function analysis (optional)
   * @param parent Parent program (if not provided, this program becomes the root node)
   */
  constructor(
    getSource: () => string,
    filename: string,
    options?: ArgOptions,
    parent?: AbstractProgram
  ) {
    // Setup program information
    this._filename = filename;
    this._getSource = getSource;
    this._src = getSource();
    this._options = options ?? ArgDef.getDefaultOptions();

    // Make sure we're not adding this module to the hierarchy twice
    if (parent && this._filename in parent._root._allChildren) {
      throw new Error(
        `Internal error: module already exists in ProgramDef hierarchy (${filename})`
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
    this._parse(this._src);

    // Retrieve the imports defined in this program
    this._imports = this._findImports();

    // Extract local types
    this._types = this._findTypes();
    for (const name in this._types) {
      if (this._types[name].isExported) {
        this._exports.types[name] = this._types[name];
      }
    }

    // Extract local functions
    this._functions = this._findFunctions();
    for (const name in this._functions.supported) {
      if (this._functions.supported[name].isExported) {
        this._exports.functions[name] = this._functions.supported[name];
      }
    }

    // Retrieve the default type export, if it exists
    // (we don't look for other default exports at this time)
    this._exports.default = this._findDefaultTypeExport();

    // If this is the root program, resolve all the imports that we need
    if (this._root === this) {
      for (const fnRef of Object.values(this._functions.supported)) {
        let lastArgName: string | undefined;
        try {
          // Attempt to resolve function argument types
          // Note: failure to resolve any argument makes fn unsupported
          if (fnRef.args) {
            for (const fnArg of fnRef.args) {
              lastArgName = fnArg.name;
              this._resolveTypeRef(fnArg);
            }
          }
        } catch (e: unknown) {
          const msg = getErrorMessageOrJson(e);
          console.debug(
            `Error resolving types for function '${fnRef.name}' argument '${
              lastArgName ?? "(unknown)"
            }'; marking fn as unsupported. Reason: ${msg}`
          );

          // Remove functions that we couldn't resolve
          this._functions.unsupported[fnRef.name] = {
            reason: msg,
            argument: lastArgName,
            function: fnRef,
          };
          delete this._functions.supported[fnRef.name];
          delete this._exports.functions[fnRef.name];
        }
        // Attempt to resolve function return types
        // Note: failure to resolve return type does not make function unsupported
        try {
          if (fnRef.returnType) {
            lastArgName = "return";
            this._resolveTypeRef(fnRef.returnType);
          }
        } catch (e: unknown) {
          console.debug(
            `Error resolving return type for function '${
              fnRef.name
            }'; Reason: ${getErrorMessageOrJson(e)}`
          );
        }
      }
    }
    this._afterLoad();
  } // end constructor

  // !!!!!!
  public static understands(details: {
    filename?: string;
    lang?: ProgramLanguage;
  }): boolean {
    if (details.lang === this.lang) {
      return true;
    }
    if (details.filename !== undefined) {
      for (const ext of this.extensions) {
        if (details.filename.endsWith(ext)) {
          return true;
        }
      }
    }
    return false;
  }

  // !!!!!!
  public find(filename: string): AbstractProgram | undefined {
    if (filename in this._root._allChildren) {
      return this._root._allChildren[filename];
    } else {
      return undefined;
    }
  }

  protected abstract _parse(src: string): void;

  protected abstract _findImports(): ProgramImports;

  protected abstract _findTypes(): Record<IdentifierName, TypeRef>;

  protected abstract _findFunctions(): typeof this._functions;

  protected abstract _findDefaultTypeExport(): TypeRef | undefined;

  public abstract _resolveTypeRef(t: TypeRef): TypeRef;

  public abstract get lang(): ProgramLanguage;

  public abstract get extensions(): readonly string[];

  protected _afterLoad(): void {}

  /**
   * Returns the root object for this hierarchy
   *
   * @returns The root program object
   */
  public get root(): AbstractProgram {
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
  protected _addChild(child: AbstractProgram): void {
    child._parents[child._filename] = child;
    this._children[child._filename] = child;
    this._root._allChildren[child._filename] = child;
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
  public get src(): string {
    return this._src;
  } // fn: get src()

  /**
   * Returns the module filename where the function is defined
   *
   * @returns the module filename where the function is defined
   */
  public get filename(): string {
    return this._filename;
  } // fn: get filename()

  /**
   * Returns the module filename where the function is defined
   *
   * @returns the options for this program
   */
  public get options(): ArgOptions {
    return this._options;
  } // fn: get options()

  /**
   * Returns this program's imports
   *
   * @returns the list of imports by identifier name
   */
  public get imports(): Record<IdentifierName, ProgramImport> {
    return structuredClone(this._imports.identifiers);
  } // fn: get imports()

  /**
   * Returns supported functions defined in the program
   *
   * @returns the functions defined in the program
   */
  public get functions(): Record<IdentifierName, FunctionDef> {
    const ret: Record<IdentifierName, FunctionDef> = {};
    for (const [key, value] of Object.entries(this._functions.supported)) {
      if (!(key in this._functionCache)) {
        this._functionCache[key] = FunctionDef.fromFunctionRef(
          value,
          this._options
        );
      }
      ret[key] = this._functionCache[key];
    }
    return ret;
  } // fn: get functions()

  /**
   * Returns only the functions exported by the program
   *
   * @returns the functions exported by the program
   */
  public get functionsExported(): Record<IdentifierName, FunctionDef> {
    const ret: Record<IdentifierName, FunctionDef> = {};
    for (const [key, value] of Object.entries(this._exports.functions)) {
      if (!(key in this._functionCache)) {
        this._functionCache[key] = FunctionDef.fromFunctionRef(
          value,
          this._options
        );
      }
      ret[key] = this._functionCache[key];
    }
    return ret;
  } // fn: get functionsExported()

  /**
   * Returns the types defined in the program
   *
   * @returns the types defined in the program
   */
  public get types(): Record<string, TypeRef> {
    return structuredClone(this._types);
  } // fn: get types()

  /**
   * Returns the types exported by the program
   *
   * @returns the types exported by the program
   */
  public get typesExported(): Record<string, TypeRef> {
    return structuredClone(this._exports.types);
  } // fn: get typesExported()

  /**
   * Returns the default type export, if it exists.
   *
   * @returns the default type export or `undefined` if it does not exist
   */
  public get defaultExport(): TypeRef | undefined {
    return structuredClone(this._exports.default);
  } // fn: get defaultExport()
} // class: AbstractProgram
