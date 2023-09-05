import { ArgDef, ArgOptions } from "./ArgDef";
import { FunctionDef } from "./FunctionDef";
import { ITypeDef, TypeDef } from "./TypeDef";

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

  /**
   * Constructs a new ProgramDef instance using a FunctionRef object.
   * and optional set of options.
   *
   * @param src Source of the program to be analyzed
   * @param path Path to the source file (optional)
   * @param options Options for the function analysis (optional)
   */
  constructor(src: string, module: string, options?: ArgOptions) {
    this._module = module;
    this._src = src;
    this._options = options ?? ArgDef.getDefaultOptions();

    // Retrieve the types defined in the program
    TypeDef.find(this, undefined, undefined, options).forEach((type) => {
      this._types[type.getName()] = type;
    });

    // Retrieve the functions defined in the program
    FunctionDef.find(this, undefined, undefined, options).forEach((fn) => {
      this._functions[fn.getName()] = fn;
    });
  } // end constructor

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
} // class: ProgramDef
