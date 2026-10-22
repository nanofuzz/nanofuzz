import { TypescriptProgram } from "../analysis/typescript/TypescriptProgram";
import { RustProgram } from "../analysis/rust/RustProgram";
import { TypescriptCompiler } from "./TypescriptCompiler";
import { RustCompiler } from "./rust/RustCompiler";

export { TypescriptCompiler, RustCompiler };

// TODO: Create an AbstractCompiler class & a matching strategy
export function fromSourcefile(fqSrcFile: string): Compiler | undefined {
  if (TypescriptProgram.understands({ filename: fqSrcFile })) {
    return new TypescriptCompiler(fqSrcFile);
  }
  if (RustProgram.understands({ filename: fqSrcFile })) {
    return new RustCompiler(fqSrcFile);
  }
  return undefined;
} // fn: fromSourcefile

export function needsCompilation(fqSrcFile: string): boolean {
  return (
    TypescriptProgram.understands({ filename: fqSrcFile }) ||
    RustProgram.understands({ filename: fqSrcFile })
  );
} // fn: needsCompilation

/**
 * Cleans up compiler outputs, cached file, and temp files
 */
export function clean(): void {
  TypescriptCompiler.clean();
  RustCompiler.clean();
} // fn: clean

export type Compiler = TypescriptCompiler | RustCompiler;
