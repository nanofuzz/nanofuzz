import { TypescriptProgram } from "../analysis/typescript/TypescriptProgram";
import { TypescriptCompiler } from "./TypescriptCompiler";

// TODO: Create an AbstractCompiler class & a matching strategy
export function fromSource(fqSrcFile: string): TypescriptCompiler | undefined {
  return TypescriptProgram.understands({ filename: fqSrcFile })
    ? new TypescriptCompiler(fqSrcFile)
    : undefined;
}

export function needsCompilation(fqSrcFile: string): boolean {
  return TypescriptProgram.understands({ filename: fqSrcFile });
}
