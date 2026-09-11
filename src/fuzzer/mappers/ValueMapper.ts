import { ProgramLanguage } from "../Fuzzer";
import * as PythonValueMapper from "./python/PythonValueMapper";
import * as TypescriptValueMapper from "./typescript/TypescriptValueMapper";

export function toLang(lang: Omit<ProgramLanguage, "*">, val: unknown): string {
  switch (lang) {
    case "python":
      return PythonValueMapper.toPython(val);
    case "typescript":
      return TypescriptValueMapper.toTypescript(val);
  }
  throw new Error(`Unknown language: ${lang}`);
}

export function fromLang<T>(lang: Omit<ProgramLanguage, "*">, text: string): T {
  switch (lang) {
    case "python":
      return PythonValueMapper.fromPython(text);
    case "typescript":
      return TypescriptValueMapper.fromTypescript(text);
  }
  throw new Error(`Unknown language: ${lang}`);
}
