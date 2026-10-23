import fs from "node:fs";
import path from "node:path";
import {
  AbstractRunner,
  RunnerCoverage,
  RunnerOverrides,
  RunnerResult,
  ValidatorResult,
} from "../AbstractRunner";
import { CoverageMapData, FileCoverageData } from "istanbul-lib-coverage";
import { isRecordOfFileCoverageData } from "../../measures/CoverageMeasure";
import { FuzzEnv } from "../../Types";
import { normalizePathForKey } from "../../Util";
import * as JSONN from "../../../Jsonn";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import { JavaProgram } from "../../analysis/java/JavaProgram";
import {
  JavaCompiler,
  findRuntimeJar,
} from "../../compilers/java/JavaCompiler";
import { JavaHost } from "./JavaHost";
import {
  buildJavaHarness,
  mapDynamicCoverage,
  JavaBranchSpec,
  JacocoClassCoverage,
} from "./JavaHarness";

/**
 * Test runner for compiled Java targets executed in a persistent JVM host process.
 */
export class JavaRunner extends AbstractRunner {
  protected _filename: string;
  protected _fn: string;
  protected _env: FuzzEnv | undefined;
  protected _overrides: RunnerOverrides;
  protected _host: JavaHost | undefined = undefined;
  protected _seq = 0;
  protected _compiler?: JavaCompiler = undefined;
  protected _classesDir?: string = undefined;
  protected _fqClassName?: string = undefined;
  protected _coverageInfo?: CoverageMapData = undefined;
  protected _staticCoverage?: CoverageMapData = undefined;
  protected _lastRunCoverage?: CoverageMapData = undefined;
  protected _branchSpecsMap?: Record<string, JavaBranchSpec[]> = undefined;
  protected _pgmFiles: string[] = [];
  protected _coverageEnabled = true;
  protected _coverageCallback?: (covData: unknown) => void;

  constructor(
    filename: string,
    fn: string,
    env?: FuzzEnv,
    overrides: RunnerOverrides = {}
  ) {
    super(fn);
    this._filename = filename;
    this._fn = fn;
    this._env = env;
    this._overrides = overrides;
  } // constructor

  /**
   * Returns the source filename associated with this runner.
   */
  public override get filename(): string | undefined {
    return this._filename;
  } // get: filename

  /**
   * Returns accumulated coverage info, if available.
   */
  public override get coverageInfo(): RunnerCoverage | undefined {
    return this._coverageInfo;
  } // get: coverageInfo

  /**
   * Returns the coverage info from the most recent test run execution.
   */
  public override get lastRunCoverage(): RunnerCoverage | undefined {
    return this._lastRunCoverage;
  } // get: lastRunCoverage

  /**
   * Registers a callback to receive coverage hits after each test execution.
   */
  public override onCoverage(callback: (covData: unknown) => void): void {
    this._coverageCallback = callback;
  } // fn: onCoverage

  /**
   * Prepares the runner, compiles the target if stale, and launches the JVM daemon host.
   */
  public override async onRunStart(): Promise<void> {
    await super.onRunStart();
    this.killHost();
    this._staticCoverage = undefined;

    if (this._env?.options?.measures?.CoverageMeasure?.enabled !== undefined) {
      this._coverageEnabled =
        this._env.options.measures.CoverageMeasure.enabled;
    }

    this._compiler = new JavaCompiler(this._filename);
    if (this._compiler.isStale()) {
      this._compiler.compileSync();
    }
    this._classesDir = this._compiler.classesDir;

    const pgm = ProgramFactory.fromFile(this._filename, "java");
    if (pgm instanceof JavaProgram) {
      this._fqClassName = pgm.getFqClassName(this._fn);
    } else {
      this._fqClassName = path.basename(this._filename, ".java");
    }

    const { staticCov, staticCovMap, branchSpecsMap } = buildJavaHarness(
      this._filename,
      this._fn,
      this._env
    );
    this._branchSpecsMap = branchSpecsMap;
    const allStaticCov = staticCovMap ?? { [this._filename]: staticCov };
    this._coverageInfo = { ...allStaticCov };
    for (const [fPath, sCov] of Object.entries(allStaticCov)) {
      const normKey = normalizePathForKey(fPath);
      if (normKey !== fPath) {
        this._coverageInfo[normKey] = sCov;
      }
    }
    this._staticCoverage = structuredClone(this._coverageInfo);
    this._pgmFiles = Object.keys(allStaticCov);

    await this._getHost();
  } // fn: onRunStart

  /**
   * Runs the target method in the JVM daemon host with the given inputs.
   *
   * @param inputs Array of argument values
   * @param timeout Execution timeout in ms
   * @param validators Optional list of companion validator function names
   * @returns RunnerResult containing value, error, skip, or timeout
   */
  public async run(
    inputs: unknown[],
    timeout: number | undefined = 0,
    validators: string[] = []
  ): Promise<RunnerResult> {
    const thisSeq = this._seq++;

    try {
      const host = await this._getHost();

      const input = {
        seq: thisSeq,
        args: inputs,
        timeout: timeout ?? 0,
        validators: validators.length > 0 ? validators : undefined,
        fnName: this._fn,
        className: this._fqClassName,
      };

      const encoded = JSONN.pack(input);
      host.sendMessage(
        Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength)
      );

      const numFunctions = 1 + (validators?.length ?? 0);
      const hostTimeout =
        timeout && timeout > 0 ? timeout * numFunctions + 1000 : Infinity;
      const rawResBuf = await host.getResponseBuffer(hostTimeout);
      const hostPayload: JavaHostResponse = JSONN.unpack(rawResBuf);

      if (this._coverageEnabled && hostPayload.coverageError) {
        throw new Error(
          `JavaRunnerHost coverage collection error: ${hostPayload.coverageError}`
        );
      }

      // Ingest dynamic coverage data if present
      let dynamicCoverage: Record<string, FileCoverageData> | undefined;
      if (hostPayload.jacocoCoverage && this._staticCoverage) {
        dynamicCoverage = mapDynamicCoverage(
          this._staticCoverage,
          hostPayload.jacocoCoverage,
          this._branchSpecsMap
        );
      } else if (
        hostPayload.coverageData &&
        isRecordOfFileCoverageData(hostPayload.coverageData)
      ) {
        dynamicCoverage = hostPayload.coverageData;
      }

      if (this._coverageEnabled && this._coverageInfo && dynamicCoverage) {
        this._lastRunCoverage = dynamicCoverage;
        for (const fileKey of Object.keys(dynamicCoverage)) {
          const fileCov = dynamicCoverage[fileKey];
          const normKey = normalizePathForKey(fileKey);
          const target =
            this._coverageInfo[normKey] ?? this._coverageInfo[fileKey];
          if (target) {
            if (fileCov.s && target.s) {
              for (const sk of Object.keys(fileCov.s)) {
                target.s[sk] = (target.s[sk] ?? 0) + (fileCov.s[sk] ?? 0);
              }
            }
            if (fileCov.f && target.f) {
              for (const fk of Object.keys(fileCov.f)) {
                target.f[fk] = (target.f[fk] ?? 0) + (fileCov.f[fk] ?? 0);
              }
            }
            if (fileCov.b && target.b) {
              for (const bk of Object.keys(fileCov.b)) {
                if (!target.b[bk]) {
                  target.b[bk] = [...(fileCov.b[bk] ?? [])];
                } else if (Array.isArray(fileCov.b[bk])) {
                  for (let i = 0; i < fileCov.b[bk].length; i++) {
                    target.b[bk][i] =
                      (target.b[bk][i] ?? 0) + (fileCov.b[bk][i] ?? 0);
                  }
                }
              }
            }
          }
        }
        this._coverageCallback?.(dynamicCoverage);
      }

      const seq =
        typeof hostPayload.seq === "number" ? hostPayload.seq : thisSeq;
      const hostValidators = hostPayload.validators;
      let resultInner: RunnerResult["result"];

      if (hostPayload.tag === "timeout") {
        this.killHost();
        resultInner = {
          tag: "timeout",
          seq,
          ...(hostValidators ? { validators: hostValidators } : {}),
        };
      } else if (hostPayload.tag === "skip") {
        resultInner = {
          tag: "skip",
          message: hostPayload.message ?? "",
          seq,
          ...(hostValidators ? { validators: hostValidators } : {}),
        };
      } else if (hostPayload.tag === "error") {
        resultInner = {
          tag: "error",
          name: hostPayload.name ?? "Error",
          message: hostPayload.message ?? "",
          stack: hostPayload.stack,
          source: hostPayload.source ?? "put",
          seq,
          ...(hostValidators ? { validators: hostValidators } : {}),
        };
      } else {
        resultInner = {
          tag: "value",
          value: hostPayload.value,
          seq,
          ...(hostValidators ? { validators: hostValidators } : {}),
        };
      }

      return {
        result: resultInner,
        env: {},
      };
    } catch (e: unknown) {
      this.killHost();
      const isTimeout =
        e instanceof Error &&
        (e.name === "PutTimeout" || e.message.includes("did not respond"));

      if (isTimeout) {
        return {
          result: {
            tag: "timeout",
            seq: thisSeq,
          },
          env: {},
        };
      }

      throw e;
    }
  } // fn: run

  /**
   * Internal getter that returns or spawns the JavaHost daemon process.
   */
  protected override async _getHost(): Promise<JavaHost> {
    if (this._host && this._host.isActive) {
      return this._host;
    }

    this.killHost();

    if (!this._compiler) {
      this._compiler = new JavaCompiler(this._filename);
    }

    const javaBin =
      this._compiler.javaPath ?? JavaCompiler.resolveJava() ?? "java";
    const projectPath = this._compiler.projectPath;
    const classesDir = this._classesDir ?? this._compiler.classesDir;

    const runtimeJar =
      findRuntimeJar(projectPath) ??
      path.resolve("./packages/runtime/java/target/nanofuzz-runtime-0.4.0.jar");

    const cpEntries: string[] = [];
    if (fs.existsSync(runtimeJar)) {
      cpEntries.push(runtimeJar);
    }
    if (classesDir && fs.existsSync(classesDir)) {
      cpEntries.push(classesDir);
    }

    if (this._compiler.projectType === "maven") {
      const targetClasses = path.join(projectPath, "target", "classes");
      if (fs.existsSync(targetClasses)) cpEntries.push(targetClasses);
      const testClasses = path.join(projectPath, "target", "test-classes");
      if (fs.existsSync(testClasses)) cpEntries.push(testClasses);
    } else if (this._compiler.projectType === "gradle") {
      const mainClasses = path.join(
        projectPath,
        "build",
        "classes",
        "java",
        "main"
      );
      if (fs.existsSync(mainClasses)) cpEntries.push(mainClasses);
      const testClasses = path.join(
        projectPath,
        "build",
        "classes",
        "java",
        "test"
      );
      if (fs.existsSync(testClasses)) cpEntries.push(testClasses);
    }

    const extraClasspath = this._compiler.options.extraClasspath;
    if (extraClasspath) {
      for (const cp of extraClasspath) {
        if (fs.existsSync(cp)) cpEntries.push(cp);
      }
    }

    const sep = process.platform === "win32" ? ";" : ":";
    const classpath = cpEntries.join(sep);

    const fqClass = this._fqClassName ?? path.basename(this._filename, ".java");
    const args = [
      "-ea",
      "-cp",
      classpath,
      "com.nanofuzz.runtime.runner.JavaRunnerHost",
      fqClass,
      this._fn,
      classesDir,
    ];

    this._host = new JavaHost(javaBin, args, projectPath, process.env, () => {
      this._host = undefined;
    });

    return this._host;
  } // fn: _getHost

  /**
   * Kills the running JVM host process if active.
   */
  public override killHost(): void {
    if (this._host) {
      const h = this._host;
      this._host = undefined;
      h.kill();
    }
  } // fn: killHost

  /**
   * Cleans up runner resources at the end of a fuzz campaign.
   */
  public override async onRunEnd(): Promise<void> {
    await super.onRunEnd();
    this.killHost();
  } // fn: onRunEnd
} // class: JavaRunner

// ============================================================================
// Types
// ============================================================================

type JavaHostResponse = {
  tag: "value" | "error" | "skip" | "timeout";
  seq?: number;
  value?: unknown;
  name?: string;
  message?: string;
  stack?: string;
  source?: "put" | "host";
  validators?: Record<string, ValidatorResult>;
  coverageData?: unknown;
  jacocoCoverage?: Record<string, JacocoClassCoverage>;
  coverageError?: string;
};
