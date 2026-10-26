import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import * as JSONN from "../../../Jsonn";
import { FuzzStatusUpdater } from "../../Types";
import { findInAncestor } from "../../Util";
import * as Config from "../../../Config";
import {
  CompilerStaleness,
  JavaCompilerError,
  JavaCompilerErrorDetails,
} from "../Types";
import { JavaProgram } from "../../analysis/java/JavaProgram";

/**
 * A Java compiler wrapper for javac and Java projects (Maven, Gradle, and standalone).
 */
export class JavaCompiler {
  protected _moduleFile: string;
  protected _projectPath: string;
  protected _pomXmlPath?: string;
  protected _gradleBuildPath?: string;
  protected _projectType: "maven" | "gradle" | "standalone";
  protected _javacPath?: string;
  protected _javaPath?: string;
  protected _javacVersion?: string;
  protected _javaVersion?: string;
  protected _options: JavaCompilerOptions;
  protected static _canExecuteCache: Map<
    string,
    { result: boolean; expiresAt: number }
  > = new Map();

  constructor(fqModulePath: string, options?: Partial<JavaCompilerOptions>) {
    this._moduleFile = fqModulePath;

    if (!fs.existsSync(fqModulePath)) {
      throw new Error(`Cannot find module to compile: ${fqModulePath}`);
    }

    this._pomXmlPath = findInAncestor(
      path.dirname(this._moduleFile),
      "pom.xml"
    );
    this._gradleBuildPath =
      findInAncestor(path.dirname(this._moduleFile), "build.gradle") ??
      findInAncestor(path.dirname(this._moduleFile), "build.gradle.kts");

    if (this._pomXmlPath) {
      this._projectType = "maven";
      this._projectPath = path.dirname(this._pomXmlPath);
    } else if (this._gradleBuildPath) {
      this._projectType = "gradle";
      this._projectPath = path.dirname(this._gradleBuildPath);
    } else {
      this._projectType = "standalone";
      this._projectPath = path.dirname(this._moduleFile);
    }

    this._javacPath = JavaCompiler.resolveJavac();
    this._javaPath = JavaCompiler.resolveJava(this._javacPath);
    this._options = {
      ...structuredClone(defaultJavaCompilerOptions),
      ...(options ?? {}),
    };
  } // constructor

  /**
   * Gets the current compiler options.
   */
  get options(): JavaCompilerOptions {
    return structuredClone(this._options);
  } // get: options

  /**
   * Gets the path to the module file under compilation.
   */
  get moduleFile(): string {
    return this._moduleFile;
  } // get: moduleFile

  /**
   * Gets the path to the ancestor pom.xml if within a Maven project.
   */
  get pomXmlPath(): string | undefined {
    return this._pomXmlPath;
  } // get: pomXmlPath

  /**
   * Gets the path to the ancestor build.gradle if within a Gradle project.
   */
  get gradleBuildPath(): string | undefined {
    return this._gradleBuildPath;
  } // get: gradleBuildPath

  /**
   * Gets the project config file path (pom.xml or build.gradle) if present.
   */
  get projectConfigPath(): string | undefined {
    return this._pomXmlPath ?? this._gradleBuildPath;
  } // get: projectConfigPath

  /**
   * Gets the detected project type.
   */
  get projectType(): "maven" | "gradle" | "standalone" {
    return this._projectType;
  } // get: projectType

  /**
   * Gets the project root directory path.
   */
  get projectPath(): string {
    return this._projectPath;
  } // get: projectPath

  /**
   * Gets the resolved javac path.
   */
  get javacPath(): string | undefined {
    return this._javacPath;
  } // get: javacPath

  /**
   * Gets the resolved java runtime path.
   */
  get javaPath(): string | undefined {
    return this._javaPath;
  } // get: javaPath

  /**
   * Gets the output classes directory for compiled .class files.
   */
  get classesDir(): string {
    const hash = crypto
      .createHash("md5")
      .update(this._projectPath)
      .digest("hex")
      .substring(0, 12);
    return path.join(this._options.tmpDir, "classes", hash);
  } // get: classesDir

  /**
   * Returns clean source file paths for all dependencies required during compilation.
   */
  public getCompiledDependencies(): string[] {
    const deps = [this._moduleFile];

    if (this._projectType === "maven" || this._projectType === "gradle") {
      const srcMainJava = path.join(this._projectPath, "src", "main", "java");
      const srcTestJava = path.join(this._projectPath, "src", "test", "java");

      for (const searchDir of [srcMainJava, srcTestJava]) {
        if (fs.existsSync(searchDir)) {
          try {
            const files = fs.readdirSync(searchDir, { recursive: true });
            for (const f of files) {
              if (typeof f === "string" && f.endsWith(".java")) {
                const full = path.join(searchDir, f);
                if (full !== this._moduleFile && fs.existsSync(full)) {
                  deps.push(full);
                }
              }
            }
          } catch {
            // ignore directory read errors
          }
        }
      }
    } else {
      try {
        const localSourceFiles = JavaProgram.findLocalSourceFiles(
          this._moduleFile
        );
        for (const file of localSourceFiles) {
          if (!deps.includes(file) && fs.existsSync(file)) {
            deps.push(file);
          }
        }
      } catch {
        // ignore discovery errors
      }
    }

    return deps;
  } // fn: getCompiledDependencies

  /**
   * Returns true if any of the source files or configurations have been modified
   * since the most-recent compilation or if no prior compilation has occurred.
   *
   * @param inSrcFile Optional specific source file to check
   * @returns A staleness reason code if re-compilation is needed, or false otherwise.
   */
  public isStale(inSrcFile?: string): CompilerStaleness {
    const compRec = this._getCompilationRecord(this._moduleFile);
    if (!compRec) {
      return "notcompiled";
    }

    if (!fs.existsSync(compRec.classesDir)) {
      return "notcompiled";
    }

    const checkFiles =
      inSrcFile !== undefined ? [inSrcFile] : this.getCompiledDependencies();

    for (const file of checkFiles) {
      if (!fs.existsSync(file)) {
        return "notcompiled";
      }
      const mtime = fs.statSync(file).mtime.toISOString();
      if (file === this._moduleFile && compRec.srcDatetime !== mtime) {
        return "sourcechanged";
      }
      if (new Date(mtime) > new Date(compRec.compiledAt)) {
        return "sourcechanged";
      }
    }

    const configPath = this.projectConfigPath;
    if (configPath) {
      if (!fs.existsSync(configPath)) {
        return "configchanged";
      }
      const configMtime = fs.statSync(configPath).mtime.toISOString();
      if (compRec.configDatetime !== configMtime) {
        return "configchanged";
      }
    }

    const currentJavac = this._javacPath ?? JavaCompiler.resolveJavac();
    if (compRec.javacPath !== (currentJavac ?? "")) {
      return "compilerchanged";
    }

    return false;
  } // fn: isStale

  /**
   * Compiles the Java module and its dependencies synchronously.
   *
   * @param updateFn Optional status updater callback
   * @returns The path to the compiled module file
   */
  public compileSync(updateFn: FuzzStatusUpdater = () => {}): string {
    updateFn({
      type: "compiling",
      file: path.basename(this._moduleFile),
    });

    const javac = this._javacPath ?? JavaCompiler.resolveJavac();
    if (!javac) {
      throw new JavaCompilerError(
        "No Java compiler (javac) found. Please ensure JDK 17+ is installed and on PATH or JAVA_HOME is configured.",
        {
          inputFile: this._moduleFile,
          javacCli: "javac",
          output: ["No Java compiler (javac) found on PATH or JAVA_HOME."],
        }
      );
    }

    const outDir = this.classesDir;
    fs.mkdirSync(outDir, { recursive: true });

    // Build classpath elements
    const cpEntries: string[] = [outDir];

    const runtimeJar = findRuntimeJar(this._projectPath);
    if (runtimeJar) {
      cpEntries.push(runtimeJar);
    }

    if (this._projectType === "maven") {
      const mavenTargetClasses = path.join(
        this._projectPath,
        "target",
        "classes"
      );
      if (fs.existsSync(mavenTargetClasses)) {
        cpEntries.push(mavenTargetClasses);
      }
      const mavenTestClasses = path.join(
        this._projectPath,
        "target",
        "test-classes"
      );
      if (fs.existsSync(mavenTestClasses)) {
        cpEntries.push(mavenTestClasses);
      }
    } else if (this._projectType === "gradle") {
      const gradleClasses = path.join(
        this._projectPath,
        "build",
        "classes",
        "java",
        "main"
      );
      if (fs.existsSync(gradleClasses)) {
        cpEntries.push(gradleClasses);
      }
      const gradleTestClasses = path.join(
        this._projectPath,
        "build",
        "classes",
        "java",
        "test"
      );
      if (fs.existsSync(gradleTestClasses)) {
        cpEntries.push(gradleTestClasses);
      }
    }

    if (this._options.extraClasspath) {
      for (const cp of this._options.extraClasspath) {
        if (fs.existsSync(cp)) {
          cpEntries.push(cp);
        }
      }
    }

    const sep = process.platform === "win32" ? ";" : ":";
    const classpath = cpEntries.join(sep);

    const args: string[] = ["-d", outDir, "-cp", classpath, "-g"];

    if (this._options.release) {
      args.push("--release", this._options.release);
    }

    const sourceFiles = this.getCompiledDependencies();
    args.push(...sourceFiles);

    const cli = `${javac} ${args.join(" ")}`;
    const res = ChildProcess.spawnSync(javac, args, {
      cwd: this._projectPath,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });

    if (res.status !== 0) {
      const errorDetails = parseJavaCompilerOutput(
        res.stdout ?? "",
        res.stderr ?? "",
        this._moduleFile,
        cli,
        this.projectConfigPath
      );
      throw new JavaCompilerError(
        errorDetails.output?.[0] ?? "Java compilation failed",
        errorDetails
      );
    }

    const compRec = this._newCompilationRecord(outDir);
    fs.writeFileSync(
      this._getCompilationRecordFilename(this._moduleFile),
      JSONN.stringify(compRec)
    );

    return this._moduleFile;
  } // fn: compileSync

  /**
   * Compiles the Java file in the background.
   */
  public async compileAsync(
    fqModulePath: string = this._moduleFile
  ): Promise<void> {
    return JavaCompiler.compileAsync(fqModulePath);
  } // fn: compileAsync

  /**
   * Compiles the Java file asynchronously.
   */
  public static async compileAsync(fqModulePath: string): Promise<void> {
    const compiler = new JavaCompiler(fqModulePath);
    await new Promise<void>((resolve, reject) => {
      try {
        compiler.compileSync();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  } // fn: compileAsync

  /**
   * Cleans compilation temp files.
   */
  public static clean(
    tmpDir: string = defaultJavaCompilerOptions.tmpDir
  ): void {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore parallel worker cleanup collisions
      }
    }
  } // fn: clean

  /**
   * Resolves the javac executable location.
   */
  public static resolveJavac(
    candidate?: string,
    env?: Record<string, string | undefined>
  ): string | undefined {
    const configured =
      candidate ?? Config.get<string>("nanofuzz.java.javacPath", "javac");

    const candidates: string[] = [];
    if (configured && configured !== "javac") {
      candidates.push(configured);
    }

    const javaHome = env?.JAVA_HOME ?? process.env.JAVA_HOME;
    if (javaHome) {
      candidates.push(
        path.join(
          javaHome,
          "bin",
          process.platform === "win32" ? "javac.exe" : "javac"
        )
      );
    }

    candidates.push(process.platform === "win32" ? "javac.exe" : "javac");

    for (const bin of candidates) {
      if (JavaCompiler.canExecute(bin, ["-version"], env)) {
        return bin;
      }
    }

    return undefined;
  } // fn: resolveJavac

  /**
   * Resolves the java runtime executable location.
   */
  public static resolveJava(
    candidateOrJavac?: string,
    env?: Record<string, string | undefined>
  ): string | undefined {
    const configured = Config.get<string>("nanofuzz.java.javaPath", "java");

    const candidates: string[] = [];
    if (configured && configured !== "java") {
      candidates.push(configured);
    }

    if (candidateOrJavac && path.isAbsolute(candidateOrJavac)) {
      const dir = path.dirname(candidateOrJavac);
      candidates.push(
        path.join(dir, process.platform === "win32" ? "java.exe" : "java")
      );
    }

    const javaHome = env?.JAVA_HOME ?? process.env.JAVA_HOME;
    if (javaHome) {
      candidates.push(
        path.join(
          javaHome,
          "bin",
          process.platform === "win32" ? "java.exe" : "java"
        )
      );
    }

    candidates.push(process.platform === "win32" ? "java.exe" : "java");

    for (const bin of candidates) {
      if (JavaCompiler.canExecute(bin, ["-version"], env)) {
        return bin;
      }
    }

    return undefined;
  } // fn: resolveJava

  /**
   * Probes whether an executable can be spawned successfully.
   */
  public static canExecute(
    bin: string,
    args: string[] = ["-version"],
    env?: Record<string, string | undefined>
  ): boolean {
    const pathVal = env?.PATH ?? process.env.PATH ?? "";
    const cacheKey = `${bin}:${pathVal}`;
    const cached = JavaCompiler._canExecuteCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    let result: boolean;
    try {
      const res = ChildProcess.spawnSync(bin, args, {
        env: env ? { ...process.env, ...env } : process.env,
        stdio: "ignore",
        windowsHide: true,
        timeout: 2000,
      });
      result = res.status === 0;
    } catch {
      result = false;
    }

    JavaCompiler._canExecuteCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + 60000,
    });

    return result;
  } // fn: canExecute

  protected _getCompilationRecordFilename(moduleFile: string): string {
    const hash = crypto
      .createHash("md5")
      .update(moduleFile)
      .digest("hex")
      .substring(0, 12);
    const base = path.basename(moduleFile, ".java");
    return path.join(this._options.tmpDir, `${base}-${hash}.comp.json5`);
  } // fn: _getCompilationRecordFilename

  protected _getCompilationRecord(
    moduleFile: string
  ): JavaCompilationRecord | undefined {
    const compRecFile = this._getCompilationRecordFilename(moduleFile);
    try {
      if (fs.existsSync(compRecFile)) {
        const compRecRaw = JSONN.parse(fs.readFileSync(compRecFile).toString());
        if (isJavaCompilationRecord(compRecRaw)) {
          return compRecRaw;
        }
      }
    } catch {
      // ignore read/parse errors
    }
    return undefined;
  } // fn: _getCompilationRecord

  protected _newCompilationRecord(classesDir: string): JavaCompilationRecord {
    const srcMtime = fs.statSync(this._moduleFile).mtime.toISOString();
    const configPath = this.projectConfigPath;
    const configMtime = configPath
      ? fs.statSync(configPath).mtime.toISOString()
      : undefined;

    return {
      fileVersion: "JavaCompilationRecord-0.4.0",
      srcFile: this._moduleFile,
      srcDatetime: srcMtime,
      configPath,
      configDatetime: configMtime,
      javacPath: this._javacPath ?? "",
      classesDir,
      compiledAt: new Date().toISOString(),
    };
  } // fn: _newCompilationRecord
} // class: JavaCompiler

// ============================================================================
// Types
// ============================================================================

export type JavaCompilerOptions = {
  tmpDir: string;
  release?: string;
  extraClasspath?: string[];
};

export const defaultJavaCompilerOptions: JavaCompilerOptions = {
  tmpDir: path.join(fs.realpathSync(os.tmpdir()), "nanofuzz", "java"),
  release: "17",
};

export type JavaCompilationRecord = {
  fileVersion: "JavaCompilationRecord-0.4.0";
  srcFile: string;
  srcDatetime: string;
  configPath?: string;
  configDatetime?: string;
  javacPath: string;
  classesDir: string;
  compiledAt: string;
};

// ============================================================================
// Helpers
// ============================================================================

function isJavaCompilationRecord(obj: unknown): obj is JavaCompilationRecord {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !Array.isArray(obj) &&
    "fileVersion" in obj &&
    obj.fileVersion === "JavaCompilationRecord-0.4.0" &&
    "srcFile" in obj &&
    "srcDatetime" in obj &&
    "classesDir" in obj &&
    "compiledAt" in obj
  );
} // fn: isJavaCompilationRecord

/**
 * Parses javac compiler error and warning messages from stdout and stderr.
 *
 * @param stdout javac stdout
 * @param stderr javac stderr
 * @param inputFile Input Java file being compiled
 * @param javacCli Command line invocation string
 * @param projectConfigPath Optional path to project configuration file
 * @returns Structured JavaCompilerErrorDetails
 */
function parseJavaCompilerOutput(
  stdout: string,
  stderr: string,
  inputFile: string,
  javacCli: string,
  projectConfigPath?: string
): JavaCompilerErrorDetails {
  const combined = `${stdout}\n${stderr}`;
  const lines = combined.split(/\r?\n/);

  const diagnostics: NonNullable<JavaCompilerErrorDetails["diagnostics"]> = [];
  const renderedLines: string[] = [];

  const errorHeaderRegex =
    /^(?<file>.+?):(?<line>\d+):\s*(?<level>error|warning):\s*(?<msg>.+)$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(errorHeaderRegex);
    if (match && match.groups) {
      const file = match.groups.file.trim();
      const lineNum = Number(match.groups.line);
      const level = match.groups.level;
      const msg = match.groups.msg.trim();

      const blockLines = [line];
      i++;

      let col = 1;
      if (i < lines.length && !lines[i].match(errorHeaderRegex)) {
        blockLines.push(lines[i]);
        i++;
      }
      if (
        i < lines.length &&
        lines[i].includes("^") &&
        !lines[i].match(errorHeaderRegex)
      ) {
        col = lines[i].indexOf("^") + 1;
        blockLines.push(lines[i]);
        i++;
      }
      while (
        i < lines.length &&
        (lines[i].startsWith(" ") || lines[i].startsWith("\t")) &&
        !lines[i].match(errorHeaderRegex)
      ) {
        blockLines.push(lines[i]);
        i++;
      }

      const rendered = blockLines.join("\n");
      diagnostics.push({
        message: msg,
        level,
        span: {
          file,
          line: lineNum,
          col,
        },
        rendered,
      });
      renderedLines.push(rendered);
      continue;
    } else {
      const trimmed = line.trim();
      if (
        trimmed.length > 0 &&
        !trimmed.endsWith("errors") &&
        !trimmed.endsWith("error") &&
        !trimmed.endsWith("warnings") &&
        !trimmed.endsWith("warning")
      ) {
        renderedLines.push(trimmed);
      }
      i++;
    }
  }

  const output =
    renderedLines.length > 0
      ? renderedLines
      : [stderr || stdout || "Java compilation failed"];

  return {
    inputFile,
    projectConfigPath,
    configFilename: projectConfigPath,
    javacCli,
    cli: javacCli,
    output,
    diagnostics,
  };
} // fn: parseJavaCompilerOutput

/**
 * Locates the nanofuzz-runtime JAR in the repo or build output.
 *
 * @param userProjectPath Project directory being compiled
 * @returns Path to nanofuzz-runtime JAR if found, undefined otherwise
 */
export function findRuntimeJar(userProjectPath?: string): string | undefined {
  const currModuleDir = path.dirname(path.resolve(module.filename));
  const projectRoot = findInAncestor(currModuleDir, "package.json");
  const searchDirs: string[] = [];

  if (userProjectPath) {
    searchDirs.push(
      path.join(userProjectPath, "target"),
      path.join(userProjectPath, "build", "libs")
    );
  }

  if (projectRoot) {
    const rootDir = path.dirname(projectRoot);
    searchDirs.push(
      path.join(rootDir, "packages", "runtime", "java", "target"),
      path.join(rootDir, "build", "extension", "nanofuzz-runtime-java")
    );
  }

  for (const dir of searchDirs) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const files = fs.readdirSync(dir);
      const jar = files.find(
        (f) =>
          f.startsWith("nanofuzz-runtime") &&
          f.endsWith(".jar") &&
          !f.includes("sources") &&
          !f.startsWith("original-")
      );
      if (jar) {
        return fs.realpathSync(path.join(dir, jar));
      }
    }
  }

  return undefined;
} // fn: findRuntimeJar
