import * as fs from "node:fs";
import * as path from "node:path";
import * as ProgramFactory from "./ProgramFactory";
import { normalizePathForKey } from "../Util";
import {
  CodeCoverageMeasureStats,
  UncoveredCoverageInfo,
  formatLineRanges,
} from "../measures/AbstractCoverageMeasure";

/**
 * Probabilistically samples code targets from the execution frontier
 * (partially covered functions or callsites) to guide input generation
 * towards unexplored branches without getting stuck on unreachable code.
 */
export class CoverageFrontierSampler {
  public static readonly DEFAULT_MAX_CHARS = 2000;
  public static readonly DECAY_FACTOR = 0.5;

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
    const currentAttempts = options.targetAttempts.get(selected.targetId) ?? 0;
    options.targetAttempts.set(selected.targetId, currentAttempts + 1);

    const maxChars =
      options.maxSnippetChars ?? CoverageFrontierSampler.DEFAULT_MAX_CHARS;
    const { codeSnippet, isSliced } = prepareCodeSnippet(
      selected.src,
      selected.uncoveredLines,
      maxChars
    );

    const displayPath = path.isAbsolute(selected.filePath)
      ? path.relative(process.cwd(), selected.filePath) || selected.filePath
      : selected.filePath;

    return {
      targetId: selected.targetId,
      filePath: selected.filePath,
      displayPath,
      functionName: selected.functionName,
      uncoveredLines: selected.uncoveredLines,
      codeSnippet,
      isSliced,
    };
  } // fn: sample

  /**
   * Identifies and scores all candidate targets across external files with uncovered lines.
   *
   * @param options Sampling options
   * @returns Array of candidate targets with decayed weights
   */
  public static getCandidates(
    options: FrontierSampleOptions
  ): FrontierCandidate[] {
    const normTarget = normalizePathForKey(options.targetModule);
    const candidates: FrontierCandidate[] = [];

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
      if (normalizePathForKey(fileKey) === normTarget) {
        continue;
      }

      if (!fs.existsSync(fileKey)) {
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

      try {
        const program = ProgramFactory.fromFile(fileKey);
        const fileSrc = program.src;
        const lineOffsets = computeLineOffsets(fileSrc);

        const functions = Object.values(program.functions);
        let functionsFoundForFile = 0;

        for (const fn of functions) {
          const fnStartLine = findLineNumber(fn.getStartOffset(), lineOffsets);
          const fnEndLine = findLineNumber(fn.getEndOffset(), lineOffsets);

          const fnUncovered = uncoveredLines.filter(
            (l) => l >= fnStartLine && l <= fnEndLine
          );
          const fnPartial = partialLines.filter(
            (l) => l >= fnStartLine && l <= fnEndLine
          );

          if (fnUncovered.length === 0 && fnPartial.length === 0) {
            continue;
          }

          functionsFoundForFile++;
          const isFrontier = fnPartial.length > 0;
          let baseWeight = 10;
          if (isFrontier) {
            baseWeight = 100;
          } else if (fileExecuted) {
            baseWeight = 30;
          }

          const targetId = `${normalizePathForKey(fileKey)}:${fn.getName()}`;
          const attempts = options.targetAttempts.get(targetId) ?? 0;
          const weight = Math.max(
            0.01,
            baseWeight *
              Math.pow(CoverageFrontierSampler.DECAY_FACTOR, attempts)
          );

          candidates.push({
            targetId,
            filePath: fileKey,
            functionName: fn.getName(),
            isFrontier,
            baseWeight,
            weight,
            attempts,
            uncoveredLines: isFrontier ? fnPartial : fnUncovered,
            src: fn.getSrc(),
          });
        }

        // If no functions were matched (e.g. top-level statements), fallback to file-level candidate
        if (functionsFoundForFile === 0) {
          const targetId = `${normalizePathForKey(fileKey)}:__top__`;
          const isFrontier = partialLines.length > 0;
          const baseWeight = isFrontier ? 50 : fileExecuted ? 20 : 5;
          const attempts = options.targetAttempts.get(targetId) ?? 0;
          const weight = Math.max(
            0.01,
            baseWeight *
              Math.pow(CoverageFrontierSampler.DECAY_FACTOR, attempts)
          );

          candidates.push({
            targetId,
            filePath: fileKey,
            functionName: undefined,
            isFrontier,
            baseWeight,
            weight,
            attempts,
            uncoveredLines: isFrontier ? partialLines : uncoveredLines,
            src: fileSrc,
          });
        }
      } catch {
        // Fallback for unparseable external file: treat as file snippet
        const targetId = `${normalizePathForKey(fileKey)}:__raw__`;
        const attempts = options.targetAttempts.get(targetId) ?? 0;
        const baseWeight = partialLines.length > 0 ? 30 : 5;
        const weight = Math.max(
          0.01,
          baseWeight * Math.pow(CoverageFrontierSampler.DECAY_FACTOR, attempts)
        );

        let rawSrc: string;
        try {
          rawSrc = fs.readFileSync(fileKey, "utf8");
        } catch {
          continue;
        }

        candidates.push({
          targetId,
          filePath: fileKey,
          functionName: undefined,
          isFrontier: partialLines.length > 0,
          baseWeight,
          weight,
          attempts,
          uncoveredLines:
            partialLines.length > 0 ? partialLines : uncoveredLines,
          src: rawSrc,
        });
      }
    }

    return candidates;
  } // fn: getCandidates
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
  const fnLabel = target.functionName
    ? ` (function \`${target.functionName}\`)`
    : "";
  const linesLabel =
    target.uncoveredLines.length > 0
      ? ` with uncovered line(s) ${formatLineRanges(target.uncoveredLines)}`
      : "";

  return [
    `Targeted dependency code from \`${target.displayPath}\`${fnLabel}${linesLabel}:`,
    `\`\`\`${lang}`,
    target.codeSnippet.trim(),
    `\`\`\``,
  ].join("\n");
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
 * Prepares the code snippet, emitting the whole function when possible, or slicing if needed.
 */
function prepareCodeSnippet(
  src: string,
  uncoveredLines: number[],
  maxChars: number
): { codeSnippet: string; isSliced: boolean } {
  if (src.length <= maxChars) {
    return { codeSnippet: src, isSliced: false };
  }

  const lines = src.split("\n");
  if (lines.length <= 25) {
    return { codeSnippet: src, isSliced: false };
  }

  // Window +/- 5 lines around the first uncovered line
  const targetLineIdx =
    uncoveredLines.length > 0 ? Math.max(0, uncoveredLines[0] - 1) : 0;
  const startIdx = Math.max(0, targetLineIdx - 5);
  const endIdx = Math.min(lines.length, startIdx + 20);

  const slicedLines = lines.slice(startIdx, endIdx);
  const snippet = [
    startIdx > 0 ? "/* ... [truncated preceding lines] ... */" : "",
    ...slicedLines,
    endIdx < lines.length ? "/* ... [truncated following lines] ... */" : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { codeSnippet: snippet, isSliced: true };
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
  isFrontier: boolean;
  baseWeight: number;
  weight: number;
  attempts: number;
  uncoveredLines: number[];
  src: string;
};

/**
 * Probabilistically sampled target with formatted code context.
 */
export type SampledFrontierTarget = {
  targetId: string;
  filePath: string;
  displayPath: string;
  functionName?: string;
  uncoveredLines: number[];
  codeSnippet: string;
  isSliced: boolean;
};

/**
 * Options passed to the frontier sampler.
 */
export type FrontierSampleOptions = {
  targetModule: string;
  covStats: CodeCoverageMeasureStats;
  uncoveredInfo: UncoveredCoverageInfo;
  targetAttempts: Map<string, number>;
  prng?: () => number;
  maxSnippetChars?: number;
};
