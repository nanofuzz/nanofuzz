import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import * as JSONN from "../../../Jsonn";
import * as Config from "../../../Config";
import {
  CompilerStaleness,
  VirgilCompilerError,
  VirgilCompilerErrorDetails,
} from "../Types";

export interface VirgilCompilerOptions {
  tmpDir: string;
}

export const defaultVirgilCompilerOptions: VirgilCompilerOptions = {
  tmpDir: path.join(os.tmpdir(), "nanofuzz", "virgil"),
};

export type VirgilCompilationRecord = {
  srcFile: string;
  srcDatetime: string;
  v3cPath: string;
  compiledAt: string;
};

/**
 * Virgil compiler wrapper around v3c.
 */
export class VirgilCompiler {
  protected _moduleFile: string;
  protected _projectPath: string;
  protected _v3cPath?: string;
  protected _options: VirgilCompilerOptions;
  protected static _canExecuteCache: Map<
    string,
    { result: boolean; expiresAt: number }
  > = new Map();

  constructor(fqModulePath: string) {
    this._moduleFile = fqModulePath;

    if (!fs.existsSync(fqModulePath)) {
      throw new Error(`Cannot find module to compile: ${fqModulePath}`);
    }

    this._projectPath = path.dirname(this._moduleFile);
    this._v3cPath = VirgilCompiler.resolveV3c();
    this._options = structuredClone(defaultVirgilCompilerOptions);
  } // constructor

  get options(): VirgilCompilerOptions {
    return structuredClone(this._options);
  } // get: options

  get moduleFile(): string {
    return this._moduleFile;
  } // get: moduleFile

  get projectPath(): string {
    return this._projectPath;
  } // get: projectPath

  get v3cPath(): string | undefined {
    return this._v3cPath;
  } // get: v3cPath

  public getCompiledDependencies(): string[] {
    return [this._moduleFile];
  } // fn: getCompiledDependencies

  public isStale(): CompilerStaleness {
    const recordFile = this._getCompilationRecordFilename(this._moduleFile);
    if (!fs.existsSync(recordFile)) {
      return "notcompiled";
    }

    try {
      const record = JSONN.parse<VirgilCompilationRecord>(
        fs.readFileSync(recordFile, "utf8")
      );
      if (!fs.existsSync(this._moduleFile)) {
        return "sourcechanged";
      }
      const currentSrcTime = fs.statSync(this._moduleFile).mtime.toISOString();
      if (record.srcDatetime !== currentSrcTime) {
        return "sourcechanged";
      }
      if (this._v3cPath && record.v3cPath !== this._v3cPath) {
        return "compilerchanged";
      }
      return false;
    } catch {
      return "sourcechanged";
    }
  } // fn: isStale

  public compileSync(): string {
    const v3c = this._v3cPath ?? VirgilCompiler.resolveV3c();
    if (!v3c) {
      throw new VirgilCompilerError(
        "Virgil compiler (v3c) not found in environment",
        {
          inputFile: this._moduleFile,
          v3cCli: "v3c",
        }
      );
    }

    const outDir = path.join(
      this._options.tmpDir,
      crypto.createHash("sha256").update(this._moduleFile).digest("hex").slice(0, 16)
    );
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "binary");

    const args = [`-output=${outFile}`, this._moduleFile];
    const cli = `${v3c} ${args.join(" ")}`;

    const res = ChildProcess.spawnSync(v3c, args, {
      cwd: this._projectPath,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });

    if (res.status !== 0) {
      const errorDetails = parseVirgilCompilerOutput(
        res.stdout ?? "",
        res.stderr ?? "",
        this._moduleFile,
        cli
      );
      throw new VirgilCompilerError(
        errorDetails.output?.[0] ?? "Virgil compilation failed",
        errorDetails
      );
    }

    const compRec = this._newCompilationRecord();
    fs.writeFileSync(
      this._getCompilationRecordFilename(this._moduleFile),
      JSONN.stringify(compRec)
    );

    return outFile;
  } // fn: compileSync

  public async compileAsync(
    fqModulePath: string = this._moduleFile
  ): Promise<void> {
    return VirgilCompiler.compileAsync(fqModulePath);
  } // fn: compileAsync

  public static async compileAsync(fqModulePath: string): Promise<void> {
    const compiler = new VirgilCompiler(fqModulePath);
    await new Promise<void>((resolve, reject) => {
      try {
        compiler.compileSync();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  } // fn: compileAsync

  public static clean(
    tmpDir: string = defaultVirgilCompilerOptions.tmpDir
  ): void {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore parallel cleanup collisions
      }
    }
  } // fn: clean

  public static resolveV3c(
    candidate?: string,
    env: Record<string, string | undefined> = process.env
  ): string | undefined {
    const configured =
      candidate ??
      Config.get<string | undefined>("nanofuzz.virgil.v3cPath", undefined);

    if (configured && configured !== "v3c" && isExecutable(configured)) {
      return configured;
    }

    // Check VIRGIL_LOC/bin/v3c
    const virgilLoc = env["VIRGIL_LOC"];
    if (virgilLoc) {
      const v3cInLoc = path.join(virgilLoc, "bin", "v3c");
      if (isExecutable(v3cInLoc)) {
        return v3cInLoc;
      }
    }

    // Check system PATH
    const pathVal =
      Object.entries(env).find(
        ([k]) => k.toLowerCase() === "path"
      )?.[1] ?? "";

    const pathDirs = pathVal.split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
      const target = path.join(dir, "v3c");
      if (isExecutable(target)) {
        return target;
      }
    }

    return undefined;
  } // fn: resolveV3c

  protected _getCompilationRecordFilename(moduleFile: string): string {
    const hash = crypto.createHash("sha256").update(moduleFile).digest("hex");
    const recordsDir = path.join(this._options.tmpDir, "records");
    fs.mkdirSync(recordsDir, { recursive: true });
    return path.join(recordsDir, `${hash}.json`);
  } // fn: _getCompilationRecordFilename

  protected _newCompilationRecord(): VirgilCompilationRecord {
    return {
      srcFile: this._moduleFile,
      srcDatetime: fs.existsSync(this._moduleFile)
        ? fs.statSync(this._moduleFile).mtime.toISOString()
        : "",
      v3cPath: this._v3cPath ?? "",
      compiledAt: new Date().toISOString(),
    };
  } // fn: _newCompilationRecord
} // class: VirgilCompiler

function isExecutable(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
} // fn: isExecutable

/**
 * Parses compiler error diagnostics from v3c compiler output.
 * Format typically: "<file>:<line>:<col>: <message>"
 */
export function parseVirgilCompilerOutput(
  stdout: string,
  stderr: string,
  inputFile: string,
  v3cCli: string
): VirgilCompilerErrorDetails {
  const combined = `${stderr}\n${stdout}`.trim();
  const lines = combined.split("\n").filter((l) => l.trim().length > 0);
  const diagnostics: NonNullable<VirgilCompilerErrorDetails["diagnostics"]> = [];

  const locRegex = /^([^:\n]+):(\d+):(\d+):\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = locRegex.exec(combined)) !== null) {
    const file = match[1].trim();
    const line = parseInt(match[2], 10);
    const col = parseInt(match[3], 10);
    const msg = match[4].trim();

    diagnostics.push({
      message: msg,
      level: msg.toLowerCase().startsWith("warning") ? "warning" : "error",
      span: {
        file,
        line,
        col,
      },
      rendered: match[0].trim(),
    });
  }

  return {
    inputFile,
    v3cCli,
    output: lines.length > 0 ? lines : ["Compilation failed"],
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
  };
} // fn: parseVirgilCompilerOutput
