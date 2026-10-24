import * as ProgramFactory from "../analysis/ProgramFactory";
import { TypescriptCompiler } from "./TypescriptCompiler";
import { RustCompiler } from "./rust/RustCompiler";
import { JavaCompiler } from "./java/JavaCompiler";

export { TypescriptCompiler, RustCompiler, JavaCompiler };

// TODO: Create an AbstractCompiler class & a matching strategy
export function fromSourcefile(fqSrcFile: string): Compiler | undefined {
  const lang = ProgramFactory.getLanguage({ filename: fqSrcFile });
  switch (lang) {
    case "typescript":
      return new TypescriptCompiler(fqSrcFile);
    case "rust":
      return new RustCompiler(fqSrcFile);
    case "java":
      return new JavaCompiler(fqSrcFile);
    case "python":
    case "*":
    default:
      return undefined;
  }
} // fn: fromSourcefile

export function needsCompilation(fqSrcFile: string): boolean {
  const lang = ProgramFactory.getLanguage({ filename: fqSrcFile });
  return lang === "typescript" || lang === "rust" || lang === "java";
} // fn: needsCompilation

/**
 * Cleans up compiler outputs, cached file, and temp files
 */
export function clean(): void {
  TypescriptCompiler.clean();
  RustCompiler.clean();
  JavaCompiler.clean();
} // fn: clean

export type Compiler = TypescriptCompiler | RustCompiler | JavaCompiler;
