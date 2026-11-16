import { ProgramLanguage } from "../analysis/Types";
import { ArgDef } from "../analysis/ArgDef";
import * as PythonValueMapper from "./python/PythonValueMapper";
import * as TypescriptValueMapper from "./typescript/TypescriptValueMapper";
import * as RustValueMapper from "./rust/RustValueMapper";
import * as OxcamlValueMapper from "./oxcaml/OxcamlValueMapper";
import * as JavaValueMapper from "./java/JavaValueMapper";
import * as GoValueMapper from "./go/GoValueMapper";

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
    case "oxcaml":
      return OxcamlValueMapper.toOxcaml(val, argDef);
    case "java":
      return JavaValueMapper.toJava(val, argDef);
    case "go":
      return GoValueMapper.toGo(val, argDef);
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
    case "oxcaml":
      return OxcamlValueMapper.fromOxcaml(text);
    case "java":
      return JavaValueMapper.fromJava(text);
    case "go":
      return GoValueMapper.fromGo(text);
  }
  throw new Error(`Unknown language: ${lang}`);
}
