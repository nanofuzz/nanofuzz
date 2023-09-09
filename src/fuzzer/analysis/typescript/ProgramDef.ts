import { ArgDef, ArgOptions } from "./ArgDef";
import { FunctionDef } from "./FunctionDef";
import { ITypeDef, TypeDef } from "./TypeDef";
import { sha256 } from "./Util";
import {
  AST_NODE_TYPES,
  parse,
  simpleTraverse,
} from "@typescript-eslint/typescript-estree";
import path from "path";
import fs from "fs";

/**
 * The ProgramDef class represents a program definition in a Typescript source
 * file. It provides methods for extracting information about the functions
 * and types defined by the program, which are represented by the FunctionDef
 * and TypeDef classes.
 *
 * Limitations of the current implementation
 * - Does not currently follow or resolve imports !!!!
 * - Only top-level functions and types are supported
 * - Requires type-annotated TypeScript program source
 * - Anonymous functions are not supported
 * - Analysis of classes and class methods are not supported
 */
export class ProgramDef {
  private _module: string; // Path to the module source file
  private _src: string; // Source code of the program
  private _options: ArgOptions; // Arg options for the program

  private _functions: Record<string, FunctionDef> = {}; // Functions defined in the program
  private _types: Record<string, ITypeDef> = {}; // Types defined in the program
  private _imports: Record<string, ProgramImport> = {}; // Imported modules

  // Instances of the program indexed by path and source hash
  private static _instances: Record<string, Record<string, ProgramDef>> = {};

  /**
   * Constructs a new ProgramDef instance using a FunctionRef object.
   * and optional set of options.
   *
   * @param src Source of the program to be analyzed
   * @param path Path to the source file (optional)
   * @param options Options for the function analysis (optional)
   */
  private constructor(src: string, module: string, options?: ArgOptions) {
    this._module = module;
    this._src = src;
    this._options = options ?? ArgDef.getDefaultOptions();

    // Retrieve the imports defined in this program
    this._imports = this.findImports(this._options);
    for (const localName in this._imports) {
      // Error checking here !!!!
      // Rename these types and functions to their local names? !!!!
      // Also, what are the implications b/c the program is different !!!!
      const { program: importProgram, imported: importedName } =
        this._imports[localName];
      const importProgramTypes = importProgram.getTypes();
      const importProgramFunctions = importProgram.getFunctions();

      if (importedName in importProgramTypes) {
        this._types[localName] = importProgramTypes[importedName];
      } else if (importedName in importProgramFunctions) {
        this._functions[localName] = importProgramFunctions[importedName];
      } else {
        throw new Error(
          `Import failed: ${module} cannot find '${importedName}' in '${importProgram.getModule()}'`
        );
      }
    }

    // Retrieve the types defined in the program
    TypeDef.find(this, undefined, undefined, options).forEach((type) => {
      this._types[type.getName()] = type;
    });

    // Retrieve the functions defined in the program
    FunctionDef.find(this, undefined, undefined, options).forEach((fn) => {
      this._functions[fn.getName()] = fn;
    });

    // Cache the instance)
    const hash = sha256(JSON.stringify(options ?? "") + src); // Hash the options + source code
    if (!(module in ProgramDef._instances)) {
      ProgramDef._instances[module] = {};
    }
    ProgramDef._instances[module][hash] = this;
    console.debug(`Cached ProgramDef: ${module} (${hash})`); // !!!!
  } // end constructor

  /**
   * Returns a ProgramDef object for the given module.
   * Note: Uses a caching strategy
   *
   * @param module Path of the module to load
   * @param options Argument options
   * @returns A ProgramDef object
   */
  public static fromModule(module: string, options?: ArgOptions): ProgramDef {
    module = require.resolve(module);
    const src = fs.readFileSync(module).toString(); // Read the source code
    const hash = sha256(JSON.stringify(options ?? "") + src); // Hash the options + source code

    if (
      module in ProgramDef._instances &&
      hash in ProgramDef._instances[module]
    ) {
      // noop
    } else {
      console.debug(`Retrieved from cache ${module} (${hash})`); // !!!!
      return new ProgramDef(src, module, options);
    }
    return ProgramDef._instances[module][hash];
  }

  /**
   * Returns a ProgramDef object for the given source code.
   * Note: Uses a caching strategy
   *
   * @param src Source code for the module
   * @param options Argument options
   * @returns A ProgramDef object
   */
  public static fromSource(src: string, options?: ArgOptions): ProgramDef {
    const module = ""; // Dummy module
    const hash = sha256(JSON.stringify(options ?? "") + src); // Hash the options + source code

    if (
      module in ProgramDef._instances &&
      hash in ProgramDef._instances[module]
    ) {
      // noop
    } else {
      console.debug(`Retrieved from cache ${module} (${hash})`); // !!!!
      return new ProgramDef(src, module, options);
    }
    return ProgramDef._instances[module][hash];
  }

  /**
   * Returns the function's source code
   *
   * @returns Source code of the function
   */
  public getSrc(): string {
    return this._src;
  } // fn: getSrc()

  /**
   * Returns a new ProgramDef with the given source code
   *
   * @returns new ProgramDef object
   */
  public setSrc(src: string): ProgramDef {
    return new ProgramDef(src, this._module, this._options);
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
   *
   * @returns new ProgramDef object
   */
  public setModule(module: string): ProgramDef {
    return new ProgramDef(this._src, module, this._options);
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
   *
   * @returns new ProgramDef object
   */
  public setOptions(options: ArgOptions): ProgramDef {
    return new ProgramDef(this._src, this._module, options);
  } // fn: setOptions()

  /**
   * Returns the functions defined in the program
   *
   * @returns the functions defined in the program
   */
  public getFunctions(): Record<string, FunctionDef> {
    return { ...this._functions };
  } // fn: getFunctions()

  /**
   * Returns the types defined in the program
   *
   * @returns the types defined in the program
   */
  public getTypes(): Record<string, ITypeDef> {
    return { ...this._types };
  } // fn: getTypes()

  /**
   * Returns the imports defined in the program
   *
   * @param options The ArgDef options for the program
   * @returns A record of the imports defined in the program
   */
  private findImports(options: ArgOptions): Record<string, ProgramImport> {
    const ast = parse(this._src, { range: true }); // Parse the source
    const imports: Record<string, ProgramImport> = {};

    simpleTraverse(
      ast,
      {
        enter: (node) => {
          switch (node.type) {
            case AST_NODE_TYPES.ImportDeclaration: {
              if (typeof node.source.value === "string") {
                // Resolve the path of the imported module
                const importModule = path.resolve(
                  path.dirname(this._module),
                  node.source.value + ".ts" // !!!!
                );

                // Create a new ProgramDef for the imported module
                const program = ProgramDef.fromModule(importModule, options);

                // Loop over all the imports specified
                node.specifiers.forEach((specifier) => {
                  switch (specifier.type) {
                    case AST_NODE_TYPES.ImportSpecifier: {
                      imports[specifier.local.name] = {
                        local: specifier.local.name,
                        imported: specifier.imported.name,
                        program: program,
                      };
                      break;
                    }
                    case AST_NODE_TYPES.ImportDefaultSpecifier: {
                      break; // !!!!
                    }
                    case AST_NODE_TYPES.ImportNamespaceSpecifier: {
                      break; // !!!!
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
} // class: ProgramDef

/**
 * Represents an import declaration within a TypeScript program
 */
type ProgramImport = {
  local: string;
  imported: string;
  program: ProgramDef;
};
