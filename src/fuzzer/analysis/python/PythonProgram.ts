import { AbstractProgram } from "../AbstractProgram";
import { ProgramImports, IdentifierName, TypeRef, ArgOptions } from "../Types";

export class PythonProgram extends AbstractProgram {
  public readonly lang = "python";
  public readonly extensions = Object.freeze([".py"]);

  constructor(
    getSource: () => string,
    filename: string,
    options?: ArgOptions,
    parent?: AbstractProgram
  ) {
    super(getSource, filename, options, parent);
    if (parent && this.lang !== parent.lang) {
      throw new Error(
        `A "${this.lang}" program cannot be a child of a "${parent.lang}" program.`
      );
    }
  }

  protected _parse(_src: string): void {
    throw new Error("Method not implemented.");
  }

  protected _findImports(): ProgramImports {
    throw new Error("Method not implemented.");
  }

  protected _findTypes(): Record<IdentifierName, TypeRef> {
    throw new Error("Method not implemented.");
  }

  protected _findFunctions(): typeof this._functions {
    throw new Error("Method not implemented.");
  }

  protected _findDefaultTypeExport(): TypeRef | undefined {
    throw new Error("Method not implemented.");
  }

  public _resolveTypeRef(_t: TypeRef): TypeRef {
    throw new Error("Method not implemented.");
  }
}
