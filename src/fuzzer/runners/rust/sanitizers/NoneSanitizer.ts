import {
  RustSanitizerAdapter,
  SanitizerBuildConfig,
  SanitizerDetectionResult,
  SanitizerDiagnostic,
  SanitizerId,
} from "./Types";

/**
 * Default pass-through adapter when no sanitizer is requested.
 */
export class NoneSanitizer implements RustSanitizerAdapter {
  public readonly id: SanitizerId = "none";

  /**
   * Always available as the default no-op sanitizer.
   *
   * @param _env Environment variables (unused)
   * @returns Detection result indicating availability
   */
  public detect(_env?: NodeJS.ProcessEnv): SanitizerDetectionResult {
    return { available: true };
  } // fn: detect

  /**
   * Returns unchanged build configuration without sanitizer flags.
   *
   * @param baseEnv Base environment variables
   * @returns Unmodified build configuration
   */
  public configureBuild(
    baseEnv: NodeJS.ProcessEnv = process.env
  ): SanitizerBuildConfig {
    return {
      rustflags: [],
      cargoArgs: [],
      env: { ...baseEnv },
    };
  } // fn: configureBuild

  /**
   * Returns unchanged host environment variables.
   *
   * @param baseEnv Base environment variables
   * @returns Unmodified host environment
   */
  public configureHostEnv(
    baseEnv: NodeJS.ProcessEnv = process.env
  ): NodeJS.ProcessEnv {
    return { ...baseEnv };
  } // fn: configureHostEnv

  /**
   * No-op abort parser when no sanitizer is active.
   *
   * @param _stderr Captured standard error
   * @param _exitCode Process exit code
   * @returns null
   */
  public parseAbort(
    _stderr: string,
    _exitCode: number | null
  ): SanitizerDiagnostic | null {
    return null;
  } // fn: parseAbort
} // class: NoneSanitizer
