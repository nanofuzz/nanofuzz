import { ProgramLanguage } from "../Fuzzer";
import * as PythonValueMapper from "./python/PythonValueMapper";
import * as TypescriptValueMapper from "./typescript/TypescriptValueMapper";
import * as JSONN from "../../Jsonn";

export class ValueMapper<T> {
  protected _jsValue: T;

  constructor(jsValue: T) {
    this._jsValue = jsValue;
  }

  public static unserialize<T>(text: string): ValueMapper<T> {
    return new ValueMapper<T>(JSONN.parse(text));
  }

  public static fromString<T>(
    lang: Omit<ProgramLanguage, "*">,
    text: string
  ): ValueMapper<T> {
    switch (lang) {
      case "python":
        return new ValueMapper<T>(PythonValueMapper.fromPython(text));
      case "typescript":
        return new ValueMapper<T>(TypescriptValueMapper.fromTypescript(text));
    }
    throw new Error(`Unknown language: ${lang}`);
  }

  public get value(): T {
    return this._jsValue;
  }

  public serialize(): string {
    return JSONN.stringify(this._jsValue);
  }

  public toString(lang: Omit<ProgramLanguage, "*">): string {
    switch (lang) {
      case "python":
        return PythonValueMapper.toPython(this._jsValue);
      case "typescript":
        return TypescriptValueMapper.toTypescript(this._jsValue);
    }
    throw new Error(`Unknown language: ${lang}`);
  }
} // class: ValueMapper
