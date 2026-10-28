import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as ChildProcess from "node:child_process";
import * as JSONN from "../../../Jsonn";
import { FuzzStatusUpdater } from "../../Types";
import { findInAncestor } from "../../Util";
import * as Config from "../../../Config";
import {
  CompilerStaleness,
  GoCompilerError,
  GoCompilerErrorDetails,
  GoCompilerDiagnosticSpan,
} from "../Types";
import { GoProgram } from "../../analysis/go/GoProgram";

/**
 * A Go compiler wrapper for the go toolchain.
 */
export class GoCompiler {
  protected _moduleFile: string;
  protected _projectPath: string;
  protected _goModPath?: string;
  protected _goPath?: string;
  protected _goVersion?: string;
  protected _options: GoCompilerOptions;
  protected static _canExecuteCache: Map<
    string,
    { result: boolean; expiresAt: number }
  > = new Map();

  constructor(fqModulePath: string) {
    this._moduleFile = fqModulePath;

    if (!fs.existsSync(fqModulePath)) {
      throw new Error(`Cannot find module to compile: ${fqModulePath}`);
    }

    this._goModPath = findInAncestor(path.dirname(this._moduleFile), "go.mod");
    this._projectPath = this._goModPath
      ? path.dirname(this._goModPath)
      : path.dirname(this._moduleFile);

    this._goPath = GoCompiler.resolveGo();
    this._goVersion = GoCompiler.getGoVersion(this._goPath);
    this._options = structuredClone(defaultGoCompilerOptions);
  } // constructor

  public get options(): GoCompilerOptions {
    return structuredClone(this._options);
  }

  public get moduleFile(): string {
    return this._moduleFile;
  }

  public get goModPath(): string | undefined {
    return this._goModPath;
  }

  public get projectPath(): string {
    return this._projectPath;
  }

  public get goPath(): string | undefined {
    return this._goPath;
  }

  public get goVersion(): string | undefined {
    return this._goVersion;
  }

  public getCompiledDependencies(): string[] {
    const deps: string[] = [this._moduleFile];
    const siblings = GoProgram.findLocalSourceFiles(this._moduleFile);
    for (const sib of siblings) {
      if (!deps.includes(sib)) {
        deps.push(sib);
      }
    }
    if (this._goModPath && !deps.includes(this._goModPath)) {
      deps.push(this._goModPath);
    }
    return deps;
  } // fn: getCompiledDependencies

  public isStale(inSrcFile?: string): CompilerStaleness {
    const target = inSrcFile ?? this._moduleFile;
    const recFile = this._getCompilationRecordFilename(target);
    if (!fs.existsSync(recFile)) {
      return "notcompiled";
    }

    try {
      const rec = JSONN.parse<GoCompilationRecord>(
        fs.readFileSync(recFile, "utf-8")
      );
      if (!fs.existsSync(rec.binaryPath)) {
        return "notcompiled";
      }

      const binMtime = fs.statSync(rec.binaryPath).mtimeMs;
      for (const dep of rec.dependencies) {
        if (!fs.existsSync(dep)) {
          return "sourcechanged";
        }
        if (fs.statSync(dep).mtimeMs > binMtime) {
          return "sourcechanged";
        }
      }

      if (rec.goVersion && rec.goVersion !== this._goVersion) {
        return "compilerchanged";
      }

      return false;
    } catch {
      return "notcompiled";
    }
  } // fn: isStale

  public compileSync(updateFn: FuzzStatusUpdater = () => {}): string {
    if (!this._goPath || !GoCompiler.canExecute(this._goPath)) {
      throw new Error(
        "No Go compiler found. Please ensure 'go' is installed and available on PATH or configured via nanofuzz.go.goPath."
      );
    }

    updateFn({
      type: "compiling",
      file: this._moduleFile,
    });

    const isModule = this._goModPath !== undefined;
    const cwd = isModule ? this._projectPath : path.dirname(this._moduleFile);
    const args = isModule
      ? ["vet", "./..."]
      : ["vet", path.basename(this._moduleFile)];

    const res = ChildProcess.spawnSync(this._goPath, args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
    });

    if (res.status !== 0) {
      const stderr = res.stderr || res.stdout || "Go build failed";
      throw parseGoCompilerErrors(stderr, this._moduleFile, [
        this._goPath,
        ...args,
      ].join(" "));
    }

    return this._moduleFile;
  } // fn: compileSync

  public async compileAsync(
    fqModulePath: string = this._moduleFile
  ): Promise<void> {
    return GoCompiler.compileAsync(fqModulePath);
  } // fn: compileAsync

  public static async compileAsync(fqModulePath: string): Promise<void> {
    const compiler = new GoCompiler(fqModulePath);
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
    cacheDir: string = defaultGoCompilerOptions.tmpDir
  ): void {
    if (fs.existsSync(cacheDir)) {
      try {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  } // fn: clean

  public static resolveGo(customPath?: string): string | undefined {
    if (customPath && GoCompiler.canExecute(customPath)) {
      return customPath;
    }

    const cfgPath = Config.get<string>("nanofuzz.go.goPath", "go");
    if (cfgPath && cfgPath !== "go" && GoCompiler.canExecute(cfgPath)) {
      return cfgPath;
    }

    const candidates = [
      "go",
      "/opt/homebrew/bin/go",
      "/usr/local/bin/go",
      "/usr/bin/go",
    ];

    for (const c of candidates) {
      if (GoCompiler.canExecute(c)) {
        return c;
      }
    }

    return undefined;
  } // fn: resolveGo

  public static getGoVersion(goPath?: string): string | undefined {
    if (!goPath) return undefined;
    try {
      const res = ChildProcess.spawnSync(goPath, ["version"], {
        encoding: "utf-8",
        timeout: 3000,
      });
      if (res.status === 0 && res.stdout) {
        const match = /go version\s+([^\s]+)/.exec(res.stdout);
        return match ? match[1] : res.stdout.trim();
      }
    } catch {
      // ignore
    }
    return undefined;
  } // fn: getGoVersion

  public static canExecute(binaryPath?: string): boolean {
    if (!binaryPath) return false;
    const now = Date.now();
    const cached = GoCompiler._canExecuteCache.get(binaryPath);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    try {
      const res = ChildProcess.spawnSync(binaryPath, ["version"], {
        encoding: "utf-8",
        timeout: 3000,
      });
      const result = res.status === 0;
      GoCompiler._canExecuteCache.set(binaryPath, {
        result,
        expiresAt: now + 30000,
      });
      return result;
    } catch {
      GoCompiler._canExecuteCache.set(binaryPath, {
        result: false,
        expiresAt: now + 30000,
      });
      return false;
    }
  } // fn: canExecute

  protected _getCompilationRecordFilename(moduleFile: string): string {
    const dir = path.join(
      fs.realpathSync(os.tmpdir()),
      "nanofuzz",
      "go",
      "records"
    );
    fs.mkdirSync(dir, { recursive: true });
    const safeName = path.basename(moduleFile).replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(dir, `${safeName}.record.json`);
  } // fn: _getCompilationRecordFilename
} // class: GoCompiler

export type GoCompilerOptions = {
  buildFlags?: string[];
  tmpDir: string;
};

export const defaultGoCompilerOptions: GoCompilerOptions = {
  buildFlags: [],
  tmpDir: path.join(fs.realpathSync(os.tmpdir()), "nanofuzz", "go"),
};

type GoCompilationRecord = {
  moduleFile: string;
  binaryPath: string;
  dependencies: string[];
  goVersion?: string;
  compiledAt: string;
};

export function parseGoCompilerErrors(
  output: string,
  inputFile: string,
  commandCli?: string
): GoCompilerError {
  const lines = output.split(/\r?\n/);
  const diagnostics: Array<{
    message: string;
    level?: string;
    span?: GoCompilerDiagnosticSpan;
    rendered?: string;
  }> = [];

  const errorRegex = /^([^:\n]+):(\d+):(\d+):\s*(.*)$/;

  for (const line of lines) {
    const match = errorRegex.exec(line.trim());
    if (match) {
      const file = match[1];
      const lineNum = parseInt(match[2], 10);
      const colNum = parseInt(match[3], 10);
      const message = match[4];
      diagnostics.push({
        message,
        level: "error",
        span: {
          file,
          line: lineNum,
          col: colNum,
        },
        rendered: line,
      });
    }
  }

  const details: GoCompilerErrorDetails = {
    inputFile,
    commandCli,
    output: lines,
    diagnostics,
  };

  return new GoCompilerError(
    diagnostics.length > 0
      ? `Go compilation failed with ${diagnostics.length} error(s)`
      : `Go compilation failed: ${output.trim()}`,
    details
  );
} // fn: parseGoCompilerErrors
