import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as ChildProcess from "node:child_process";
import {
  RustSanitizerAdapter,
  SanitizerBuildConfig,
  SanitizerDetectionResult,
  SanitizerDiagnostic,
  SanitizerId,
} from "./Types";

/**
 * Adapter for the experimental BorrowSanitizer (bsan) LLVM toolchain.
 */
export class BorrowSanitizer implements RustSanitizerAdapter {
  public readonly id: SanitizerId = "borrow";
  public readonly displayName: string = "BorrowSanitizer";

  /**
   * Returns reproduction command instructions for BorrowSanitizer.
   *
   * @returns Cargo invocation required to reproduce borrow errors
   */
  public getReproductionCommand(): string {
    return 'RUSTFLAGS="-Zsanitizer=borrow" cargo test -Zbuild-std=core,alloc,std';
  } // fn: getReproductionCommand

  /**
   * Detects whether BorrowSanitizer toolchain or cargo-bsan executable is available.
   *
   * @param env Environment variables to use for probing
   * @returns Detection result with availability status and optional toolchain or error details
   */
  public detect(
    env: NodeJS.ProcessEnv = process.env
  ): SanitizerDetectionResult {
    // 1. Check if cargo-bsan executable is directly available on PATH
    if (this._isCargoBsanAvailable(env)) {
      return { available: true, toolchain: "bsan" };
    }

    // 2. Check if rustup manages a 'bsan' toolchain
    if (this._isBsanToolchainAvailable(env)) {
      return { available: true, toolchain: "bsan" };
    }

    // 3. Check if bsan toolchain exists on filesystem under ~/.rustup
    if (this._hasBsanToolchainDir()) {
      return { available: true, toolchain: "bsan" };
    }

    // Explicit error for unsupported host platform
    if (process.platform === "darwin") {
      return {
        available: false,
        error:
          "BorrowSanitizer is not supported natively on macOS (target aarch64-apple-darwin). Run in Linux or the official container (ghcr.io/borrowsanitizer/bsan:latest).",
      };
    }

    return {
      available: false,
      error:
        "BorrowSanitizer toolchain 'bsan' or 'cargo-bsan' executable not found on PATH or in ~/.cargo/bin. Please install via './xb install' or use the official container.",
    };
  } // fn: detect

  /**
   * Configures compiler flags, cargo arguments, and environment variables for building with BSan.
   *
   * @param baseEnv Base environment variables
   * @returns Build configuration including rustflags, cargo arguments, and modified environment
   */
  public configureBuild(
    baseEnv: NodeJS.ProcessEnv = process.env
  ): SanitizerBuildConfig {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    env.RUSTUP_TOOLCHAIN = "bsan";

    return {
      rustflags: ["-Zsanitizer=borrow"],
      cargoArgs: ["-Zbuild-std=core,alloc,std"],
      env,
    };
  } // fn: configureBuild

  /**
   * Configures environment variables for the running host process, including symbolizer path.
   *
   * @param baseEnv Base environment variables
   * @returns Host process environment with BSAN_SYMBOLIZER set if found
   */
  public configureHostEnv(
    baseEnv: NodeJS.ProcessEnv = process.env
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    const symbolizer = this._findSymbolizer();
    if (symbolizer) {
      env.BSAN_SYMBOLIZER = symbolizer;
    }
    return env;
  } // fn: configureHostEnv

  /**
   * Parses stderr output from an aborted or trapped harness process to diagnose BSan violations.
   *
   * @param stderr Standard error output captured from the host process
   * @param _exitCode Process exit code if available
   * @returns Parsed diagnostic details or null if stderr does not match BSan error signatures
   */
  public parseAbort(
    stderr: string,
    _exitCode: number | null
  ): SanitizerDiagnostic | null {
    if (!stderr || stderr.trim().length === 0) return null;

    // Matches standard LLVM sanitizer output: "==ERROR: BorrowSanitizer: ..." or "==12345==ERROR: BorrowSanitizer: ..."
    const headerMatch = stderr.match(
      /(?:==\d*==\s*)?(?:==ERROR:\s*)?(?:BorrowSanitizer|bsan):\s*([^\n\r]+)/i
    );

    let summary: string;
    if (headerMatch) {
      summary = headerMatch[1].trim();
    } else {
      const fatalMatch = stderr.match(
        /fatal error:\s*(?:BorrowSanitizer|bsan)\s*(?:detected\s*)?:?\s*([^\n\r]+)/i
      );
      if (fatalMatch) {
        summary = fatalMatch[1].trim();
      } else {
        const bsanTrap = stderr.match(/(?:BorrowSanitizer|bsan)/i);
        if (!bsanTrap) {
          return null;
        }
        summary = "BorrowSanitizer aliasing violation detected";
      }
    }

    const stack = this._extractStackTrace(stderr);

    return {
      name: "BorrowSanitizerError",
      summary,
      rawReport: stderr.trim(),
      stack: stack ?? stderr.trim(),
    };
  } // fn: parseAbort

  /**
   * Checks if the `cargo-bsan` subcommand is executable.
   *
   * @param env Environment variables to use when spawning cargo
   * @returns True if `cargo bsan --version` succeeds
   */
  protected _isCargoBsanAvailable(env: NodeJS.ProcessEnv): boolean {
    const res = ChildProcess.spawnSync("cargo", ["bsan", "--version"], {
      env,
      stdio: "ignore",
      windowsHide: true,
      timeout: 2000,
    });
    if (res.error) {
      if ("code" in res.error && res.error.code === "ENOENT") {
        return false;
      }
      throw res.error;
    }
    return res.status === 0;
  } // fn: _isCargoBsanAvailable

  /**
   * Checks if rustup lists an installed toolchain named `bsan`.
   *
   * @param env Environment variables to use when spawning rustup
   * @returns True if rustup reports `bsan` in its toolchain list
   */
  protected _isBsanToolchainAvailable(env: NodeJS.ProcessEnv): boolean {
    const res = ChildProcess.spawnSync("rustup", ["toolchain", "list"], {
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
    if (res.status === 0 && res.stdout) {
      return /^bsan\b/m.test(res.stdout);
    }
    return false;
  } // fn: _isBsanToolchainAvailable

  /**
   * Checks if the bsan rustc binary exists in the default ~/.rustup toolchain location.
   *
   * @returns True if ~/.rustup/toolchains/bsan/bin/rustc exists
   */
  protected _hasBsanToolchainDir(): boolean {
    const home = os.homedir();
    const bsanRustc = path.join(
      home,
      ".rustup",
      "toolchains",
      "bsan",
      "bin",
      process.platform === "win32" ? "rustc.exe" : "rustc"
    );
    return fs.existsSync(bsanRustc);
  } // fn: _hasBsanToolchainDir

  /**
   * Searches for llvm-symbolizer binary in the bsan toolchain directory.
   *
   * @returns Absolute path to llvm-symbolizer if found, otherwise undefined
   */
  protected _findSymbolizer(): string | undefined {
    const home = os.homedir();
    const toolchainSymbolizer = path.join(
      home,
      ".rustup",
      "toolchains",
      "bsan",
      "bin",
      process.platform === "win32" ? "llvm-symbolizer.exe" : "llvm-symbolizer"
    );
    if (fs.existsSync(toolchainSymbolizer)) {
      return toolchainSymbolizer;
    }
    return undefined;
  } // fn: _findSymbolizer

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
} // class: BorrowSanitizer
