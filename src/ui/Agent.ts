import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import vscode from "vscode";
import pkg from "../../package.json";
import * as Config from "../Config";
import * as JSONN from "../Jsonn";
import { getToolVersion } from "../ToolVersion";
import { isError, normalizePathForKey } from "../fuzzer/Util";
import * as ParserAdapter from "../fuzzer/adapters/ParserAdapter";
import * as ProgramFactory from "../fuzzer/analysis/ProgramFactory";
import { FunctionDef } from "../fuzzer/analysis/FunctionDef";
import { ArgDef } from "../fuzzer/analysis/ArgDef";
import {
  ArgOptions,
  ArgValueType,
  FunctionRef,
  ProgramLanguage,
} from "../fuzzer/analysis/Types";
import {
  FuzzOptions,
  FuzzPinnedTest,
  FuzzResultCategory,
  FuzzStatusUpdater,
  FuzzStopReason,
  FuzzTestResult,
  FuzzTests,
  HarnessError,
} from "../fuzzer/Types";
import { FuzzEnv, FuzzTestResults, Tester } from "../fuzzer/Fuzzer";
import { Judgment } from "../fuzzer/oracles/Types";
import * as TestAdapterFactory from "../fuzzer/adapters/TestAdapterFactory";
import { CodeCoverageMeasureStats } from "../fuzzer/measures/AbstractCoverageMeasure";
import { LlmAdapter } from "../fuzzer/adapters/LlmAdapter";
import { synthesizeValidator } from "../fuzzer/synthesis/ValidatorSynthesizer";
import { synthesizeTransformer } from "../fuzzer/synthesis/TransformerSynthesizer";
import { FuzzerCodeSnippet } from "../fuzzer/synthesis/Types";

export { synthesizeValidator, synthesizeTransformer, FuzzerCodeSnippet };

// -------------------------------------------------------------------------- //
// Primary Public API
// -------------------------------------------------------------------------- //

/**
 * Resolves a target file path against absolute paths, file URIs, VS Code workspace folders, or process.cwd().
 *
 * @param filePath Path or file URI to the source file
 * @returns Fully-resolved filesystem path
 */
export function resolveFilePath(filePath: string): string {
  let normalized = filePath.trim();

  // Handle file:// URIs
  if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      normalized = normalized.replace(/^file:\/\//, "");
    }
  }

  if (path.isAbsolute(normalized)) {
    return normalized;
  }

  // Check VS Code workspace folders
  const folders = vscode.workspace?.workspaceFolders;
  if (folders && folders.length > 0) {
    for (const folder of folders) {
      const folderPath = folder.uri.fsPath;
      if (folderPath) {
        const candidate = path.resolve(folderPath, normalized);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  // Check process.cwd()
  const cwdCandidate = path.resolve(process.cwd(), normalized);
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  // Fallback to first workspace folder if present
  if (folders && folders.length > 0) {
    const firstFolder = folders[0].uri.fsPath;
    if (firstFolder) {
      return path.resolve(firstFolder, normalized);
    }
  }

  return cwdCandidate;
}

/**
 * Discovers and lists all fuzzable exported functions in a source file (sync and async).
 *
 * @param filePath Path to the target source file (TypeScript or Python)
 * @returns TargetListResult containing exported functions and their signatures
 */
export async function listTargets(filePath: string): Promise<TargetListResult> {
  await ParserAdapter.init();

  const resolvedPath = resolveFilePath(filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Target file does not exist: ${filePath}`);
  }

  const program = ProgramFactory.fromFile(resolvedPath);
  const language = program.lang;
  const exported = program.functionsExported;
  const functions: TargetFunction[] = [];

  for (const fnDef of Object.values(exported)) {
    const argDefs = fnDef.getArgDefs();
    const args: TargetFunctionArg[] = argDefs.map((arg) => ({
      name: arg.getName(),
      type: formatArgDefType(arg),
      optional: arg.isOptional(),
      isConstant: arg.isConstant(),
      constantValue: arg.isConstant() ? arg.getConstantValue() : undefined,
    }));

    const valSkel = synthesizeValidator(
      fnDef,
      language,
      Object.keys(program.functions)
    );
    const transSkel = synthesizeTransformer(
      fnDef,
      language,
      Object.keys(program.functions)
    );

    functions.push({
      name: fnDef.getName(),
      signature: formatFunctionSignature(fnDef, language),
      args,
      returnType: fnDef.getReturnType()?.name,
      isVoid: fnDef.isVoid(),
      ...(fnDef.isAsync() ? { isAsync: true } : {}),
      startOffset: fnDef.getStartOffset(),
      endOffset: fnDef.getEndOffset(),
      comment: fnDef.getCmt(),
      validatorTemplate: valSkel.fullTemplate,
      transformerTemplate: transSkel.fullTemplate,
    });
  }

  const unsupportedFunctions: { name: string; reason: string }[] = [];
  const unsupported = program.functionsNotSupported;
  for (const [name, info] of Object.entries(unsupported)) {
    unsupportedFunctions.push({
      name,
      reason: info.reason,
    });
  }

  return {
    filePath: resolvedPath,
    language,
    functions,
    unsupportedFunctions,
  };
}

/**
 * Runs a fuzzing session on a given target function (synchronous or asynchronous) in headless agent mode.
 *
 * @param options Fuzzing parameters (filePath, functionName, timeouts, etc.)
 * @param cancelFn Optional callback to poll for cancellation
 * @param updateFn Optional callback for progress updates
 * @returns Comprehensive AgentFuzzResult
 */
export async function runFuzz(
  options: AgentFuzzOptions,
  cancelFn?: () => boolean,
  updateFn?: FuzzStatusUpdater
): Promise<AgentFuzzResult> {
  await ParserAdapter.init();

  const resolvedPath = resolveFilePath(options.filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Target file does not exist: ${options.filePath}`);
  }

  const currentProvider = Config.get<string>(
    "nanofuzz.ai.provider",
    "disabled"
  );
  const currentModel = Config.get<string>("nanofuzz.ai.model", "");
  const currentVendor = Config.get<string>("nanofuzz.ai.vendor", "");
  const shouldAutoEnableCopilot = Boolean(options.enableCopilotAi);

  try {
    if (shouldAutoEnableCopilot) {
      Config.override("nanofuzz.ai.provider", "copilot");
    }
    if (options.model) {
      Config.override("nanofuzz.ai.model", options.model);
    }
    if (options.vendor) {
      Config.override("nanofuzz.ai.vendor", options.vendor);
    }

    const effectiveGenerators = {
      ...options.generators,
      ...(shouldAutoEnableCopilot &&
      options.generators?.AiInputGenerator?.enabled === undefined
        ? { AiInputGenerator: { enabled: true } }
        : {}),
    };

    const normalizedOptions = normalizeAgentFuzzOptions({
      ...options,
      generators: effectiveGenerators,
    });

    const tester = new Tester(
      resolvedPath,
      options.functionName,
      normalizedOptions
    );

    const rawResults = await tester.testSync(
      options.injectTests ?? [],
      { gen: true },
      updateFn,
      cancelFn
    );

    if (cancelFn?.()) {
      rawResults.stopReason = FuzzStopReason.PAUSE;
    }

    return await formatFuzzResult(
      rawResults,
      resolvedPath,
      options.functionName
    );
  } catch (e: unknown) {
    const errorMsg = isError(e) ? e.message : String(e);
    const stack = isError(e) ? e.stack : undefined;
    const isCancelled = cancelFn?.() ?? false;

    const status: AgentFuzzStatus = isCancelled ? "cancelled" : "error";
    const language: ProgramLanguage = resolvedPath.endsWith(".py")
      ? "python"
      : "typescript";
    const toolName = getToolName();

    const resultBase: Omit<AgentFuzzResult, "summaryText"> = {
      status,
      filePath: resolvedPath,
      functionName: options.functionName,
      language,
      toolVersion: getToolVersion(),
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      erroredTests: 0,
      timeouts: 0,
      exceptions: 0,
      stopReason: isCancelled ? FuzzStopReason.PAUSE : FuzzStopReason.CRASH,
      counterexamples: [],
      primaryCounterexample: undefined,
      reproducerCode: undefined,
      coverage: undefined,
    };

    const summaryText = isCancelled
      ? `### ⚠️ ${toolName} Run Cancelled on \`${options.functionName}\``
      : `### ❌ ${toolName} Error on \`${options.functionName}\`\n${errorMsg}\n${stack ? `\`\`\`\n${stack}\n\`\`\`` : ""}`;

    return {
      ...resultBase,
      summaryText,
    };
  } finally {
    if (shouldAutoEnableCopilot) {
      Config.override("nanofuzz.ai.provider", currentProvider);
    }
    if (options.model) {
      Config.override("nanofuzz.ai.model", currentModel);
    }
    if (options.vendor) {
      Config.override("nanofuzz.ai.vendor", currentVendor);
    }
  }
}

/**
 * Returns the configured display name of the tool (e.g., "NaNofuzz").
 */
export function getToolName(): string {
  return Config.get("nanofuzz.name", "NaNofuzz");
}

/**
 * Returns default FuzzOptions for agent headless runs.
 */
export function getDefaultFuzzOptions(): FuzzOptions {
  return {
    outputResults: "all",
    argDefaults: ArgDef.getDefaultOptions(),
    maxTests: Config.get("nanofuzz.fuzzer.maxTests", 1000),
    fnTimeout: Config.get("nanofuzz.fuzzer.fnTimeout", 200),
    suiteTimeout: Config.get("nanofuzz.fuzzer.suiteTimeout", 3000),
    maxDupeInputs: Config.get("nanofuzz.fuzzer.maxDupeInputs", 500),
    maxFailures: Config.get("nanofuzz.fuzzer.maxFailures", 0),
    useTransformer: true,
    useHuman: true,
    useImplicit: true,
    useProperty: true,
    measures: {
      FailedTestMeasure: {
        enabled: true,
        weight: 1,
      },
      CoverageMeasure: {
        enabled: true,
        weight: 1,
      },
    },
    generators: {
      RandomInputGenerator: {
        enabled: true,
      },
      MutationInputGenerator: {
        enabled: true,
      },
      AiInputGenerator: {
        enabled: false,
      },
    },
  };
}

/**
 * Normalizes user-specified agent fuzz options into full FuzzOptions.
 */
export function normalizeAgentFuzzOptions(
  options: AgentFuzzOptions
): FuzzOptions {
  const dft = getDefaultFuzzOptions();
  return {
    ...dft,
    maxTests: options.maxTests ?? dft.maxTests,
    maxDupeInputs: options.maxDupeInputs ?? dft.maxDupeInputs,
    maxFailures: options.maxFailures ?? dft.maxFailures,
    fnTimeout: options.fnTimeout ?? dft.fnTimeout,
    suiteTimeout: options.suiteTimeout ?? dft.suiteTimeout,
    seed: options.seed ?? dft.seed,
    useImplicit: options.useImplicit ?? dft.useImplicit,
    useHuman: options.useHuman ?? dft.useHuman,
    useProperty: options.useProperty ?? dft.useProperty,
    useTransformer: options.useTransformer ?? dft.useTransformer,
    argDefaults: ArgDef.normalizeOptions(options.argDefaults),
    generators: options.generators
      ? { ...dft.generators, ...options.generators }
      : dft.generators,
    measures: options.measures
      ? { ...dft.measures, ...options.measures }
      : dft.measures,
  };
}

// -------------------------------------------------------------------------- //
// Helper Functions
// -------------------------------------------------------------------------- //

/**
 * Determines whether a single FuzzTestResult represents a failure or counterexample.
 */
export function isCounterexample(result: FuzzTestResult): boolean {
  if (result.skipped) {
    return false;
  }
  if (result.exception || result.timeout) {
    return true;
  }
  if (
    result.category === "badValue" ||
    result.category === "exception" ||
    result.category === "timeout" ||
    result.category === "failure" ||
    result.category === "disagree"
  ) {
    return true;
  }
  if (
    result.passedImplicit === "fail" ||
    result.passedHuman === "fail" ||
    result.passedValidator === "fail"
  ) {
    return true;
  }
  return false;
}

/**
 * Maps a single FuzzTestResult to an AgentCounterexample.
 */
export function mapToAgentCounterexample(
  result: FuzzTestResult
): AgentCounterexample {
  let origin: string | undefined;
  if (result.inputGenerated?.source) {
    const s = result.inputGenerated.source;
    if (s.type === "generator") {
      origin =
        s.generator === "AiInputGenerator" ? `AI (${s.model})` : s.generator;
    } else {
      origin = s.type;
    }
  }

  return {
    input: result.input.map((e) => ({
      name: e.name,
      offset: e.offset,
      value: e.value,
    })),
    output: result.output.map((e) => ({
      name: e.name,
      offset: e.offset,
      value: e.value,
      isException: e.isException,
      isTimeout: e.isTimeout,
    })),
    category: result.category,
    exception: Boolean(result.exception),
    exceptionMessage: result.exceptionMessage,
    exceptionDisplay: result.exceptionDisplay,
    stack: result.stack,
    timeout: Boolean(result.timeout),
    passedImplicit: result.passedImplicit,
    passedHuman: result.passedHuman,
    passedValidator: result.passedValidator,
    harnessErrors: result.harnessErrors?.map((e: HarnessError) => ({
      fnName: e.fnName,
      message: e.message,
    })),
    shrunk: Boolean(result.shrinkStep && result.shrinkStep > 0),
    shrinkSteps: result.shrinkStep,
    origin,
  };
}

/**
 * Synthesizes an executable test suite / reproducer using NaNofuzz test adapters (Jest or Pytest).
 */
export function synthesizeReproducer(
  filePath: string,
  functionName: string,
  counterexamples: FuzzTestResult | FuzzTestResult[],
  fuzzEnv?: FuzzEnv
): string | undefined {
  const results = Array.isArray(counterexamples)
    ? counterexamples
    : [counterexamples];
  if (results.length === 0) {
    return undefined;
  }

  const testsObj: Record<string, FuzzPinnedTest> = {};
  results.forEach((res, idx) => {
    testsObj[String(idx)] = {
      input: res.input,
      output: res.output,
      pinned: true,
      expectedOutput: res.expectedOutput,
    };
  });

  const options = fuzzEnv?.options ?? getDefaultFuzzOptions();
  const validators = fuzzEnv?.validators?.map((v: FunctionRef) => v.name) ?? [];
  const isVoid = fuzzEnv?.function?.isVoid() ?? false;
  const version = process.env.NANOFUZZ_VERSION ?? pkg.version;

  const fuzzTests: FuzzTests = {
    version,
    functions: {
      [functionName]: {
        options,
        validators,
        tests: testsObj,
        isVoid,
      },
    },
  };

  try {
    const adapter = TestAdapterFactory.fromSourceFilename(filePath, fuzzTests);
    return adapter.toString();
  } catch (_e) {
    // If test adapter fails, synthesize a fallback code snippet
    const inputVals = results[0].input
      .map((i) => JSONN.stringify(i.value))
      .join(", ");
    return `// Reproducer test for ${functionName}\n${functionName}(${inputVals});\n`;
  }
}

/**
 * Computes coverage summary statistics from FuzzTestResults.
 */
export async function getCoverageSummary(
  results: FuzzTestResults
): Promise<AgentCoverageSummary | undefined> {
  const coverageFn = results.stats?.measures?.CodeCoverageMeasure;
  if (typeof coverageFn !== "function") {
    return undefined;
  }

  try {
    const covStats: CodeCoverageMeasureStats = await coverageFn();
    const counters = covStats.counters;

    const stmtTotal = counters.statementsTotal;
    const stmtCovered = counters.statementsCovered;
    const stmtPct =
      stmtTotal > 0 ? Math.round((stmtCovered / stmtTotal) * 10000) / 100 : 100;

    const brTotal = counters.branchesTotal;
    const brCovered = counters.branchesCovered;
    const brPct =
      brTotal > 0 ? Math.round((brCovered / brTotal) * 10000) / 100 : 100;

    const fnTotal = counters.functionsTotal;
    const fnCovered = counters.functionsCovered;
    const fnPct =
      fnTotal > 0 ? Math.round((fnCovered / fnTotal) * 10000) / 100 : 100;

    const uncoveredLinesByFile: Record<string, number[]> = {};
    if (covStats.files) {
      for (const file of covStats.files) {
        const fileMap = file.fileMap;
        if (fileMap && fileMap.s && fileMap.statementMap) {
          const uncoveredLines: number[] = [];
          for (const [key, hits] of Object.entries(fileMap.s)) {
            if (hits === 0 && fileMap.statementMap[key]) {
              const startLine = fileMap.statementMap[key].start.line;
              if (!uncoveredLines.includes(startLine)) {
                uncoveredLines.push(startLine);
              }
            }
          }
          uncoveredLines.sort((a, b) => a - b);
          uncoveredLinesByFile[normalizePathForKey(file.path)] = uncoveredLines;
        }
      }
    }

    return {
      statementsTotal: stmtTotal,
      statementsCovered: stmtCovered,
      statementCoveragePercent: stmtPct,
      branchesTotal: brTotal,
      branchesCovered: brCovered,
      branchCoveragePercent: brPct,
      functionsTotal: fnTotal,
      functionsCovered: fnCovered,
      functionCoveragePercent: fnPct,
      uncoveredLinesByFile,
    };
  } catch (_e) {
    return undefined;
  }
}

/**
 * Builds a formatted Markdown summary string for an AgentFuzzResult.
 */
export function buildSummaryMarkdown(
  result: Omit<AgentFuzzResult, "summaryText">
): string {
  const parts: string[] = [];
  const toolName = getToolName();

  if (result.status === "counterexample_found") {
    parts.push(
      `### ❌ ${toolName} Counterexample Discovered in \`${result.functionName}\``
    );
    parts.push(
      `Fuzzing identified **${result.failedTests}** failing input(s) out of **${result.totalTests}** tests.`
    );

    if (result.primaryCounterexample) {
      const ce = result.primaryCounterexample;
      parts.push(
        `\n**Failing Input**:`,
        "```json",
        JSONN.stringify(
          ce.input.map((i) => ({ [i.name]: i.value })),
          null,
          2
        ),
        "```"
      );

      if (ce.exception && ce.exceptionMessage) {
        parts.push(`**Exception Raised**: \`${ce.exceptionMessage}\``);
      }
      if (ce.origin) {
        parts.push(`**Input Source**: \`${ce.origin}\``);
      }
      if (ce.timeout) {
        parts.push(`**Failure Reason**: Function execution timed out.`);
      }
      if (ce.shrunk) {
        parts.push(
          `*(Input was simplified through ${ce.shrinkSteps ?? 1} shrinking step(s))*`
        );
      }
    }

    if (result.reproducerCode) {
      const lang = result.language === "python" ? "python" : "typescript";
      parts.push(
        `\n**Executable Reproducer Test Case**:`,
        `\`\`\`${lang}`,
        result.reproducerCode.trim(),
        `\`\`\``
      );
    }
  } else if (result.status === "success") {
    parts.push(
      `### ✅ ${toolName} Passed: No Counterexamples Found in \`${result.functionName}\``
    );
    parts.push(
      `Executed **${result.totalTests}** test input(s) without encountering exceptions, timeouts, or oracle failures.`
    );
  } else if (result.status === "timeout") {
    parts.push(
      `### ⏱️ ${toolName} Execution Timed Out on \`${result.functionName}\``
    );
  } else if (result.status === "cancelled") {
    parts.push(
      `### ⚠️ ${toolName} Run Cancelled on \`${result.functionName}\``
    );
  } else {
    parts.push(`### ❌ ${toolName} Run Failed on \`${result.functionName}\``);
  }

  if (result.generators) {
    const g = result.generators;
    const partsList: string[] = [];
    if (g.aiInputs > 0 || g.aiQueriesSent > 0) {
      partsList.push(
        `- 🤖 **AI Generator**: **${g.aiInputs}** input(s) generated (${g.aiQueriesSent} model query/queries)`
      );
    }
    if (g.mutationInputs > 0) {
      partsList.push(
        `- 🧬 **Mutation Generator**: **${g.mutationInputs}** input(s)`
      );
    }
    if (g.randomInputs > 0) {
      partsList.push(
        `- 🎲 **Random Generator**: **${g.randomInputs}** input(s)`
      );
    }
    if (partsList.length > 0) {
      parts.push(`\n**Generator Breakdown**:`, ...partsList);
    }
  }

  if (result.coverage) {
    const cov = result.coverage;
    parts.push(
      `\n**Code Coverage Summary**:`,
      `- Statement Coverage: **${cov.statementCoveragePercent}%** (${cov.statementsCovered}/${cov.statementsTotal} statements)`,
      `- Branch Coverage: **${cov.branchCoveragePercent}%** (${cov.branchesCovered}/${cov.branchesTotal} branches)`
    );
  }

  if (result.diagnostics && result.diagnostics.length > 0) {
    parts.push(
      `\n**Diagnostics & Guidance**:`,
      ...result.diagnostics.map((d) => `- ${d}`)
    );
  }

  return parts.join("\n");
}

/**
 * Formats a raw FuzzTestResults object into a comprehensive AgentFuzzResult.
 */
export async function formatFuzzResult(
  results: FuzzTestResults,
  filePath: string,
  functionName: string
): Promise<AgentFuzzResult> {
  const language = results.env.function.getLang();
  const allResults = results.results ?? [];
  const executedResults = allResults.filter((r) => !r.skipped);

  const failingResults = executedResults.filter(isCounterexample);
  const counterexamples = failingResults.map(mapToAgentCounterexample);
  const primaryFailure = failingResults[0];
  const primaryCounterexample = primaryFailure
    ? mapToAgentCounterexample(primaryFailure)
    : undefined;

  const passedTests = executedResults.filter(
    (r) =>
      r.category === "ok" &&
      !r.exception &&
      !r.timeout &&
      r.passedImplicit !== "fail" &&
      r.passedHuman !== "fail" &&
      r.passedValidator !== "fail"
  ).length;
  const failedTests = failingResults.length;
  const erroredTests =
    results.stats?.counters?.erroredTests ??
    executedResults.filter(
      (r) =>
        r.category === "failure" ||
        (r.harnessErrors && r.harnessErrors.length > 0)
    ).length;
  const timeouts = failingResults.filter((r) => r.timeout).length;
  const exceptions = failingResults.filter((r) => r.exception).length;
  const totalTests = executedResults.length;

  let status: AgentFuzzStatus = "success";
  if (counterexamples.length > 0) {
    status = "counterexample_found";
  } else if (results.stopReason === FuzzStopReason.PAUSE) {
    status = "cancelled";
  } else if (results.stopReason === FuzzStopReason.CRASH) {
    status = "error";
  } else if (
    results.stopReason === FuzzStopReason.MAXTIME &&
    totalTests === 0
  ) {
    status = "timeout";
  }

  const reproducerCode = primaryFailure
    ? synthesizeReproducer(filePath, functionName, primaryFailure, results.env)
    : undefined;

  const coverage = await getCoverageSummary(results);

  const genStats = results.stats?.generators;
  const generators: AgentGeneratorSummary = {
    randomInputs:
      genStats?.RandomInputGenerator?.counters?.inputsGenerated ?? 0,
    mutationInputs:
      genStats?.MutationInputGenerator?.counters?.inputsGenerated ?? 0,
    aiInputs: genStats?.AiInputGenerator?.counters?.inputsGenerated ?? 0,
    aiQueriesSent: genStats?.AiInputGenerator?.gen?.calls?.sent ?? 0,
  };

  const diagnostics: string[] = [];
  if (
    results.env.options?.generators?.AiInputGenerator?.enabled &&
    !LlmAdapter.isConfigured()
  ) {
    diagnostics.push(
      "AI input generation is enabled, but no AI model provider is configured. Select Copilot or configure an API key under Settings (NaNofuzz → AI)."
    );
  }

  const resultBase: Omit<AgentFuzzResult, "summaryText"> = {
    status,
    filePath,
    functionName,
    language,
    toolVersion: results.toolVersion ?? getToolVersion(),
    totalTests,
    passedTests,
    failedTests,
    erroredTests,
    timeouts,
    exceptions,
    stopReason: results.stopReason,
    counterexamples,
    primaryCounterexample,
    reproducerCode,
    coverage,
    generators,
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    rawResults: results,
  };

  const summaryText = buildSummaryMarkdown(resultBase);

  return {
    ...resultBase,
    summaryText,
  };
}

/**
 * Formats a human-readable argument type string from an ArgDef instance.
 */
export function formatArgDefType(argDef: ArgDef): string {
  const dims = argDef.getDim();
  const suffix = dims > 0 ? "[]".repeat(dims) : "";
  const typeRef = argDef.getTypeRef();
  if (typeRef) {
    return `${typeRef}${suffix}`;
  }
  const tag = argDef.getType();
  return `${tag}${suffix}`;
}

/**
 * Formats a function signature string from a FunctionDef.
 */
export function formatFunctionSignature(
  fnDef: FunctionDef,
  lang: ProgramLanguage
): string {
  const name = fnDef.getName();
  const args = fnDef.getArgDefs();
  const isAsync = fnDef.isAsync();
  const argParts = args.map((arg) => {
    const opt = arg.isOptional() ? "?" : "";
    const typeStr = formatArgDefType(arg);
    return `${arg.getName()}${opt}: ${typeStr}`;
  });

  const returnType = fnDef.getReturnType()?.name;
  if (lang === "python") {
    const retStr = returnType ? ` -> ${returnType}` : "";
    const prefix = isAsync ? "async def" : "def";
    return `${prefix} ${name}(${argParts.join(", ")})${retStr}`;
  }
  const retStr = returnType
    ? `: ${returnType}`
    : fnDef.isVoid()
      ? ": void"
      : "";
  const prefix = isAsync ? "async function" : "function";
  return `${prefix} ${name}(${argParts.join(", ")})${retStr}`;
}

// -------------------------------------------------------------------------- //
// Type Definitions
// -------------------------------------------------------------------------- //

/**
 * Argument descriptor for exported target functions
 */
export type TargetFunctionArg = {
  name: string;
  type: string;
  optional: boolean;
  isConstant: boolean;
  constantValue?: unknown;
};

/**
 * Descriptor for a fuzzable target function discovered via static analysis
 */
export type TargetFunction = {
  name: string;
  signature: string;
  args: TargetFunctionArg[];
  returnType?: string;
  isVoid: boolean;
  isAsync?: boolean;
  startOffset: number;
  endOffset: number;
  comment?: string;
  validatorTemplate?: string;
  transformerTemplate?: string;
};

/**
 * Result of listing fuzz targets within a source file
 */
export type TargetListResult = {
  filePath: string;
  language: ProgramLanguage;
  functions: TargetFunction[];
  unsupportedFunctions: { name: string; reason: string }[];
};

/**
 * Options for executing a fuzzing job via Agent
 */
export type AgentFuzzOptions = {
  filePath: string;
  functionName: string;
  maxTests?: number;
  maxDupeInputs?: number;
  maxFailures?: number;
  fnTimeout?: number;
  suiteTimeout?: number;
  seed?: string;
  model?: string;
  vendor?: string;
  useImplicit?: boolean;
  useHuman?: boolean;
  useProperty?: boolean;
  useTransformer?: boolean;
  generators?: Partial<FuzzOptions["generators"]>;
  measures?: Partial<FuzzOptions["measures"]>;
  argDefaults?: Partial<ArgOptions>;
  injectTests?: FuzzPinnedTest[];
  enableCopilotAi?: boolean;
};

/**
 * Structured counterexample details for an agent / LLM
 */
export type AgentCounterexample = {
  input: { name: string; offset: number; value: ArgValueType }[];
  output?: {
    name: string;
    offset: number;
    value: ArgValueType;
    isException?: boolean;
    isTimeout?: boolean;
  }[];
  category: FuzzResultCategory;
  exception: boolean;
  exceptionMessage?: string;
  exceptionDisplay?: string;
  stack?: string;
  timeout: boolean;
  passedImplicit: Judgment;
  passedHuman: Judgment;
  passedValidator: Judgment;
  harnessErrors?: { fnName: string; message: string }[];
  shrunk: boolean;
  shrinkSteps?: number;
  origin?: string;
};

/**
 * Breakdown of generated test inputs by input generator
 */
export type AgentGeneratorSummary = {
  randomInputs: number;
  mutationInputs: number;
  aiInputs: number;
  aiQueriesSent: number;
};

/**
 * Code coverage summary details
 */
export type AgentCoverageSummary = {
  statementsTotal: number;
  statementsCovered: number;
  statementCoveragePercent: number;
  branchesTotal: number;
  branchesCovered: number;
  branchCoveragePercent: number;
  functionsTotal: number;
  functionsCovered: number;
  functionCoveragePercent: number;
  uncoveredLinesByFile?: Record<string, number[]>;
};

/**
 * Status of the fuzzing execution
 */
export type AgentFuzzStatus =
  | "success"
  | "counterexample_found"
  | "timeout"
  | "cancelled"
  | "error";

/**
 * Comprehensive fuzzing result returned to agents / language model tools
 */
export type AgentFuzzResult = {
  status: AgentFuzzStatus;
  filePath: string;
  functionName: string;
  language: ProgramLanguage;
  toolVersion: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  erroredTests: number;
  timeouts: number;
  exceptions: number;
  stopReason?: FuzzStopReason;
  counterexamples: AgentCounterexample[];
  primaryCounterexample?: AgentCounterexample;
  reproducerCode?: string;
  coverage?: AgentCoverageSummary;
  generators?: AgentGeneratorSummary;
  diagnostics?: string[];
  rawResults?: FuzzTestResults;
  summaryText: string;
};
