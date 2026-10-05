import { TypescriptCompilerErrorDetails } from "../Types";

export type CompilerStaleness =
  | false
  | "notcompiled"
  | "sourcechanged"
  | "compilerchanged"
  | "configchanged";

/**
 * Messages from the Compiler to its worker
 */
export type CompilerMessageToWorker =
  | {
      command: "prepare";
      id: number;
      module: string;
      measures?: string[];
    }
  | {
      command: "exit";
    };

/**
 * Messages from the worker to the Compiler
 */
export type CompilerMessageFromWorker = {
  command: "prepare.result";
  id: number;
} & (
  | { success: true }
  | ({ success: false } & Partial<TypescriptCompilerErrorDetails>)
);
