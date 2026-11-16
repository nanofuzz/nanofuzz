import {
  CoverageMap,
  CoverageMapData,
  createCoverageMap,
  createFileCoverage,
  FileCoverage,
  FileCoverageData,
  Range,
} from "istanbul-lib-coverage";
import { createInstrumenter } from "istanbul-lib-instrument";
import { createSourceMapStore, MapStore } from "istanbul-lib-source-maps";
import { RawSourceMap } from "source-map";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FuzzEnv,
  FuzzTestResult,
  FuzzTestResults,
  InputAndSource,
  VmGlobals,
} from "../Types";
import { normalizePathForKey } from "../Util";
import {
  AbstractRunner,
  Arc,
  PythonCoverageMapData,
  PythonFileCoverageData,
  RunnerCoverage,
} from "../runners/AbstractRunner";
import { isPythonCoverageMapData } from "../runners/python/PythonRunner";
import { AbstractMeasure, BaseMeasurement } from "./AbstractMeasure";

/**
 * Unified, high-performance code coverage measure for NaNofuzz.
 * Tracks statement, function, and branch exit coverage across TypeScript
 * and Python programs using pre-indexed flat array slots for zero-allocation
 * hot-loop delta evaluation and on-demand Istanbul coverage map synthesis.
 */
export class CoverageMeasure extends AbstractMeasure {
  protected _runners: AbstractRunner[] = [];
  protected _globalCoverageMap = createCoverageMap({});
  protected _coverageData?: CoverageMapData = undefined;
  protected _history = new Map<number, CoverageMeasurementNode>();
  protected _lastNode: CoverageMeasurementNode | undefined = undefined;
  protected _sourceMapStore: MapStore = createSourceMapStore();
  protected _hasSourceMaps = false;
  protected _requireRunner = false;

  // Flat Schema and Slot Mapping State
  protected _files = new Map<string, FileSchemaEntry>();
  protected _slots: CoverageSlot[] = [];
  protected _globalHitCounts = new Uint32Array(8192);
  protected _currentTestHitSlots: number[] = [];

  /**
   * Returns the measure's persistent options identifier.
   */
  public override get name(): string {
    return "CoverageMeasure";
  } // property: get name

  /**
   * Lifecycle hook called at the start of a fuzz test campaign.
   * Initializes runner bindings, schema, and reset counters.
   *
   * @param runners array of runner instances
   * @param env optional fuzzer environment
   */
  public override onRunStart(
    runners: AbstractRunner[] | AbstractRunner,
    env?: FuzzEnv
  ): void {
    super.onRunStart(runners, env);
    this._globalCoverageMap = createCoverageMap({});
    this._history.clear();
    this._lastNode = undefined;
    this._files.clear();
    this._slots = [];
    this._globalHitCounts = new Uint32Array(8192);
    this._currentTestHitSlots = [];

    const runnerList = Array.isArray(runners) ? runners : [runners];
    this._runners = runnerList;

    runnerList.forEach((r) => {
      const initialCov = r.coverageInfo;
      if (initialCov) {
        if (isPythonCoverageMapData(initialCov)) {
          this._registerPythonStaticCoverage(initialCov, true);
        } else if (isCoverageMapData(initialCov)) {
          this._registerIstanbulStaticCoverage(initialCov, true);
        }
      }

      r.onCoverage((covData) => {
        this.recordHits(covData);
      });
    });
  } // fn: onRunStart

  /**
   * Instruments source code prior to load to capture code coverage.
   *
   * @param jsSrc input javascript source code
   * @param jsFileName javascript source filename
   * @returns instrumented code
   */
  public override onAfterCompile(jsSrc: string, jsFileName: string): string {
    if (jsSrc.includes("__coverage__") || jsSrc.includes("cov_")) {
      return jsSrc;
    }

    const mapPath = jsFileName + ".map";
    let sourceMap: RawSourceMap | undefined;

    if (fs.existsSync(mapPath)) {
      try {
        sourceMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
        if (sourceMap && Array.isArray(sourceMap.sources)) {
          const cleanDir = path.dirname(
            jsFileName.replace(/([/\\])inst-[^/\\]+\1/, "$1")
          );
          sourceMap.sources = sourceMap.sources.map((s) =>
            path.isAbsolute(s) ? s : path.resolve(cleanDir, s)
          );
        }
      } catch {
        // ignore
      }
    }

    const instrumenter = createInstrumenter({
      produceSourceMap: true,
      coverageGlobalScope: "global",
    });

    const instrumented = instrumenter.instrumentSync(
      jsSrc,
      jsFileName,
      sourceMap
    );

    const combinedSourceMap = instrumenter.lastSourceMap();
    this._sourceMapStore.registerMap(jsFileName, combinedSourceMap);
    const normJsFileName = normalizePathForKey(jsFileName);
    if (normJsFileName !== jsFileName) {
      this._sourceMapStore.registerMap(normJsFileName, combinedSourceMap);
    }
    this._hasSourceMaps = true;

    try {
      fs.writeFileSync(
        jsFileName + ".map",
        JSON.stringify(combinedSourceMap),
        "utf8"
      );
    } catch {
      // ignore
    }

    return instrumented;
  } // fn: onAfterCompile

  /**
   * Connects in-process global coverage data after module load.
   *
   * @param context global environment context
   */
  public override onAfterLoad(context: VmGlobals): void {
    if (
      typeof context.global === "object" &&
      context.global &&
      "__coverage__" in context.global &&
      isCoverageMapData(context.global.__coverage__)
    ) {
      this._coverageData = context.global.__coverage__;
      this._registerIstanbulStaticCoverage(this._coverageData);
    } else {
      throw new Error(
        "global.__coverage__ does not contain a valid CoverageMapData object"
      );
    }
  } // fn: onAfterLoad

  /**
   * Resets active per-test coverage hits before executing the next candidate.
   */
  public override onBeforeNextTestExecution(): void {
    this._currentTestHitSlots = [];
    if (this._coverageData && isCoverageMapData(this._coverageData)) {
      for (const fileKey of Object.keys(this._coverageData)) {
        const fc = this._coverageData[fileKey];
        if (fc.s) {
          for (const k of Object.keys(fc.s)) fc.s[k] = 0;
        }
        if (fc.f) {
          for (const k of Object.keys(fc.f)) fc.f[k] = 0;
        }
        if (fc.b) {
          for (const k of Object.keys(fc.b)) {
            const arr = fc.b[k];
            if (Array.isArray(arr)) {
              for (let i = 0; i < arr.length; i++) arr[i] = 0;
            }
          }
        }
      }
    }
  } // fn: onBeforeNextTestExecution

  /**
   * Ingests coverage execution hits produced by runner workers.
   *
   * @param coverageData raw runner coverage payload
   */
  public recordHits(coverageData: RunnerCoverage | unknown): void {
    if (isPythonCoverageMapData(coverageData)) {
      this._ingestPythonCoverage(coverageData);
    } else if (isRecordOfFileCoverageData(coverageData)) {
      this._ingestIstanbulCoverage(coverageData);
    }
  } // fn: recordHits

  /**
   * Computes code coverage progress for the most recent test execution.
   *
   * @param input test candidate input and metadata
   * @param result fuzz test result
   * @param telemetry optional runner telemetry bag
   * @returns coverage measurement with lazy Istanbul maps
   */
  public override measure(
    input: InputAndSource,
    result: FuzzTestResult,
    telemetry?: { coverageHits?: RunnerCoverage[] }
  ): CoverageMeasurement {
    const measure = super.measure(input, result);

    if (this._requireRunner && this._runners.length === 0) {
      throw new Error("Coverage measure not connected to runner");
    }

    if (telemetry?.coverageHits) {
      for (const hits of telemetry.coverageHits) {
        this.recordHits(hits);
      }
    } else if (
      this._currentTestHitSlots.length === 0 &&
      this._coverageData &&
      isCoverageMapData(this._coverageData)
    ) {
      this._ingestIstanbulCoverage(this._coverageData);
    }

    // Deduplicate hit slot indices for this test
    const hitSlots =
      this._currentTestHitSlots.length <= 16
        ? this._dedupeSmall(this._currentTestHitSlots)
        : Array.from(new Set(this._currentTestHitSlots));
    this._currentTestHitSlots = [];

    // 1. Calculate globalDelta & update run-wide cumulative hit counts
    let globalDelta = 0;
    for (let i = 0; i < hitSlots.length; i++) {
      const slot = hitSlots[i];
      if (this._globalHitCounts[slot] === 0) {
        globalDelta++;
      }
      this._globalHitCounts[slot]++;
    }

    // 2. Lineage resolution for mutation accumDelta
    const pred =
      "tick" in input.source && input.source.tick !== undefined
        ? this._history.get(input.source.tick)
        : undefined;
    if (pred) {
      pred.refCount++;
    }

    let rootNode: CoverageMeasurementNode | undefined = pred;
    while (rootNode && rootNode.pred) {
      rootNode = rootNode.pred;
    }

    let accumDelta = 0;
    if (rootNode) {
      let lineage = rootNode.lineageHitCounts;
      if (!lineage) {
        lineage = new Uint32Array(Math.max(this._slots.length, 4096));
        rootNode.lineageHitCounts = lineage;
      } else if (lineage.length < this._slots.length) {
        const grown = new Uint32Array(Math.max(this._slots.length * 2, 4096));
        grown.set(lineage);
        lineage = grown;
        rootNode.lineageHitCounts = lineage;
      }

      for (let i = 0; i < hitSlots.length; i++) {
        const slot = hitSlots[i];
        if (lineage[slot] === 0) {
          accumDelta++;
        }
        lineage[slot]++;
      }
    }

    let nodeLineage: Uint32Array | undefined;
    if (!pred) {
      nodeLineage = new Uint32Array(Math.max(this._slots.length, 4096));
      for (let i = 0; i < hitSlots.length; i++) {
        nodeLineage[hitSlots[i]]++;
      }
    }

    // 3. Construct measurement with lazy on-demand CoverageMap synthesis
    let cachedCurrent: CoverageMap | undefined;
    let cachedAccum: CoverageMap | undefined;
    const synthesizeCurrent = (): CoverageMap =>
      this._synthesizeMapFromSlots(hitSlots);
    const synthesizeAccum = (): CoverageMap => {
      const activeLineage = rootNode ? rootNode.lineageHitCounts : nodeLineage;
      return this._synthesizeMapFromLineage(activeLineage, hitSlots);
    };

    const meas: CoverageMeasurement = {
      ...measure,
      name: this.name,
      coverageMeasure: {
        globalDelta,
        accumDelta,
        get current(): CoverageMap {
          if (!cachedCurrent) {
            cachedCurrent = synthesizeCurrent();
          }
          return cachedCurrent;
        },
        get accum(): CoverageMap {
          if (!cachedAccum) {
            cachedAccum = synthesizeAccum();
          }
          return cachedAccum;
        },
      },
    };

    // 4. Update history graph & prune dead-end mutation leaves
    const node: CoverageMeasurementNode = {
      input,
      pred,
      meas,
      refCount: 0,
      lineageHitCounts: !pred ? nodeLineage : undefined,
    };

    if (this._lastNode) {
      if (
        this._lastNode.refCount === 0 &&
        this._lastNode.meas.coverageMeasure.globalDelta === 0 &&
        this._lastNode.meas.coverageMeasure.accumDelta === 0
      ) {
        if (this._lastNode.pred) {
          this._lastNode.pred.refCount--;
        }
        this._history.delete(this._lastNode.input.tick);
      }
    }

    this._history.set(input.tick, node);
    this._lastNode = node;

    return meas;
  } // fn: measure

  /**
   * Calculates progress score from global and lineage coverage deltas.
   *
   * @param a coverage measurement
   * @returns progress score
   */
  public override delta(a: CoverageMeasurement): number {
    return Math.max(
      0,
      a.coverageMeasure.globalDelta * 100 + a.coverageMeasure.accumDelta
    );
  } // fn: delta

  /**
   * Checks if coverage data exists for a given input tick.
   *
   * @param tick test input tick
   * @returns true if recorded in history, false otherwise
   */
  public hasCoverage(tick: number): boolean {
    return this._history.has(tick);
  } // fn: hasCoverage

  /**
   * Retrieves recorded coverage measurement for a given input tick.
   *
   * @param tick test input tick
   * @returns coverage measurement
   */
  public getCoverage(tick: number): CoverageMeasurement {
    const node = this._history.get(tick);
    if (node) {
      return node.meas;
    }
    throw new Error(`No coverahe data for "${tick}"`);
  } // fn: getCoverage

  /**
   * Generates CodeCoverageMeasureStats representing coverage accumulated across the run so far.
   */
  public async getCoverageStats(): Promise<CodeCoverageMeasureStats> {
    if (this._files.size === 0) {
      return {
        counters: {
          functionsTotal: 0,
          functionsCovered: 0,
          statementsTotal: 0,
          statementsCovered: 0,
          branchesTotal: 0,
          branchesCovered: 0,
        },
        files: [],
      };
    }

    // 1. Build cumulative CoverageMap from _globalHitCounts
    const fullCoverageMapData: CoverageMapData = {};
    for (const fileEntry of this._files.values()) {
      const fileData: FileCoverageData = {
        ...fileEntry.template,
        path: fileEntry.path,
        statementMap: fileEntry.template.statementMap,
        fnMap: fileEntry.template.fnMap,
        branchMap: fileEntry.template.branchMap,
        s: {},
        f: {},
        b: {},
      };

      for (const k of Object.keys(fileEntry.template.statementMap)) {
        const slot = fileEntry.stmtSlots.get(k);
        fileData.s[k] = slot !== undefined ? this._globalHitCounts[slot] : 0;
      }
      for (const k of Object.keys(fileEntry.template.fnMap)) {
        const slot = fileEntry.fnSlots.get(k);
        fileData.f[k] = slot !== undefined ? this._globalHitCounts[slot] : 0;
      }
      for (const k of Object.keys(fileEntry.template.branchMap)) {
        const len = fileEntry.template.branchMap[k].locations.length;
        const arms: number[] = [];
        for (let j = 0; j < len; j++) {
          const slot = fileEntry.branchSlots.get(`${k}.${j}`);
          arms.push(slot !== undefined ? this._globalHitCounts[slot] : 0);
        }
        fileData.b[k] = arms;
      }

      fullCoverageMapData[fileEntry.path] = fileData;
    }

    const rawGlobalMap = createCoverageMap(fullCoverageMapData);

    // 2. If TypeScript source maps are present on disk or registered, transform back to original TS source
    for (const fileKey of rawGlobalMap.files()) {
      const normKey = normalizePathForKey(fileKey);
      const mapPaths = Array.from(
        new Set([fileKey + ".map", normKey + ".map"])
      );
      const mapPath = mapPaths.find((p) => fs.existsSync(p));
      if (mapPath) {
        try {
          const mapData = JSON.parse(fs.readFileSync(mapPath, "utf8"));
          if (mapData && Array.isArray(mapData.sources)) {
            const cleanDir = path.dirname(
              fileKey.replace(/([/\\])inst-[^/\\]+\1/, "$1")
            );
            mapData.sources = mapData.sources.map((s: string) =>
              path.isAbsolute(s) ? s : path.resolve(cleanDir, s)
            );
          }
          this._sourceMapStore.registerMap(fileKey, mapData);
          if (normKey !== fileKey) {
            this._sourceMapStore.registerMap(normKey, mapData);
          }
        } catch {
          // ignore
        }
      }
    }
    const finalMap = await this._sourceMapStore.transformCoverage(rawGlobalMap);

    // 3. Format per-file stats and summary totals
    const coverageSummary = finalMap.getCoverageSummary();
    const files: CodeCoverageFileStats[] = finalMap.files().map((filePath) => {
      const fileCov = finalMap.fileCoverageFor(filePath);
      const fileSummary = fileCov.toSummary();
      const raw = fileCov.data;
      const data =
        typeof raw === "object" && raw !== null && "data" in raw && isFileCoverageData(raw.data)
          ? raw.data
          : isFileCoverageData(raw)
            ? raw
            : createFileCoverage(filePath).data;
      const fileMap = createFileCoverage(structuredClone(data));

      // Omit functions and branches with no hits
      for (const k of Object.keys(fileMap.f)) {
        if (fileMap.f[k] === 0) delete fileMap.f[k];
      }
      for (const k of Object.keys(fileMap.b)) {
        if (Math.max(...fileMap.b[k]) === 0) delete fileMap.b[k];
      }
      for (const k of Object.keys(fileMap.statementMap)) {
        if (!(k in fileMap.s)) delete fileMap.statementMap[k];
      }
      for (const k of Object.keys(fileMap.branchMap)) {
        if (!(k in fileMap.b)) delete fileMap.branchMap[k];
      }

      return {
        path: normalizePathForKey(filePath),
        counters: {
          functionsTotal: fileSummary.functions.total,
          functionsCovered: fileSummary.functions.covered,
          statementsTotal: fileSummary.statements.total,
          statementsCovered: fileSummary.statements.covered,
          branchesTotal: fileSummary.branches.total,
          branchesCovered: fileSummary.branches.covered,
        },
        fileMap,
      };
    });

    return {
      counters: {
        functionsTotal: coverageSummary.functions.total,
        functionsCovered: coverageSummary.functions.covered,
        statementsTotal: coverageSummary.statements.total,
        statementsCovered: coverageSummary.statements.covered,
        branchesTotal: coverageSummary.branches.total,
        branchesCovered: coverageSummary.branches.covered,
      },
      files,
    };
  } // fn: getCoverageStats

  /**
   * Returns uncovered and partially covered line numbers grouped by normalized file path.
   */
  public async getUncoveredLines(): Promise<UncoveredCoverageInfo> {
    const stats = await this.getCoverageStats();
    return extractUncoveredLines(stats);
  } // fn: getUncoveredLines

  /**
   * Fills in final run-wide coverage statistics at campaign completion.
   *
   * @param results finalized test results collection
   */
  public override onRunEnd(results: FuzzTestResults): void {
    results.stats.measures.CodeCoverageMeasure =
      async (): Promise<CodeCoverageMeasureStats> => {
        return this.getCoverageStats();
      };
  } // fn: onRunEnd

  // ---------------------------------------------------------------------------
  // Static Compatibility & Helper Utilities
  // ---------------------------------------------------------------------------

  public static file_snapshot(data: FileCoverageData): FileCoverageData {
    const fileData = createFileCoverage(data).data;
    const b: FileCoverageData["b"] = {};
    for (const bKey of Object.keys(fileData.b)) {
      b[bKey] = [...fileData.b[bKey]];
    }
    return { ...fileData, s: { ...fileData.s }, f: { ...fileData.f }, b };
  } // fn: file_snapshot

  public static merge(
    accum: CoverageMap,
    new_cov: CoverageMap | CoverageMapData,
    activeFiles?: Set<string> | string[]
  ): number {
    const other = isCoverageMap(new_cov) ? new_cov : createCoverageMap(new_cov);
    let delta = 0;

    const normPathsHolder: { map: Map<string, string> | null } = { map: null };
    const getExistingNormPaths = (): Map<string, string> => {
      if (normPathsHolder.map === null) {
        const map = new Map<string, string>();
        for (const file of accum.files()) {
          map.set(normalizePathForKey(file), file);
        }
        normPathsHolder.map = map;
      }
      return normPathsHolder.map;
    };

    const filesToMerge = activeFiles ? Array.from(activeFiles) : other.files();

    for (const filePath of filesToMerge) {
      let fc: FileCoverage;
      try {
        fc = other.fileCoverageFor(filePath);
      } catch {
        continue;
      }

      let existingPath: string | undefined;
      if (accum.data[fc.path]) {
        existingPath = fc.path;
      } else if (accum.data[filePath]) {
        existingPath = filePath;
      } else {
        const normPath = normalizePathForKey(fc.path);
        existingPath = getExistingNormPaths().get(normPath);
      }

      if (existingPath) {
        const targetFc = accum.fileCoverageFor(existingPath);
        if (fc.s && targetFc.s) {
          for (const k of Object.keys(fc.s)) {
            const val = fc.s[k];
            if (val > 0) {
              if (!targetFc.s[k]) {
                targetFc.s[k] = val;
                delta++;
              } else {
                targetFc.s[k] += val;
              }
            }
          }
        }
        if (fc.f && targetFc.f) {
          for (const k of Object.keys(fc.f)) {
            const val = fc.f[k];
            if (val > 0) {
              if (!targetFc.f[k]) {
                targetFc.f[k] = val;
                delta++;
              } else {
                targetFc.f[k] += val;
              }
            }
          }
        }
        if (fc.b && targetFc.b) {
          for (const k of Object.keys(fc.b)) {
            const srcArr = fc.b[k];
            const targetArr = targetFc.b[k];
            if (srcArr && targetArr) {
              for (let j = 0; j < srcArr.length; j++) {
                const val = srcArr[j];
                if (val > 0) {
                  if (!targetArr[j]) {
                    targetArr[j] = val;
                    delta++;
                  } else {
                    targetArr[j] += val;
                  }
                }
              }
            }
          }
        }
      } else {
        const snapshot = CoverageMeasure.file_snapshot(fc);
        accum.addFileCoverage(snapshot);
        if (normPathsHolder.map !== null) {
          const normPath = normalizePathForKey(fc.path);
          normPathsHolder.map.set(normPath, fc.path);
        }

        if (fc.s) {
          for (const k of Object.keys(fc.s)) {
            if (fc.s[k] > 0) delta++;
          }
        }
        if (fc.f) {
          for (const k of Object.keys(fc.f)) {
            if (fc.f[k] > 0) delta++;
          }
        }
        if (fc.b) {
          for (const k of Object.keys(fc.b)) {
            if (fc.b[k]) {
              for (let j = 0; j < fc.b[k].length; j++) {
                if (fc.b[k][j] > 0) delta++;
              }
            }
          }
        }
      }
    }

    return delta;
  } // fn: merge

  // ---------------------------------------------------------------------------
  // Internal Schema & Synthesis Helpers
  // ---------------------------------------------------------------------------

  protected _allocateSlot(
    entry: FileSchemaEntry,
    type: "s" | "f" | "b",
    id: string
  ): number {
    const slot = this._slots.length;
    this._slots.push({ entry, type, id });
    if (slot >= this._globalHitCounts.length) {
      const nextCap = Math.max(this._globalHitCounts.length * 2, slot + 1);
      const newCounts = new Uint32Array(nextCap);
      newCounts.set(this._globalHitCounts);
      this._globalHitCounts = newCounts;
    }
    return slot;
  } // fn: _allocateSlot

  protected _registerPythonStaticCoverage(
    covinfo: PythonCoverageMapData,
    recordHitsToGlobal: boolean = false
  ): void {
    for (const [filename, fileCov] of Object.entries(covinfo)) {
      const entry = this._getFileEntry(filename, fileCov);
      if (recordHitsToGlobal) {
        if (fileCov.lines) {
          for (const line of fileCov.lines) {
            const slot = entry.lineStmtSlots.get(line);
            if (slot !== undefined) {
              this._globalHitCounts[slot] = Math.max(
                this._globalHitCounts[slot],
                1
              );
            }
          }
        }
        if (fileCov.arcs) {
          for (const arc of fileCov.arcs) {
            const slot = entry.arcSlots.get(`${arc[0]},${arc[1]}`);
            if (slot !== undefined) {
              this._globalHitCounts[slot] = Math.max(
                this._globalHitCounts[slot],
                1
              );
            }
          }
        }
      }
    }
  } // fn: _registerPythonStaticCoverage

  protected _registerIstanbulStaticCoverage(
    covData: CoverageMapData | Record<string, FileCoverageData>,
    recordHitsToGlobal: boolean = false
  ): void {
    for (const [fileKey, fileCov] of Object.entries(covData)) {
      const entry = this._getOrRegisterIstanbulFile(fileKey, fileCov);
      if (recordHitsToGlobal) {
        if (fileCov.s) {
          for (const k of Object.keys(fileCov.s)) {
            const slot = entry.stmtSlots.get(k);
            if (slot !== undefined && fileCov.s[k] > 0) {
              this._globalHitCounts[slot] = Math.max(
                this._globalHitCounts[slot],
                fileCov.s[k]
              );
            }
          }
        }
        if (fileCov.f) {
          for (const k of Object.keys(fileCov.f)) {
            const slot = entry.fnSlots.get(k);
            if (slot !== undefined && fileCov.f[k] > 0) {
              this._globalHitCounts[slot] = Math.max(
                this._globalHitCounts[slot],
                fileCov.f[k]
              );
            }
          }
        }
        if (fileCov.b) {
          for (const k of Object.keys(fileCov.b)) {
            const arms = fileCov.b[k];
            if (Array.isArray(arms)) {
              for (let j = 0; j < arms.length; j++) {
                const slot = entry.branchSlots.get(`${k}.${j}`);
                if (slot !== undefined && arms[j] > 0) {
                  this._globalHitCounts[slot] = Math.max(
                    this._globalHitCounts[slot],
                    arms[j]
                  );
                }
              }
            }
          }
        }
      }
    }
  } // fn: _registerIstanbulStaticCoverage

  protected _getFileEntry(
    filename: string,
    fileCov?: PythonFileCoverageData
  ): FileSchemaEntry {
    const normKey = normalizePathForKey(filename);
    let entry = this._files.get(normKey);
    if (!entry) {
      const parsedCov = fileCov ?? {
        executable: [],
        functions: [],
        branches: [],
      };
      const index = buildPythonFileIndex(filename, parsedCov);
      entry = {
        path: filename,
        template: index.templateData,
        hasStaticCoverage: index.hasStaticCoverage,
        stmtSlots: new Map(),
        fnSlots: new Map(),
        branchSlots: new Map(),
        lineStmtSlots: new Map(),
        fnLinesSlots: [],
        arcSlots: new Map(),
      };

      for (const k of Object.keys(index.templateData.statementMap)) {
        const slot = this._allocateSlot(entry, "s", k);
        entry.stmtSlots.set(k, slot);
      }
      for (const [line, sIdx] of index.lineStmtMap.entries()) {
        const slot = entry.stmtSlots.get(String(sIdx));
        if (slot !== undefined) entry.lineStmtSlots.set(line, slot);
      }

      for (const k of Object.keys(index.templateData.fnMap)) {
        const slot = this._allocateSlot(entry, "f", k);
        entry.fnSlots.set(k, slot);
      }
      for (const fnInfo of index.fnLinesMap) {
        const slot = entry.fnSlots.get(String(fnInfo.fnIdx));
        if (slot !== undefined) {
          entry.fnLinesSlots.push({ slot, lines: fnInfo.lines });
        }
      }

      for (const k of Object.keys(index.templateData.branchMap)) {
        const len = index.templateData.branchMap[k].locations.length;
        for (let j = 0; j < len; j++) {
          const slot = this._allocateSlot(entry, "b", `${k}.${j}`);
          entry.branchSlots.set(`${k}.${j}`, slot);
        }
      }
      for (const [key, target] of index.arcBranchMap.entries()) {
        const slot = entry.branchSlots.get(`${target.bIdx}.${target.eIdx}`);
        if (slot !== undefined) entry.arcSlots.set(key, slot);
      }

      this._files.set(normKey, entry);
    }
    return entry;
  } // fn: _getFileEntry

  protected _getOrRegisterIstanbulFile(
    fileKey: string,
    fileCov: FileCoverageData
  ): FileSchemaEntry {
    const normKey = normalizePathForKey(fileKey);
    let entry = this._files.get(normKey);
    if (!entry) {
      entry = {
        path: fileCov.path ?? fileKey,
        template: {
          ...fileCov,
          path: fileCov.path ?? fileKey,
          statementMap: { ...(fileCov.statementMap ?? {}) },
          fnMap: { ...(fileCov.fnMap ?? {}) },
          branchMap: { ...(fileCov.branchMap ?? {}) },
          s: {},
          f: {},
          b: {},
        },
        hasStaticCoverage: true,
        stmtSlots: new Map(),
        fnSlots: new Map(),
        branchSlots: new Map(),
        lineStmtSlots: new Map(),
        fnLinesSlots: [],
        arcSlots: new Map(),
      };

      if (fileCov.statementMap) {
        for (const k of Object.keys(fileCov.statementMap)) {
          const slot = this._allocateSlot(entry, "s", k);
          entry.stmtSlots.set(k, slot);
          const loc = fileCov.statementMap[k];
          if (loc?.start?.line) entry.lineStmtSlots.set(loc.start.line, slot);
        }
      }

      if (fileCov.fnMap) {
        for (const k of Object.keys(fileCov.fnMap)) {
          const slot = this._allocateSlot(entry, "f", k);
          entry.fnSlots.set(k, slot);
        }
      }

      if (fileCov.branchMap) {
        for (const k of Object.keys(fileCov.branchMap)) {
          const locs = fileCov.branchMap[k]?.locations ?? [];
          for (let j = 0; j < locs.length; j++) {
            const slot = this._allocateSlot(entry, "b", `${k}.${j}`);
            entry.branchSlots.set(`${k}.${j}`, slot);
          }
        }
      }

      this._files.set(normKey, entry);
    }
    return entry;
  } // fn: _getOrRegisterIstanbulFile

  protected _ingestPythonCoverage(covinfo: PythonCoverageMapData): void {
    for (const [filename, fileCov] of Object.entries(covinfo)) {
      const entry = this._getFileEntry(filename, fileCov);
      const lines = fileCov.lines;
      const arcs = fileCov.arcs;

      if (lines && lines.length > 0) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          let sSlot = entry.lineStmtSlots.get(line);
          if (sSlot === undefined && !entry.hasStaticCoverage) {
            const sIdx = String(
              Object.keys(entry.template.statementMap).length
            );
            entry.template.statementMap[sIdx] = wholeLine(line);
            entry.template.s[sIdx] = 0;
            sSlot = this._allocateSlot(entry, "s", sIdx);
            entry.lineStmtSlots.set(line, sSlot);
            entry.stmtSlots.set(sIdx, sSlot);
          }
          if (sSlot !== undefined) {
            this._currentTestHitSlots.push(sSlot);
          }
        }

        for (let i = 0; i < entry.fnLinesSlots.length; i++) {
          const fnInfo = entry.fnLinesSlots[i];
          for (let j = 0; j < lines.length; j++) {
            if (fnInfo.lines.has(lines[j])) {
              this._currentTestHitSlots.push(fnInfo.slot);
              break;
            }
          }
        }
      }

      if (arcs && arcs.length > 0) {
        for (let i = 0; i < arcs.length; i++) {
          const arc = arcs[i];
          const key = `${arc[0]},${arc[1]}`;
          let bSlot = entry.arcSlots.get(key);
          if (
            bSlot === undefined &&
            !entry.hasStaticCoverage &&
            arc[0] > 0 &&
            arc[1] > 0
          ) {
            const bIdx = String(Object.keys(entry.template.branchMap).length);
            const branchEntry = {
              loc: wholeLine(arc[0]),
              type: "branch",
              locations: [wholeLine(arc[1])],
              line: arc[0],
            };
            entry.template.branchMap[bIdx] = branchEntry;
            entry.template.b[bIdx] = [0];
            bSlot = this._allocateSlot(entry, "b", `${bIdx}.0`);
            entry.branchSlots.set(`${bIdx}.0`, bSlot);
            entry.arcSlots.set(key, bSlot);
          }
          if (bSlot !== undefined) {
            this._currentTestHitSlots.push(bSlot);
          }
        }
      }
    }
  } // fn: _ingestPythonCoverage

  protected _ingestIstanbulCoverage(
    coverageData: Record<string, FileCoverageData>
  ): void {
    for (const [fileKey, fileCov] of Object.entries(coverageData)) {
      const entry = this._getOrRegisterIstanbulFile(fileKey, fileCov);
      if (fileCov.s) {
        for (const k of Object.keys(fileCov.s)) {
          if (fileCov.s[k] > 0) {
            const slot = entry.stmtSlots.get(k);
            if (slot !== undefined) this._currentTestHitSlots.push(slot);
          }
        }
      }
      if (fileCov.f) {
        for (const k of Object.keys(fileCov.f)) {
          if (fileCov.f[k] > 0) {
            const slot = entry.fnSlots.get(k);
            if (slot !== undefined) this._currentTestHitSlots.push(slot);
          }
        }
      }
      if (fileCov.b) {
        for (const k of Object.keys(fileCov.b)) {
          const arms = fileCov.b[k];
          if (Array.isArray(arms)) {
            for (let j = 0; j < arms.length; j++) {
              if (arms[j] > 0) {
                const slot = entry.branchSlots.get(`${k}.${j}`);
                if (slot !== undefined) this._currentTestHitSlots.push(slot);
              }
            }
          }
        }
      }
    }
  } // fn: _ingestIstanbulCoverage

  protected _synthesizeMapFromSlots(hitSlots: number[]): CoverageMap {
    const data: CoverageMapData = {};
    const fcByEntry = new Map<FileSchemaEntry, FileCoverageData>();
    for (const entry of this._files.values()) {
      const emptyFc = this._createEmptyFileCoverage(entry);
      data[entry.path] = emptyFc;
      fcByEntry.set(entry, emptyFc);
    }

    for (let i = 0; i < hitSlots.length; i++) {
      const slot = hitSlots[i];
      const info = this._slots[slot];
      if (!info) continue;
      const fc = fcByEntry.get(info.entry);
      if (!fc) continue;

      if (info.type === "s") {
        fc.s[info.id] = (fc.s[info.id] ?? 0) + 1;
      } else if (info.type === "f") {
        fc.f[info.id] = (fc.f[info.id] ?? 0) + 1;
      } else if (info.type === "b") {
        const dot = info.id.indexOf(".");
        const bIdx = info.id.substring(0, dot);
        const arm = Number(info.id.substring(dot + 1));
        if (fc.b[bIdx]) {
          fc.b[bIdx][arm] = (fc.b[bIdx][arm] ?? 0) + 1;
        }
      }
    }

    return createCoverageMap(data);
  } // fn: _synthesizeMapFromSlots

  protected _synthesizeMapFromLineage(
    lineage: Uint32Array | undefined,
    fallbackHits: number[]
  ): CoverageMap {
    if (!lineage) {
      return this._synthesizeMapFromSlots(fallbackHits);
    }

    const data: CoverageMapData = {};
    const fcByEntry = new Map<FileSchemaEntry, FileCoverageData>();
    for (const entry of this._files.values()) {
      const emptyFc = this._createEmptyFileCoverage(entry);
      data[entry.path] = emptyFc;
      fcByEntry.set(entry, emptyFc);
    }

    for (let slot = 0; slot < this._slots.length; slot++) {
      const hits = lineage[slot];
      if (hits > 0) {
        const info = this._slots[slot];
        if (!info) continue;
        const fc = fcByEntry.get(info.entry);
        if (!fc) continue;

        if (info.type === "s") {
          fc.s[info.id] = hits;
        } else if (info.type === "f") {
          fc.f[info.id] = hits;
        } else if (info.type === "b") {
          const dot = info.id.indexOf(".");
          const bIdx = info.id.substring(0, dot);
          const arm = Number(info.id.substring(dot + 1));
          if (fc.b[bIdx]) {
            fc.b[bIdx][arm] = hits;
          }
        }
      }
    }

    return createCoverageMap(data);
  } // fn: _synthesizeMapFromLineage

  protected _createEmptyFileCoverage(entry: FileSchemaEntry): FileCoverageData {
    const s: Record<string, number> = {};
    for (const k of Object.keys(entry.template.statementMap)) s[k] = 0;
    const f: Record<string, number> = {};
    for (const k of Object.keys(entry.template.fnMap)) f[k] = 0;
    const b: Record<string, number[]> = {};
    for (const k of Object.keys(entry.template.branchMap)) {
      b[k] = Array(entry.template.branchMap[k].locations.length).fill(0);
    }
    return {
      path: entry.path,
      statementMap: entry.template.statementMap,
      fnMap: entry.template.fnMap,
      branchMap: entry.template.branchMap,
      s,
      f,
      b,
    };
  } // fn: _createEmptyFileCoverage

  protected _dedupeSmall(arr: number[]): number[] {
    const res: number[] = [];
    for (let i = 0; i < arr.length; i++) {
      if (res.indexOf(arr[i]) === -1) {
        res.push(arr[i]);
      }
    }
    return res;
  } // fn: _dedupeSmall

  /**
   * Translates Python coverage into equivalent Istanbul CoverageMapData.
   */
  public _toCoverageMapData(covinfo: PythonCoverageMapData): CoverageMapData {
    const ret: CoverageMapData = {};
    for (const [filename, fileCov] of Object.entries(covinfo)) {
      const index = buildPythonFileIndex(filename, fileCov);
      const fileData = CoverageMeasure.file_snapshot(index.templateData);
      const lines = fileCov.lines ?? [];
      const arcs = fileCov.arcs ?? [];
      applyHitsToPythonFileCoverage(fileData, index, lines, arcs);
      ret[filename] = fileData;
    }
    return ret;
  } // fn: _toCoverageMapData

  protected _snapshot(): CoverageMapData {
    if (this._coverageData) {
      return structuredClone(this._coverageData);
    }
    const snapshot: CoverageMapData = {};
    for (const entry of this._files.values()) {
      snapshot[entry.path] = structuredClone(entry.template);
    }
    return snapshot;
  } // fn: _snapshot

  protected _snapshotZero(): CoverageMapData {
    const snapshot: CoverageMapData = {};
    for (const entry of this._files.values()) {
      snapshot[entry.path] = this._createEmptyFileCoverage(entry);
    }
    return snapshot;
  } // fn: _snapshotZero

  protected _toNumber(m: CoverageMap): number {
    const summ = m.getCoverageSummary();
    return (
      summ.branches.covered + summ.statements.covered + summ.functions.covered
    );
  } // fn: _toNumber
} // class: CoverageMeasure

// ---------------------------------------------------------------------------
// Python Indexing & Translation Helper Functions
// ---------------------------------------------------------------------------

/**
 * End column for a synthesized statement location in Python.
 */
const END_OF_LINE_COLUMN = Number.MAX_SAFE_INTEGER;

function wholeLine(line: number): Range {
  return {
    start: { line, column: 0 },
    end: { line, column: END_OF_LINE_COLUMN },
  };
} // fn: wholeLine

function buildPythonFileIndex(
  filename: string,
  fileCov: PythonFileCoverageData
): {
  filename: string;
  hasStaticCoverage: boolean;
  lineStmtMap: Map<number, number>;
  fnLinesMap: { fnIdx: number; lines: Set<number> }[];
  arcBranchMap: Map<string, { bIdx: number; eIdx: number }>;
  templateData: FileCoverageData;
} {
  const statementMap: FileCoverageData["statementMap"] = {};
  const s: FileCoverageData["s"] = {};
  const lineStmtMap = new Map<number, number>();

  (fileCov.executable ?? []).forEach((line, i) => {
    statementMap[i] = wholeLine(line);
    s[i] = 0;
    lineStmtMap.set(line, i);
  });

  const fnMap: FileCoverageData["fnMap"] = {};
  const f: FileCoverageData["f"] = {};
  const fnLinesMap: { fnIdx: number; lines: Set<number> }[] = [];

  (fileCov.functions ?? []).forEach((fn, i) => {
    fnMap[i] = {
      name: fn.name,
      decl: wholeLine(fn.declLine),
      loc: {
        start: { line: fn.startLine, column: 0 },
        end: { line: fn.endLine, column: END_OF_LINE_COLUMN },
      },
      line: fn.declLine,
    };
    f[i] = 0;
    fnLinesMap.push({ fnIdx: i, lines: new Set(fn.lines) });
  });

  const branchMap: FileCoverageData["branchMap"] = {};
  const b: FileCoverageData["b"] = {};
  const arcBranchMap = new Map<string, { bIdx: number; eIdx: number }>();

  (fileCov.branches ?? []).forEach((branch, i) => {
    branchMap[i] = {
      loc: wholeLine(branch.line),
      type: "branch",
      locations: branch.exits.map((exit) => wholeLine(exit.line)),
      line: branch.line,
    };
    b[i] = Array(branch.exits.length).fill(0);
    branch.exits.forEach((exit, j) => {
      arcBranchMap.set(`${branch.line},${exit.dest}`, { bIdx: i, eIdx: j });
    });
  });

  const hasStaticCoverage =
    (Array.isArray(fileCov.executable) && fileCov.executable.length > 0) ||
    (Array.isArray(fileCov.functions) && fileCov.functions.length > 0) ||
    (Array.isArray(fileCov.branches) && fileCov.branches.length > 0);

  const templateData: FileCoverageData = {
    path: filename,
    statementMap,
    fnMap,
    branchMap,
    s,
    f,
    b,
  };

  return {
    filename,
    hasStaticCoverage,
    lineStmtMap,
    fnLinesMap,
    arcBranchMap,
    templateData,
  };
} // fn: buildPythonFileIndex

function applyHitsToPythonFileCoverage(
  fileCoverage: FileCoverageData,
  index: {
    lineStmtMap: Map<number, number>;
    fnLinesMap: { fnIdx: number; lines: Set<number> }[];
    arcBranchMap: Map<string, { bIdx: number; eIdx: number }>;
  },
  lines: number[],
  arcs: Arc[]
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sIdx = index.lineStmtMap.get(line);
    if (sIdx !== undefined) {
      fileCoverage.s[sIdx] = 1;
    }
  }

  if (lines.length > 0) {
    for (let i = 0; i < index.fnLinesMap.length; i++) {
      const fnInfo = index.fnLinesMap[i];
      for (let j = 0; j < lines.length; j++) {
        if (fnInfo.lines.has(lines[j])) {
          fileCoverage.f[fnInfo.fnIdx] = 1;
          break;
        }
      }
    }
  }

  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i];
    const key = `${arc[0]},${arc[1]}`;
    const target = index.arcBranchMap.get(key);
    if (target !== undefined) {
      if (!fileCoverage.b[target.bIdx]) {
        fileCoverage.b[target.bIdx] = [];
      }
      fileCoverage.b[target.bIdx][target.eIdx] = 1;
    }
  }
} // fn: applyHitsToPythonFileCoverage

function isCoverageMap(obj: unknown): obj is CoverageMap {
  return obj instanceof CoverageMap;
} // fn: isCoverageMap

// ---------------------------------------------------------------------------
// Exported Types & Type Guards
// ---------------------------------------------------------------------------

interface CoverageSlot {
  entry: FileSchemaEntry;
  type: "s" | "f" | "b";
  id: string;
}

interface FileSchemaEntry {
  path: string;
  template: FileCoverageData;
  hasStaticCoverage: boolean;
  stmtSlots: Map<string, number>;
  fnSlots: Map<string, number>;
  branchSlots: Map<string, number>;
  lineStmtSlots: Map<number, number>;
  fnLinesSlots: { slot: number; lines: Set<number> }[];
  arcSlots: Map<string, number>;
}

export type CoverageMeasurement = BaseMeasurement & {
  name: string;
  coverageMeasure: {
    current: CoverageMap;
    accum: CoverageMap;
    accumDelta: number;
    globalDelta: number;
  };
};

export type CoverageMeasurementNode = {
  input: InputAndSource;
  pred: CoverageMeasurementNode | undefined;
  meas: CoverageMeasurement;
  refCount: number;
  lineageHitCounts?: Uint32Array;
};

export type CodeCoverageCounters = {
  functionsTotal: number;
  functionsCovered: number;
  statementsTotal: number;
  statementsCovered: number;
  branchesTotal: number;
  branchesCovered: number;
};

export type CodeCoverageFileStats = {
  path: string;
  counters: CodeCoverageCounters;
  fileMap: FileCoverage;
};

export type CodeCoverageMeasureStats = {
  counters: CodeCoverageCounters;
  files: CodeCoverageFileStats[];
};

export function isCoverageMapData(obj: unknown): obj is CoverageMapData {
  return (
    obj !== undefined &&
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    Object.values(obj).every(
      (e) =>
        e &&
        e.path &&
        e.statementMap &&
        e.fnMap &&
        e.branchMap &&
        e.s &&
        e.f &&
        e.b
    )
  );
} // fn: isCoverageMapData

export function emptyCoverageMapData(files: string[]): CoverageMapData {
  const cov: CoverageMapData = {};
  files.forEach((file) => {
    cov[file] = {
      path: file,
      statementMap: {},
      fnMap: {},
      branchMap: {},
      s: {},
      f: {},
      b: {},
    };
  });
  return cov;
} // fn: emptyCoverageMapData

export function isRecordOfFileCoverageData(
  val: unknown
): val is Record<string, FileCoverageData> {
  return typeof val === "object" && val !== null;
} // fn: isRecordOfFileCoverageData

function isFileCoverageData(obj: unknown): obj is FileCoverageData {
  return typeof obj === "object" && obj !== null && "statementMap" in obj;
} // fn: isFileCoverageData

/**
 * Summary of uncovered and partially covered lines across files.
 */
export type UncoveredCoverageInfo = {
  uncoveredLinesByFile: Record<string, number[]>;
  partiallyCoveredLinesByFile: Record<string, number[]>;
};

/**
 * Extracts uncovered and partially covered lines from CodeCoverageMeasureStats.
 */
export function extractUncoveredLines(
  covStats: CodeCoverageMeasureStats
): UncoveredCoverageInfo {
  const uncoveredLinesByFile: Record<string, number[]> = {};
  const partiallyCoveredLinesByFile: Record<string, number[]> = {};

  if (covStats.files) {
    for (const file of covStats.files) {
      const fileMap = file.fileMap;
      if (fileMap) {
        const lineStats: Record<
          number,
          { hitCount: number; zeroCount: number }
        > = {};

        if (fileMap.s && fileMap.statementMap) {
          for (const [key, hits] of Object.entries(fileMap.s)) {
            if (fileMap.statementMap[key]) {
              const startLine = fileMap.statementMap[key].start.line;
              if (!lineStats[startLine]) {
                lineStats[startLine] = { hitCount: 0, zeroCount: 0 };
              }
              if (hits > 0) {
                lineStats[startLine].hitCount++;
              } else {
                lineStats[startLine].zeroCount++;
              }
            }
          }
        }

        if (fileMap.b && fileMap.branchMap) {
          for (const [bKey, hitsArr] of Object.entries(fileMap.b)) {
            const bDef = fileMap.branchMap[bKey];
            if (bDef && bDef.locations && Array.isArray(hitsArr)) {
              for (let i = 0; i < bDef.locations.length; i++) {
                const loc = bDef.locations[i];
                if (loc && loc.start && typeof loc.start.line === "number") {
                  const startLine = loc.start.line;
                  if (!lineStats[startLine]) {
                    lineStats[startLine] = { hitCount: 0, zeroCount: 0 };
                  }
                  const armHits = hitsArr[i];
                  if (typeof armHits === "number" && armHits > 0) {
                    lineStats[startLine].hitCount++;
                  } else if (armHits === 0) {
                    lineStats[startLine].zeroCount++;
                  }
                }
              }
            }
          }
        }

        const uncoveredLines: number[] = [];
        const partiallyCoveredLines: number[] = [];

        for (const [lineStr, stats] of Object.entries(lineStats)) {
          const line = Number(lineStr);
          if (stats.zeroCount > 0) {
            if (stats.hitCount === 0) {
              uncoveredLines.push(line);
            } else {
              partiallyCoveredLines.push(line);
            }
          }
        }

        uncoveredLines.sort((a, b) => a - b);
        partiallyCoveredLines.sort((a, b) => a - b);

        const fileKey = normalizePathForKey(file.path);
        if (uncoveredLines.length > 0) {
          uncoveredLinesByFile[fileKey] = uncoveredLines;
        }
        if (partiallyCoveredLines.length > 0) {
          partiallyCoveredLinesByFile[fileKey] = partiallyCoveredLines;
        }
      }
    }
  }

  return { uncoveredLinesByFile, partiallyCoveredLinesByFile };
} // fn: extractUncoveredLines

/**
 * Formats an array of line numbers into concise range strings (e.g. "1-3, 5, 8-10").
 */
export function formatLineRanges(lines: number[]): string {
  if (!lines || lines.length === 0) return "";
  const sorted = Array.from(new Set(lines)).sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    if (curr === prev + 1) {
      prev = curr;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = curr;
      prev = curr;
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(", ");
} // fn: formatLineRanges

export { isPythonCoverageMapData, isPythonCoverageMapData as isFullCoverage };
export { FileCoverage } from "istanbul-lib-coverage";
