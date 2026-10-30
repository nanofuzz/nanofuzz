import * as ProgramFactory from "../analysis/ProgramFactory";
import { TypescriptCompiler } from "./TypescriptCompiler";
import { RustCompiler } from "./rust/RustCompiler";
import { OxcamlCompiler } from "./oxcaml/OxcamlCompiler";
import { JavaCompiler } from "./java/JavaCompiler";
import { GoCompiler } from "./go/GoCompiler";
import { Instrumenter } from "./Instrumenter";

export {
  TypescriptCompiler,
  RustCompiler,
  OxcamlCompiler,
  JavaCompiler,
  GoCompiler,
};

// TODO: Create an AbstractCompiler class & a matching strategy
export function fromSourcefile(fqSrcFile: string): Compiler | undefined {
  const lang = ProgramFactory.getLanguage({ filename: fqSrcFile });
  switch (lang) {
    case "typescript":
      return new TypescriptCompiler(fqSrcFile);
    case "rust":
      return new RustCompiler(fqSrcFile);
    case "oxcaml":
      return new OxcamlCompiler(fqSrcFile);
    case "java":
      return new JavaCompiler(fqSrcFile);
    case "go":
      return new GoCompiler(fqSrcFile);
    case "python":
    case "*":
    default:
      return undefined;
  }
} // fn: fromSourcefile

export function needsCompilation(fqSrcFile: string): boolean {
  const lang = ProgramFactory.getLanguage({ filename: fqSrcFile });
  return (
    lang === "typescript" ||
    lang === "rust" ||
    lang === "oxcaml" ||
    lang === "java" ||
    lang === "go"
  );
} // fn: needsCompilation

/**
 * Cleans up compiler outputs, cached file, and temp files
 */
export function clean(): void {
  TypescriptCompiler.clean();
  Instrumenter.clean();
  RustCompiler.clean();
  OxcamlCompiler.clean();
  JavaCompiler.clean();
  GoCompiler.clean();
} // fn: clean

export type Compiler =
  | TypescriptCompiler
  | RustCompiler
  | OxcamlCompiler
  | JavaCompiler
  | GoCompiler;
