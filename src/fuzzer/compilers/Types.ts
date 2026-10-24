/**
 * Base exception class for compiler errors.
 */
export class CompilerError<
  T extends CompilerErrorDetails = CompilerErrorDetails,
> extends Error {
  public details: T;
  constructor(message: string, details: T) {
    super(message);
    this.name = "CompilerError";
    this.details = details;
  }
}

/**
 * Exception class for TypeScript compiler errors.
 */
export class TypescriptCompilerError extends CompilerError<TypescriptCompilerErrorDetails> {
  constructor(message: string, details: TypescriptCompilerErrorDetails) {
    if (!details.cli && details.tscCli) details.cli = details.tscCli;
    if (!details.configFilename && details.tscConfigFilename) {
      details.configFilename = details.tscConfigFilename;
    }
    super(message, details);
    this.name = "TypescriptCompilerError";
  }
}

/**
 * Exception class for Rust compiler errors.
 */
export class RustCompilerError extends CompilerError<RustCompilerErrorDetails> {
  constructor(message: string, details: RustCompilerErrorDetails) {
    if (!details.cli && details.commandCli) details.cli = details.commandCli;
    if (!details.configFilename && details.cargoTomlPath) {
      details.configFilename = details.cargoTomlPath;
    }
    super(message, details);
    this.name = "RustCompilerError";
  }
}

/**
 * Exception class for Java compiler errors.
 */
export class JavaCompilerError extends CompilerError<JavaCompilerErrorDetails> {
  constructor(message: string, details: JavaCompilerErrorDetails) {
    if (!details.cli && details.javacCli) details.cli = details.javacCli;
    if (!details.configFilename && details.projectConfigPath) {
      details.configFilename = details.projectConfigPath;
    }
    super(message, details);
    this.name = "JavaCompilerError";
  }
}

// ============================================================================
// Types
// ============================================================================

export type CompilerStaleness =
  | false
  | "notcompiled"
  | "sourcechanged"
  | "compilerchanged"
  | "configchanged";

/**
 * Common compiler error details
 */
export type CompilerErrorDetails = {
  inputFile: string;
  outputFile?: string;
  output?: string[];
  configFilename?: string;
  cli?: string;
};

/**
 * TypeScript compiler error details
 */
export type TypescriptCompilerErrorDetails = CompilerErrorDetails & {
  outputFile: string;
  tscConfigFilename?: string;
  tscCli?: string;
};

/**
 * Diagnostic source span reported by the Rust compiler
 */
export type RustCompilerDiagnosticSpan = {
  file: string;
  lineStart: number;
  lineEnd: number;
  colStart: number;
  colEnd: number;
};

/**
 * Rust compiler error details
 */
export type RustCompilerErrorDetails = CompilerErrorDetails & {
  cargoTomlPath?: string;
  commandCli?: string;
  diagnostics?: Array<{
    message: string;
    level: string;
    code?: string;
    span?: RustCompilerDiagnosticSpan;
    rendered?: string;
  }>;
};

/**
 * Diagnostic source location reported by the Java compiler
 */
export type JavaCompilerDiagnosticSpan = {
  file: string;
  line: number;
  col: number;
};

/**
 * Java compiler error details
 */
export type JavaCompilerErrorDetails = CompilerErrorDetails & {
  projectConfigPath?: string;
  javacCli?: string;
  diagnostics?: Array<{
    message: string;
    level: string;
    span?: JavaCompilerDiagnosticSpan;
    rendered?: string;
  }>;
};

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
} & ({ success: true } | ({ success: false } & Partial<CompilerErrorDetails>));
