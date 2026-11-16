import * as ChildProcess from "node:child_process";
import {
  RustSanitizerAdapter,
  SanitizerBuildConfig,
  SanitizerDetectionResult,
  SanitizerDiagnostic,
  SanitizerId,
} from "./Types";

/**
 * Adapter for the LLVM AddressSanitizer (ASan) in Rust nightly.
 */
export class AddressSanitizer implements RustSanitizerAdapter {
  public readonly id: SanitizerId = "address";
  public readonly displayName: string = "AddressSanitizer";

  /**
   * Returns reproduction command instructions for AddressSanitizer.
   *
   * @returns Cargo invocation required to reproduce ASan errors
   */
  public getReproductionCommand(): string {
    return 'RUSTFLAGS="-Zsanitizer=address" cargo test -Zbuild-std=core,alloc,std';
  } // fn: getReproductionCommand

  /**
   * Detects whether a Rust nightly toolchain is available to run AddressSanitizer.
   *
   * @param env Environment variables to use for probing
   * @returns Detection result with availability status and optional error details
   */
  public detect(
    env: NodeJS.ProcessEnv = process.env
  ): SanitizerDetectionResult {
    if (this._isNightlyToolchainAvailable(env)) {
      return { available: true, toolchain: "nightly" };
    }

    return {
      available: false,
      error:
        "AddressSanitizer requires a Rust nightly toolchain. Please install nightly via 'rustup toolchain install nightly'.",
    };
  } // fn: detect

  /**
   * Configures compiler flags, cargo arguments, and environment variables for building with ASan.
   *
   * @param baseEnv Base environment variables
   * @returns Build configuration including rustflags, cargo arguments, and modified environment
   */
  public configureBuild(
    baseEnv: NodeJS.ProcessEnv = process.env
  ): SanitizerBuildConfig {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    if (!env.RUSTUP_TOOLCHAIN) {
      env.RUSTUP_TOOLCHAIN = "nightly";
    }

    return {
      cargoCommand: ["build"],
      rustflags: ["-Zsanitizer=address"],
      cargoArgs: ["-Zbuild-std=core,alloc,std"],
      env,
    };
  } // fn: configureBuild

  /**
   * Configures environment variables for the running host process.
   *
   * @param baseEnv Base environment variables
   * @returns Host process environment
   */
  public configureHostEnv(
    baseEnv: NodeJS.ProcessEnv = process.env
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    return env;
  } // fn: configureHostEnv

  /**
   * Parses stderr output from an aborted or trapped harness process to diagnose ASan violations.
   *
   * @param stderr Standard error output captured from the host process
   * @param _exitCode Process exit code if available
   * @returns Parsed diagnostic details or null if stderr does not match ASan error signatures
   */
  public parseAbort(
    stderr: string,
    _exitCode: number | null
  ): SanitizerDiagnostic | null {
    if (!stderr || stderr.trim().length === 0) return null;

    // Matches standard LLVM ASan output: "==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x..."
    const headerMatch = stderr.match(
      /(?:==\d*==\s*)?(?:==ERROR:\s*)?AddressSanitizer:\s*([^\n\r]+)/i
    );

    if (!headerMatch) {
      const asanTrap = stderr.match(/(?:AddressSanitizer|ASan)/i);
      if (!asanTrap) {
        return null;
      }
    }

    const summary = headerMatch
      ? headerMatch[1].trim()
      : "AddressSanitizer memory error detected";
    const stack = this._extractStackTrace(stderr);

    return {
      name: "AddressSanitizerError",
      summary,
      rawReport: stderr.trim(),
      stack: stack ?? stderr.trim(),
    };
  } // fn: parseAbort

  /**
   * Checks if rustup has a nightly toolchain available.
   *
   * @param env Environment variables to use when spawning rustup
   * @returns True if rustup reports nightly in its toolchain list or rustc is nightly
   */
  protected _isNightlyToolchainAvailable(env: NodeJS.ProcessEnv): boolean {
    const res = ChildProcess.spawnSync("rustup", ["toolchain", "list"], {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    });
    if (res.error) {
      if ("code" in res.error && res.error.code === "ENOENT") {
        // rustup is not installed, probe if active rustc is nightly
        return this._isRustcNightly(env);
      }
      throw res.error;
    }
    if (res.status === 0 && res.stdout) {
      if (/^nightly\b/m.test(res.stdout)) {
        return true;
      }
    }
    return this._isRustcNightly(env);
  } // fn: _isNightlyToolchainAvailable

  /**
   * Checks if the active rustc binary is a nightly release.
   *
   * @param env Environment variables to use when spawning rustc
   * @returns True if `rustc --version` contains nightly
   */
  protected _isRustcNightly(env: NodeJS.ProcessEnv): boolean {
    const res = ChildProcess.spawnSync("rustc", ["--version"], {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    });
    if (res.error) {
      if ("code" in res.error && res.error.code === "ENOENT") {
        return false;
      }
      throw res.error;
    }
    return (
      res.status === 0 && Boolean(res.stdout && res.stdout.includes("nightly"))
    );
  } // fn: _isRustcNightly

  /**
   * Extracts backtrace stack lines from sanitizer error report text.
   *
   * @param stderr Raw stderr string from the aborted process
   * @returns Extracted stack trace string if found, otherwise undefined
   */
  protected _extractStackTrace(stderr: string): string | undefined {
    const lines = stderr.split(/\r?\n/);
    const traceLines: string[] = [];
    let capturing = false;

    for (const line of lines) {
      if (
        /^\s*#\d+\s+0x[0-9a-fA-F]+/i.test(line) ||
        /^\s*stack backtrace:/i.test(line) ||
        /^\s*at\s+.*:\d+/i.test(line)
      ) {
        capturing = true;
      }
      if (capturing) {
        traceLines.push(line);
      }
    }

    return traceLines.length > 0 ? traceLines.join("\n") : undefined;
  } // fn: _extractStackTrace
} // class: AddressSanitizer
