import { ProgramLanguage } from "../analysis/Types";
import { ArgDef } from "../analysis/ArgDef";
import * as PythonValueMapper from "./python/PythonValueMapper";
import * as TypescriptValueMapper from "./typescript/TypescriptValueMapper";
import * as RustValueMapper from "./rust/RustValueMapper";

export function toLang(
  lang: Omit<ProgramLanguage, "*">,
  val: unknown,
  argDef?: ArgDef
): string {
  switch (lang) {
    case "python":
      return PythonValueMapper.toPython(val);
    case "typescript":
      return TypescriptValueMapper.toTypescript(val, argDef);
    case "rust":
      return RustValueMapper.toRust(val, argDef);
    case "java":
      throw new Error(`Java value mapping not yet implemented`);
  }
  throw new Error(`Unknown language: ${lang}`);
}

export function fromLang<T>(lang: Omit<ProgramLanguage, "*">, text: string): T {
  switch (lang) {
    case "python":
      return PythonValueMapper.fromPython(text);
    case "typescript":
      return TypescriptValueMapper.fromTypescript(text);
    case "rust":
      return RustValueMapper.fromRust(text);
    case "java":
      throw new Error(`Java value mapping not yet implemented`);
  }
  throw new Error(`Unknown language: ${lang}`);
}
