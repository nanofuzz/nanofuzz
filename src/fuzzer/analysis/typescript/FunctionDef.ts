import * as JSON5 from "json5";
import { ArgDef } from "./ArgDef";
import {
  ArgType,
  FunctionRef,
  ArgOptionOverrides,
  ArgOptions,
  TypeRef,
} from "./Types";

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
  private _argDefs: ArgDef<ArgType>[] = [];
  private _options: ArgOptions;
  private _ref: FunctionRef;

  /**
   * Constructs a new FunctionDef instance using a FunctionRef object.
   * and optional set of options.
   *
   * @param ref The function reference to be analyzed
   * @param options Options for the function analysis (optional)
   */
  private constructor(ref: FunctionRef, options?: ArgOptions) {
    this._options = options ?? ArgDef.getDefaultOptions();
    this._ref = ref;

    if (!ref.args) {
      throw new Error(`FunctionRef.args is undefined: ${JSON5.stringify(ref)}`);
    }

    // Extract the function arguments
    let offset = 0;
    this._argDefs = ref.args.map((arg) =>
      ArgDef.fromTypeRef(arg, this._options, offset++)
    );
  }

  /**
   * Constructs a new FunctionDef instance using a FunctionRef object.
   *
   * @param ref FunctionRef object
   * @param options Optional set of options
   * @returns new FunctionDef instance
   */
  public static fromFunctionRef(
    ref: FunctionRef,
    options?: ArgOptions
  ): FunctionDef {
    return new FunctionDef(ref, options);
  } // fn: fromFunctionRef()

  /**
   * Returns the function name
   *
   * @returns The function name
   */
  public getName(): string {
    return this._ref.name;
  } // fn: getName()

  /**
   * Returns the function's source code
   *
   * @returns Source code of the function
   */
  public getSrc(): string {
    return this._ref.src;
  } // fn: getSrc()

  /**
   * Returns the array of function arguments
   *
   * @returns array of function arguments
   */
  public getArgDefs(): ArgDef<ArgType>[] {
    return [...this._argDefs];
  } // fn: getArgDefs()

  /**
   * Returns the starting offset of the function in the source file.
   *
   * @returns the start offset of the function in the source file
   */
  public getStartOffset(): number {
    return this._ref.startOffset;
  } // fn: getStartOffset()

  /**
   * Returns the ending offset of the function in the source file.
   *
   * @returns the end offset of the function in the source file
   */
  public getEndOffset(): number {
    return this._ref.endOffset;
  } // fn: getEndOffset()

  /**
   * Returns the module filename where the function is defined
   *
   * @returns the module filename where the function is defined
   */
  public getModule(): string {
    return this._ref.module;
  } // fn: getModule()

  /**
   * Returns the full in-source reference to the function.
   *
   * @returns the full in-source reference to the function
   */
  public getRef(): FunctionRef {
    return { ...this._ref };
  } // fn: getRef()

  /**
   * Returns the return type of the function, or undefined if the
   * function does not have a return type annotation.
   *
   * @returns the return type of the function, or undefined if the
   * function does not have a return type annotation.
   */
  public getReturnType(): TypeRef | undefined {
    return this._ref.returnType;
  } // fn: get

  /**
   * Returns true if the function is exported; false, otherwise.
   *
   * @returns true if the function is exported; false, otherwise.
   */
  public isExported(): boolean {
    return this._ref.isExported;
  } // fn: isExported()

  /**
   * Returns true if the function is a validator; false, otherwise.
   *
   * @returns true if the function is a validator; false, otherwise.
   */
  public isValidator(): boolean {
    return (
      this.isExported() &&
      this._argDefs.length === 1 &&
      this._argDefs[0].getTypeRef() === "FuzzTestResult"
    );
  } // fn: isValidator()

  /**
   * Applies option overrides to the function definition --
   * including to its arguments -- that influence how the function
   * analysis is interpreted.
   *
   * @param overrides
   */
  public applyOverrides(overrides: ArgOptionOverrides): void {
    // Apply argument overrides
    for (const argName of Object.keys(overrides.argOptions)) {
      const arg = this._argDefs.find((arg) => arg.getName() === argName);
      if (arg !== undefined) arg.setOptions(overrides.argOptions[argName]);
    }
  } // fn: applyOverrides()

  /**
   * Applies options to the argument definitions for the function
   * definition that influence how the function analysis is
   * interpreted.
   *
   * @param options
   */
  public applyOptions(options: ArgOptions): void {
    this._argDefs.forEach((argdef) => {
      argdef.setStrCharSet(options.strCharset);
      argdef.setDefaultIntervals(options);
    });
  } // fn: applyOverrides()

  /**
   * Returns a flat array of all function arguments, including
   * the children of arguments.  The selection is depth-first.
   *
   * @returns a flat array of all function arguments.
   */
  public getArgDefsFlat(): ArgDef<ArgType>[] {
    const ret: ArgDef<ArgType>[] = [];
    for (const arg of this._argDefs) {
      ret.push(arg);
      ret.push(...arg.getChildrenFlat());
    }
    return ret;
  } // fn: getArgDefsFlat()
} // class: FunctionDef
