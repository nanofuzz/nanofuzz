/**
 * Diagnostic information parsed from a sanitizer abort/trap.
 */
export interface SanitizerDiagnostic {
  name: string;
  summary: string;
  rawReport: string;
  stack?: string;
  accessType?: string;
  target?: string;
}

export type SanitizerId = "none" | "borrow" | "address" | "thread" | "memory";

export interface SanitizerDetectionResult {
  available: boolean;
  error?: string;
  toolchain?: string;
}

export interface SanitizerBuildConfig {
  rustflags: string[];
  cargoArgs: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Common adapter contract for Rust compiler and runtime sanitizers.
 */
export interface RustSanitizerAdapter {
  readonly id: SanitizerId;
  readonly displayName: string;

  /**
   * Returns instructions or command flags to reproduce the sanitizer check via cargo test.
   */
  getReproductionCommand(): string;

  /**
   * Probes whether the required toolchain and binaries are installed and available.
   */
  detect(env?: NodeJS.ProcessEnv): SanitizerDetectionResult;

  /**
   * Configures compiler flags, cargo arguments, and environment variables for the build.
   */
  configureBuild(baseEnv?: NodeJS.ProcessEnv): SanitizerBuildConfig;

  /**
   * Configures environment variables for the running host process (e.g. symbolizers).
   */
  configureHostEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

  /**
   * Inspects stderr and exit status when a host process aborts unexpectedly.
   */
  parseAbort(
    stderr: string,
    exitCode: number | null
  ): SanitizerDiagnostic | null;
}
