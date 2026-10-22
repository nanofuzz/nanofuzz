import * as fs from "node:fs";
import * as path from "node:path";
import * as ProgramFactory from "./ProgramFactory";
import { normalizePathForKey } from "../Util";
import {
  CodeCoverageMeasureStats,
  CoverageMeasure,
  UncoveredCoverageInfo,
  formatLineRanges,
} from "../measures/CoverageMeasure";
import { FunctionDef } from "./FunctionDef";
import { FunctionRef } from "./Types";
import { Leaderboard } from "../generators/Leaderboard";
import { InputAndSource } from "../Types";
import * as ValueMapper from "../mappers/ValueMapper";

/**
 * Probabilistically samples code targets from the execution frontier
 * (partially covered functions or callsites) to guide input generation
 * towards unexplored branches without getting stuck on unreachable code.
 */
export class CoverageFrontierSampler {
  public static readonly DEFAULT_MAX_CHARS = 2000;
  public static readonly DECAY_FACTOR = 0.5;
  private static _fileCache = new Map<string, CachedFileInfo>();

  /**
   * Samples a frontier code target probabilistically using weighted roulette-wheel selection.
   *
   * @param options Sampling options including coverage stats, attempts map, and PRNG
   * @returns Sampled target with code snippet or undefined if no candidates exist
   */
  public static sample(
    options: FrontierSampleOptions
  ): SampledFrontierTarget | undefined {
    const candidates = CoverageFrontierSampler.getCandidates(options);
    if (candidates.length === 0) {
      return undefined;
    }

    const prng = options.prng ?? Math.random;
    const selected = selectWeightedCandidate(candidates, prng);
    if (!selected) {
      return undefined;
    }

    // Record attempt to decay weight on subsequent turns
    const currentAttempts = options.targetAttempts[selected.targetId] ?? 0;
    options.targetAttempts[selected.targetId] = currentAttempts + 1;

    const reachingInputs: string[] =
      options.leaderboard && options.covMeasure && options.targetFn
        ? findReachingInputs(
            selected,
            options.leaderboard,
            options.covMeasure,
            options.targetFn
          )
        : [];

    const maxChars =
      options.maxSnippetChars ?? CoverageFrontierSampler.DEFAULT_MAX_CHARS;
    const targetLines =
      selected.partialLines.length > 0
        ? selected.partialLines
        : selected.uncoveredLines;
    const { codeSnippet, isSliced } = prepareCodeSnippet(
      selected.src,
      selected.startLine,
      targetLines,
      maxChars
    );

    const displayPath = path.isAbsolute(selected.filePath)
      ? path.relative(process.cwd(), selected.filePath) || selected.filePath
      : selected.filePath;

    let callChain: CallChainFrame[] | undefined;
    if (options.targetFn && selected.functionName) {
      const selectedNorm = normalizePathForKey(selected.filePath);
      const targetNorm = normalizePathForKey(options.targetFn.getModule());
      const selectedKey = `${selectedNorm}:${selected.functionName}`;
      const entryKey = `${targetNorm}:${options.targetFn.getName()}`;

      if (selectedKey !== entryKey) {
        const targetProg = ProgramFactory.fromFile(
          options.targetFn.getModule()
        );
        const callPath = targetProg.getCallPath(
          options.targetFn.getName(),
          selectedKey
        );
        if (callPath && callPath.length > 1) {
          const callerFrames = callPath.slice(0, -1);
          // Cap at most 2 caller frames (entry function and immediate caller if chain is deep)
          const framesToRender =
            callerFrames.length <= 2
              ? callerFrames
              : [callerFrames[0], callerFrames[callerFrames.length - 1]];

          callChain = [];
          for (let i = 0; i < framesToRender.length; i++) {
            const frame = framesToRender[i];
            const nextFrameInPath = callPath[callPath.indexOf(frame) + 1] ?? {
              functionName: selected.functionName,
            };

            const fnRef =
              frame.program.functions[frame.functionName]?.getRef() ??
              frame.program.functionsExported[frame.functionName]?.getRef() ??
              frame.program.functionsNotSupported[frame.functionName]?.function;

            if (fnRef && fnRef.src) {
              const lineOffsets = computeLineOffsets(frame.program.src);
              const callerStartLine = findLineNumber(
                fnRef.startOffset,
                lineOffsets
              );
              const callSiteLine = findCallSiteLine(
                fnRef.src,
                callerStartLine,
                nextFrameInPath.functionName
              );
              const { codeSnippet: callerSnippet, isSliced: callerSliced } =
                prepareCodeSnippet(
                  fnRef.src,
                  callerStartLine,
                  [callSiteLine],
                  1000
                );

              const frameDisplayPath = path.isAbsolute(frame.filePath)
                ? path.relative(process.cwd(), frame.filePath) || frame.filePath
                : frame.filePath;

              callChain.push({
                filePath: frame.filePath,
                displayPath: frameDisplayPath,
                functionName: frame.functionName,
                callSite: nextFrameInPath.functionName,
                codeSnippet: callerSnippet,
                isSliced: callerSliced,
              });
            }
          }
        }
      }
    }

    return {
      targetId: selected.targetId,
      filePath: selected.filePath,
      displayPath,
      functionName: selected.functionName,
      startLine: selected.startLine,
      endLine: selected.endLine,
      uncoveredLines: selected.uncoveredLines,
      partialLines: selected.partialLines,
      reachingInputs,
      codeSnippet,
      isSliced,
      callChain,
    };
  } // fn: sample

  /**
   * Identifies and scores all candidate targets across files with uncovered lines.
   *
   * @param options Sampling options
   * @returns Array of candidate targets with decayed weights
   */
  public static getCandidates(
    options: FrontierSampleOptions
  ): FrontierCandidate[] {
    const candidates: FrontierCandidate[] = [];

    let reachableFunctionKeys: Set<string> | undefined;
    if (options.targetFn) {
      const targetProg = ProgramFactory.fromFile(options.targetFn.getModule());
      reachableFunctionKeys = targetProg.getReachableFunctions(
        options.targetFn.getName()
      );
    }

    const fileExecutionMap = new Map<string, boolean>();
    if (options.covStats.files) {
      for (const f of options.covStats.files) {
        const norm = normalizePathForKey(f.path);
        fileExecutionMap.set(norm, f.counters.statementsCovered > 0);
      }
    }

    const candidateFiles = new Set<string>([
      ...Object.keys(options.uncoveredInfo.uncoveredLinesByFile ?? {}),
      ...Object.keys(options.uncoveredInfo.partiallyCoveredLinesByFile ?? {}),
    ]);

    for (const fileKey of candidateFiles) {
      const normalizedPath = fileKey.replace(/\\/g, "/");
      if (
        TEST_FRAMEWORK_PATH_PARTS.some((part) => normalizedPath.includes(part))
      ) {
        continue;
      }

      const stat = fs.existsSync(fileKey) ? fs.statSync(fileKey) : undefined;
      if (!stat) {
        continue;
      }

      const uncoveredLines =
        options.uncoveredInfo.uncoveredLinesByFile[fileKey] ?? [];
      const partialLines =
        options.uncoveredInfo.partiallyCoveredLinesByFile[fileKey] ?? [];
      if (uncoveredLines.length === 0 && partialLines.length === 0) {
        continue;
      }

      const fileExecuted =
        fileExecutionMap.get(normalizePathForKey(fileKey)) ?? false;

      const normKey = normalizePathForKey(fileKey);

      let cached = CoverageFrontierSampler._fileCache.get(normKey);
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        cached = analyzeFile(fileKey, stat.mtimeMs);
        CoverageFrontierSampler._fileCache.set(normKey, cached);
      }

      const fileStats = options.covStats.files?.find(
        (f) => normalizePathForKey(f.path) === normKey
      );
      const coveredLinesInFile = new Set<number>();
      if (fileStats?.fileMap?.s && fileStats?.fileMap?.statementMap) {
        for (const [key, hits] of Object.entries(fileStats.fileMap.s)) {
          if (hits > 0 && fileStats.fileMap.statementMap[key]) {
            coveredLinesInFile.add(
              fileStats.fileMap.statementMap[key].start.line
            );
          }
        }
      }

      const isTargetModule =
        options.targetFn !== undefined &&
        normKey === normalizePathForKey(options.targetFn.getModule());
      const targetFnName = options.targetFn?.getName();

      let functionsFoundForFile = 0;

      for (const fn of cached.functions) {
        const fnUncovered = uncoveredLines.filter(
          (l) => l >= fn.startLine && l <= fn.endLine
        );
        const fnPartial = partialLines.filter(
          (l) => l >= fn.startLine && l <= fn.endLine
        );

        if (fnUncovered.length === 0 && fnPartial.length === 0) {
          continue;
        }

        const fnCoveredCount =
          coveredLinesInFile.size > 0
            ? Array.from(coveredLinesInFile).filter(
                (l) => l >= fn.startLine && l <= fn.endLine
              ).length
            : 0;

        // Active frontier if partial branch exists OR entered with partial statement hits (handles broken Istanbul branch coverage)
        const isFrontier =
          fnPartial.length > 0 ||
          (fnCoveredCount > 0 && fnUncovered.length > 0);

        const isTargetFn = isTargetModule && fn.name === targetFnName;
        const fnKey = `${normKey}:${fn.name}`;
        const isReachable =
          reachableFunctionKeys !== undefined
            ? reachableFunctionKeys.has(fnKey)
            : undefined;

        // If targetFn is specified, discard functions that are not reachable from targetFn
        if (isReachable === false) {
          continue;
        }

        // Option 3A: Require at least 1 execution hit. Functions with 0 hits cannot be sampled.
        const hasExecutionHits = isFrontier || fnCoveredCount > 0 || isTargetFn;

        if (!hasExecutionHits) {
          continue;
        }

        functionsFoundForFile++;

        let baseWeight = 10;
        if (isFrontier) {
          baseWeight = 100;
        } else if (isTargetFn || isReachable === true) {
          baseWeight = 50;
        } else if (fileExecuted) {
          baseWeight = 30;
        }

        const targetId = `${normKey}:${fn.name}`;
        const attempts = options.targetAttempts[targetId] ?? 0;
        const weight = Math.max(
          0.01,
          baseWeight * Math.pow(CoverageFrontierSampler.DECAY_FACTOR, attempts)
        );

        candidates.push({
          targetId,
          filePath: fileKey,
          functionName: fn.name,
          startLine: fn.startLine,
          endLine: fn.endLine,
          isFrontier,
          baseWeight,
          weight,
          attempts,
          uncoveredLines: fnUncovered,
          partialLines: fnPartial,
          src: fn.src,
        });
      }

      // If no functions were matched (e.g. top-level statements), fallback to file-level candidate if it has execution hits
      const fileHasReachableFunction =
        reachableFunctionKeys === undefined ||
        Array.from(reachableFunctionKeys).some((k) =>
          k.startsWith(`${normKey}:`)
        );
      const hasTopHits = partialLines.length > 0 || coveredLinesInFile.size > 0;
      if (
        functionsFoundForFile === 0 &&
        !isTargetModule &&
        hasTopHits &&
        fileHasReachableFunction
      ) {
        const targetId = `${normKey}:__top__`;
        const isFrontier = partialLines.length > 0;
        const baseWeight = isFrontier ? 50 : fileExecuted ? 20 : 5;
        const attempts = options.targetAttempts[targetId] ?? 0;
        const weight = Math.max(
          0.01,
          baseWeight * Math.pow(CoverageFrontierSampler.DECAY_FACTOR, attempts)
        );

        candidates.push({
          targetId,
          filePath: fileKey,
          functionName: undefined,
          startLine: 1,
          endLine: cached.src.split("\n").length,
          isFrontier,
          baseWeight,
          weight,
          attempts,
          uncoveredLines: partialLines.length === 0 ? uncoveredLines : [],
          partialLines,
          src: cached.src,
        });
      }
    }

    return candidates;
  } // fn: getCandidates

  /**
   * Clears the file analysis cache.
   */
  public static clearCache(): void {
    CoverageFrontierSampler._fileCache.clear();
  } // fn: clearCache
} // class: CoverageFrontierSampler

/**
 * Formats a sampled frontier target into a concise Markdown prompt section.
 *
 * @param target The sampled frontier target
 * @param lang Programming language of the target
 * @returns Formatted Markdown string
 */
export function formatFrontierContext(
  target: SampledFrontierTarget,
  lang: string
): string {
  const parts: string[] = [];

  if (target.callChain && target.callChain.length > 0) {
    parts.push("Call chain to targeted code:");
    for (const frame of target.callChain) {
      parts.push(
        `Caller from \`${frame.displayPath}\` (function \`${frame.functionName}\`):`
      );
      parts.push(`\`\`\`${lang}`);
      parts.push(frame.codeSnippet.trim());
      parts.push("```\n");
    }
  }

  const fnLabel = target.functionName
    ? ` (function \`${target.functionName}\`)`
    : "";
  let linesLabel = "";
  if (target.partialLines.length > 0 && target.uncoveredLines.length > 0) {
    linesLabel = ` at partially covered branch line(s) ${formatLineRanges(
      target.partialLines
    )} (uncovered line(s): ${formatLineRanges(target.uncoveredLines)})`;
  } else if (target.partialLines.length > 0) {
    linesLabel = ` at partially covered branch line(s) ${formatLineRanges(
      target.partialLines
    )}`;
  } else if (target.uncoveredLines.length > 0) {
    linesLabel = ` with uncovered line(s) ${formatLineRanges(
      target.uncoveredLines
    )}`;
  }

  const reachingSection =
    target.reachingInputs.length > 0
      ? `\nPrior test input(s) that reached this code:\n` +
        target.reachingInputs.map((inp) => ` - \`${inp}\``).join("\n") +
        "\n"
      : "";

  parts.push(
    `Targeted code from \`${target.displayPath}\`${fnLabel}${linesLabel}:`
  );
  parts.push(`\`\`\`${lang}`);
  parts.push(target.codeSnippet.trim());
  parts.push("```");
  if (reachingSection) {
    parts.push(reachingSection.trim());
  }

  return parts.filter(Boolean).join("\n");
} // fn: formatFrontierContext()

// -------------------------------------------------------------------------- //
// Helper Functions
// -------------------------------------------------------------------------- //

/**
 * Selects a candidate using roulette-wheel selection.
 */
function selectWeightedCandidate(
  candidates: FrontierCandidate[],
  prng: () => number
): FrontierCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight <= 0) return candidates[0];

  let threshold = prng() * totalWeight;
  for (const candidate of candidates) {
    threshold -= candidate.weight;
    if (threshold <= 0) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1];
} // fn: selectWeightedCandidate()

/**
 * Prepares the code snippet with 1-based file line numbers, emitting the whole function when possible, or slicing if needed.
 */
function prepareCodeSnippet(
  src: string,
  startLine: number,
  uncoveredLines: number[],
  maxChars: number
): { codeSnippet: string; isSliced: boolean } {
  const lines = src.split("\n");

  let selectedLines: { lineNum: number; text: string }[];
  let isSliced = false;

  if (src.length <= maxChars || lines.length <= 25) {
    selectedLines = lines.map((text, idx) => ({
      lineNum: startLine + idx,
      text,
    }));
  } else {
    isSliced = true;
    // Window +/- 5 lines around the first uncovered line
    const firstUncovered =
      uncoveredLines.length > 0 ? uncoveredLines[0] : startLine;
    const targetIdx = Math.max(
      0,
      Math.min(lines.length - 1, firstUncovered - startLine)
    );
    const startIdx = Math.max(0, targetIdx - 5);
    const endIdx = Math.min(lines.length, startIdx + 20);

    selectedLines = lines.slice(startIdx, endIdx).map((text, idx) => ({
      lineNum: startLine + startIdx + idx,
      text,
    }));
  }

  const formattedLines = selectedLines.map((l) => `${l.lineNum}|${l.text}`);

  const snippet = [
    isSliced && selectedLines[0]?.lineNum > startLine
      ? `/* ... [truncated preceding lines] ... */`
      : "",
    ...formattedLines,
    isSliced &&
    selectedLines[selectedLines.length - 1]?.lineNum <
      startLine + lines.length - 1
      ? `/* ... [truncated following lines] ... */`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { codeSnippet: snippet, isSliced };
} // fn: prepareCodeSnippet()

/**
 * Computes line starting character offsets for a source string.
 */
function computeLineOffsets(src: string): number[] {
  const offsets = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) {
      offsets.push(i + 1);
    }
  }
  return offsets;
} // fn: computeLineOffsets()

/**
 * Finds 1-based line number for a character offset using binary search.
 */
function findLineNumber(offset: number, lineOffsets: number[]): number {
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineOffsets[mid] <= offset) {
      if (mid === lineOffsets.length - 1 || lineOffsets[mid + 1] > offset) {
        return mid + 1;
      }
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return 1;
} // fn: findLineNumber()

/**
 * Computes the first line of the function body, skipping the declaration signature.
 *
 * @param src Function source code
 * @param startLine 1-based start line of the function
 * @returns 1-based start line of the function body
 */
function getBodyStartLine(src: string, startLine: number): number {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (
      l.endsWith(":") ||
      l.endsWith("{") ||
      l.includes("):") ||
      l.includes(") ->")
    ) {
      return startLine + i + 1;
    }
  }
  return startLine + 1;
} // fn: getBodyStartLine

/**
 * Locates the 1-based line number of a call to calleeName within caller source code.
 */
function findCallSiteLine(
  src: string,
  startLine: number,
  calleeName: string
): number {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(calleeName)) {
      return startLine + i;
    }
  }
  return startLine;
} // fn: findCallSiteLine()

/**
 * Analyzes a source file and extracts its functions, line offsets, and callee graph.
 *
 * @param fileKey Path of the file to analyze
 * @param mtimeMs Last modified timestamp of the file
 * @returns Cached file metadata
 */
function analyzeFile(fileKey: string, mtimeMs: number): CachedFileInfo {
  const program = ProgramFactory.fromFile(fileKey);
  const fileSrc = program.src;
  const lineOffsets = computeLineOffsets(fileSrc);
  const functions: CachedFunctionInfo[] = [];

  const allFunctionRefs: FunctionRef[] = [
    ...Object.values(program.functions).map((fn) => fn.getRef()),
    ...Object.values(program.functionsNotSupported)
      .map((entry) => entry.function)
      .filter((fnRef): fnRef is FunctionRef => fnRef !== undefined),
  ];

  for (const fn of allFunctionRefs) {
    const startLine = findLineNumber(fn.startOffset, lineOffsets);
    const endLine = findLineNumber(fn.endOffset, lineOffsets);
    const bodyStartLine = getBodyStartLine(fn.src, startLine);
    const callees = program.getCallees(fn.name);
    functions.push({
      name: fn.name,
      startLine,
      bodyStartLine,
      endLine,
      src: fn.src,
      callees,
    });
  }

  return {
    mtimeMs,
    src: fileSrc,
    functions,
  };
} // fn: analyzeFile()

/**
 * Finds test inputs from the leaderboard that reached the specified candidate function.
 *
 * @param candidate Selected candidate target
 * @param leaderboard Active leaderboard of interesting inputs
 * @param covMeasure Active coverage measure
 * @param targetFn The function under test
 * @returns Array of formatted input representations that executed code in the target
 */
function findReachingInputs(
  candidate: FrontierCandidate,
  leaderboard: Leaderboard<InputAndSource>,
  covMeasure: CoverageMeasure,
  targetFn: FunctionDef
): string[] {
  const reaching: string[] = [];
  const seen = new Set<string>();
  const leaders = leaderboard.getLeaders().sort((a, b) => b.score - a.score);
  const targetNormPath = normalizePathForKey(candidate.filePath);

  for (const item of leaders) {
    const tick = item.leader.tick;
    if (tick === undefined || !covMeasure.hasCoverage(tick)) {
      continue;
    }

    const meas = covMeasure.getCoverage(tick);
    const currentCov = meas?.coverageMeasure?.current;
    if (!currentCov) continue;

    const matchingFile = currentCov
      .files()
      .find((f) => normalizePathForKey(f) === targetNormPath);

    if (matchingFile) {
      const fileCov = currentCov.fileCoverageFor(matchingFile);
      if (fileCov?.s && fileCov?.statementMap) {
        const hitInTarget = Object.entries(fileCov.s).some(([key, hits]) => {
          if (hits <= 0) return false;
          const stmt = fileCov.statementMap[key];
          if (!stmt) return false;
          const line = stmt.start.line;
          return line >= candidate.startLine && line <= candidate.endLine;
        });

        if (hitInTarget) {
          const repr = ValueMapper.toLang(
            targetFn.getLang(),
            item.leader.value.map((v) => v.value)
          );
          if (!seen.has(repr)) {
            seen.add(repr);
            reaching.push(repr);
            if (reaching.length >= 2) {
              break;
            }
          }
        }
      }
    }
  }

  return reaching;
} // fn: findReachingInputs()

// -------------------------------------------------------------------------- //
// Type Definitions
// -------------------------------------------------------------------------- //

/**
 * Candidate target discovered on the execution frontier or in unreached dependencies.
 */
export type FrontierCandidate = {
  targetId: string;
  filePath: string;
  functionName?: string;
  startLine: number;
  endLine: number;
  isFrontier: boolean;
  baseWeight: number;
  weight: number;
  attempts: number;
  uncoveredLines: number[];
  partialLines: number[];
  src: string;
};

/**
 * A call frame within a call-chain skeleton leading to a sampled target.
 */
export type CallChainFrame = {
  filePath: string;
  displayPath: string;
  functionName: string;
  callSite?: string;
  codeSnippet: string;
  isSliced: boolean;
};

/**
 * Probabilistically sampled target with formatted code context.
 */
export type SampledFrontierTarget = {
  targetId: string;
  filePath: string;
  displayPath: string;
  functionName?: string;
  startLine: number;
  endLine: number;
  uncoveredLines: number[];
  partialLines: number[];
  reachingInputs: string[];
  codeSnippet: string;
  isSliced: boolean;
  callChain?: CallChainFrame[];
};

/**
 * Options passed to the frontier sampler.
 */
export type FrontierSampleOptions = {
  covStats: CodeCoverageMeasureStats;
  uncoveredInfo: UncoveredCoverageInfo;
  targetAttempts: Record<string, number>;
  targetFn?: FunctionDef;
  leaderboard?: Leaderboard<InputAndSource>;
  covMeasure?: CoverageMeasure;
  prng?: () => number;
  maxSnippetChars?: number;
};

type CachedFunctionInfo = {
  name: string;
  startLine: number;
  bodyStartLine: number;
  endLine: number;
  src: string;
  callees: Set<string>;
};

type CachedFileInfo = {
  mtimeMs: number;
  src: string;
  functions: CachedFunctionInfo[];
};

const TEST_FRAMEWORK_PATH_PARTS = [
  "site-packages/hypothesis",
  "site-packages/pytest",
  "site-packages/_pytest",
  "site-packages/mock",
  "site-packages/unittest2",
  "nanofuzz_runtime",
  "_nanofuzz_python",
  "@nanofuzz/runtime",
  "packages/runtime",
];
