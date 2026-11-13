import * as fs from "fs";
import { resolveFilePath, getToolName } from "./Agent";
import * as Config from "../Config";
import { determineWorkerCount } from "../fuzzer/Util";
import { sessionManager } from "./FindBugsSessionManager";

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Coordinates multi-turn guidance for discovering new bugs across a target repository.
 *
 * @param options Target repository, model/vendor credentials, phase, and state payload
 * @returns Phase guidance and instructions for the calling agent
 */
export async function findBugs(
  options: FindBugsOptions
): Promise<FindBugsResult> {
  const phase: FindBugsPhase = options.phase ?? "init";
  const toolName = getToolName();

  const defaultTool: FindBugsTool = Config.get<FindBugsTool>(
    "nanofuzz.experimental.findBugs.tool",
    "nanofuzz"
  );

  const defaultInvariantSource: FindBugsInvariantSource =
    Config.get<FindBugsInvariantSource>(
      "nanofuzz.experimental.findBugs.invariantSource",
      "tests"
    );

  const skipContextualization: boolean = Config.get<boolean>(
    "nanofuzz.experimental.findBugs.skipContextualization",
    false
  );

  const workerCount = determineWorkerCount(
    Config.get("nanofuzz.fuzzer.workers", "auto"),
    false
  );

  const payload = options.statePayload ?? {};
  const passedSessionId =
    typeof payload.sessionId === "string" ? payload.sessionId : undefined;
  const payloadTool: FindBugsTool | undefined =
    payload.tool === "nanofuzz" ||
    payload.tool === "hypothesis" ||
    payload.tool === "hypofuzz"
      ? payload.tool
      : undefined;
  const payloadSource: FindBugsInvariantSource | undefined =
    payload.invariantSource === "docs" ||
    payload.invariantSource === "tests" ||
    payload.invariantSource === "all"
      ? payload.invariantSource
      : undefined;
  const payloadScope = Array.isArray(payload.targetScope)
    ? payload.targetScope.map(String)
    : undefined;
  const payloadRepoPath =
    typeof payload.targetRepoPath === "string"
      ? payload.targetRepoPath
      : undefined;
  const payloadBenchmarkMode =
    typeof payload.benchmarkMode === "boolean"
      ? payload.benchmarkMode
      : undefined;
  const payloadReportPath =
    typeof payload.reportPath === "string" ? payload.reportPath : undefined;

  const session = sessionManager.getOrCreateSession(
    passedSessionId,
    payloadTool ?? defaultTool,
    payloadSource ?? defaultInvariantSource,
    workerCount,
    phase,
    payloadScope,
    payloadRepoPath,
    payloadBenchmarkMode,
    payloadReportPath
  );

  const tool: FindBugsTool = session.tool;
  const invariantSource: FindBugsInvariantSource = session.invariantSource;
  const targetScope: string[] = session.targetScope ?? [];

  let instructions: string;
  let nextPhase: FindBugsPhase | undefined;

  switch (phase) {
    case "init":
    case "invariants_from_docs": {
      instructions = buildInitGuidance(
        options,
        toolName,
        tool,
        invariantSource,
        targetScope,
        session.sessionId
      );
      nextPhase =
        invariantSource === "all"
          ? "invariants_from_tests"
          : "invariants_extracted";
      break;
    }
    case "invariants_from_tests": {
      instructions = buildExtractTestsGuidance(
        options,
        toolName,
        tool,
        invariantSource,
        targetScope,
        session.sessionId
      );
      nextPhase = "invariants_extracted";
      break;
    }
    case "invariants_extracted": {
      // In "all" mode, verify step 1b (invariants_from_tests) was completed
      if (
        session.invariantSource === "all" &&
        !session.transitions.some(
          (t) => t.phaseFrom === "invariants_from_tests"
        )
      ) {
        throw new Error(
          "Execution Gate Blocked (Invariant Extraction Incomplete): When invariantSource is 'all', you must complete both Step 1 (Documented Invariants from docs) and Step 2 (Empirical Invariants from tests). Call nanofuzz_findBugs with phase: 'invariants_from_tests' before proceeding to invariants_extracted."
        );
      }

      // Gate 1: Require at least 1 valid entrypoint with non-empty invariants
      const rawEntrypoints = payload.entrypoints;
      const validEntrypoints: {
        name: string;
        filePath: string;
        invariants: string[];
        harnessFilePath?: string;
        harnessFunctionName?: string;
      }[] = [];

      if (Array.isArray(rawEntrypoints)) {
        for (const e of rawEntrypoints) {
          if (
            isRecord(e) &&
            typeof e.name === "string" &&
            e.name.trim().length > 0 &&
            Array.isArray(e.invariants) &&
            e.invariants.length > 0
          ) {
            validEntrypoints.push({
              name: e.name.trim(),
              filePath: typeof e.filePath === "string" ? e.filePath : "",
              invariants: e.invariants.map(String),
              harnessFilePath:
                typeof e.harnessFilePath === "string"
                  ? e.harnessFilePath
                  : undefined,
              harnessFunctionName:
                typeof e.harnessFunctionName === "string"
                  ? e.harnessFunctionName
                  : undefined,
            });
          }
        }
      }

      if (validEntrypoints.length === 0) {
        throw new Error(
          "Execution Gate Blocked (Gate 1: Invariant Extraction): No valid entrypoints with invariants provided. You must register at least one entrypoint with non-empty invariants."
        );
      }

      // Gate 1b: If targetScope is configured, verify all pre-selected entrypoints are accounted for
      if (targetScope.length > 0) {
        const missingTargets = targetScope.filter(
          (target) =>
            !validEntrypoints.some((e) => targetMatchesEntrypoint(target, e))
        );
        if (missingTargets.length > 0) {
          throw new Error(
            `Execution Gate Blocked (Gate 1: Missing Pre-Selected Entrypoints): The following prescribed entrypoint(s) were not registered with invariants: ${missingTargets.join(", ")}. You must register invariants for all pre-selected entrypoints in targetScope: ${targetScope.join(", ")}.`
          );
        }
      }

      session.entrypoints = validEntrypoints;

      instructions = buildInvariantsGuidance(
        options,
        toolName,
        tool,
        invariantSource,
        session.sessionId
      );
      nextPhase = "fuzz_smoke";
      break;
    }
    case "fuzz_smoke": {
      if (!session.entrypoints || session.entrypoints.length === 0) {
        throw new Error(
          "Execution Gate Blocked (Invariant Registration Required): You cannot begin fuzzing before discovering entrypoints and registering invariants. Call nanofuzz_findBugs with phase: 'invariants_extracted' and register your target entrypoints first."
        );
      }

      instructions = buildFuzzSmokeGuidance(
        options,
        toolName,
        tool,
        invariantSource,
        session.sessionId
      );
      nextPhase = "fuzz_deep";
      break;
    }
    case "fuzz_deep": {
      if (!session.entrypoints || session.entrypoints.length === 0) {
        throw new Error(
          "Execution Gate Blocked (Invariant Registration Required): You cannot begin fuzzing before discovering entrypoints and registering invariants. Call nanofuzz_findBugs with phase: 'invariants_extracted' and register your target entrypoints first."
        );
      }

      const fnName =
        typeof payload.functionName === "string" ? payload.functionName : "";
      const hasSmokeRun = session.fuzzRuns.some((r) =>
        functionMatchesEntrypoint(r.functionName, fnName)
      );
      // Gate 2: Enforce Stage 1 smoke testing before deep fuzzing.
      if (!hasSmokeRun) {
        throw new Error(
          `Execution Gate Blocked (Gate 2: Smoke Testing Required): Missing smoke test for '${fnName}'. You must execute Phase: 'fuzz_smoke' before proceeding to Phase: 'fuzz_deep'.`
        );
      }

      instructions = buildFuzzEntrypointGuidance(
        options,
        toolName,
        tool,
        invariantSource,
        workerCount,
        session.sessionId
      );

      // Check if any declared entrypoints still need smoke or deep fuzzing
      const pendingSmoke = session.entrypoints.filter(
        (e) =>
          !session.fuzzRuns.some((r) =>
            functionMatchesEntrypoint(r.functionName, e)
          )
      );
      if (pendingSmoke.length > 0) {
        nextPhase = "fuzz_smoke";
      } else {
        // Enforce Stage 2 Deep Fuzzing: ALL declared entrypoints must satisfy deep criteria
        // (including the current entrypoint) before advancing out of fuzz_deep!
        const pendingDeep = session.entrypoints.filter(
          (e) => !sessionManager.isEntrypointDeepCriteriaMet(session, e)
        );
        const shouldSkipContextualize =
          !session.benchmarkMode && skipContextualization;
        nextPhase =
          pendingDeep.length > 0
            ? "fuzz_deep"
            : shouldSkipContextualize
              ? "complete"
              : "contextualize_bugs";
      }
      break;
    }
    case "fuzz_entrypoint": {
      if (!session.entrypoints || session.entrypoints.length === 0) {
        throw new Error(
          "Execution Gate Blocked (Invariant Registration Required): You cannot begin fuzzing before discovering entrypoints and registering invariants. Call nanofuzz_findBugs with phase: 'invariants_extracted' and register your target entrypoints first."
        );
      }

      const fnName =
        typeof payload.functionName === "string" ? payload.functionName : "";
      const hasSmokeRun = session.fuzzRuns.some((r) =>
        functionMatchesEntrypoint(r.functionName, fnName)
      );
      // Gate 2: Enforce Stage 1 smoke testing. Passing stage: "deep" directly without a smoke run is rejected.
      const isDeepStage = hasSmokeRun && payload.stage === "deep";

      if (!isDeepStage) {
        instructions = buildFuzzSmokeGuidance(
          options,
          toolName,
          tool,
          invariantSource,
          session.sessionId
        );
        nextPhase = "fuzz_deep";
      } else {
        instructions = buildFuzzEntrypointGuidance(
          options,
          toolName,
          tool,
          invariantSource,
          workerCount,
          session.sessionId
        );

        // Enforce Stage 2 Deep Fuzzing: ALL declared entrypoints must satisfy deep criteria
        // before advancing out of deep fuzzing!
        const pendingDeep = session.entrypoints.filter(
          (e) => !sessionManager.isEntrypointDeepCriteriaMet(session, e)
        );
        const shouldSkipContextualize =
          !session.benchmarkMode && skipContextualization;
        nextPhase =
          pendingDeep.length > 0
            ? "fuzz_deep"
            : shouldSkipContextualize
              ? "complete"
              : "contextualize_bugs";
      }
      break;
    }
    case "contextualize_bugs": {
      // Gate 2 Check: All declared entrypoints must have completed Stage 1 smoke tests
      const pendingSmoke = sessionManager.getPendingSmokeEntrypoints(
        session.sessionId
      );
      if (pendingSmoke.length > 0) {
        throw new Error(
          `Execution Gate Blocked (Gate 2: Smoke Testing): Missing smoke tests for declared entrypoint(s): ${pendingSmoke.join(", ")}. All declared entrypoints must complete Stage 1 Smoke Testing before advancing.`
        );
      }

      // Gate 3 Check: All declared entrypoints must have completed Stage 2 Deep Fuzzing (300,000ms / maxTests: 0)
      const hasCompletedFuzzing =
        session.fuzzRuns.length > 0 &&
        sessionManager.hasCompletedDeepRun(session.sessionId);

      if (!hasCompletedFuzzing) {
        const pendingDeep = sessionManager.getPendingDeepEntrypoints(
          session.sessionId
        );
        const detail =
          pendingDeep.length > 0
            ? `Pending Stage 2 Deep Fuzzing for entrypoint(s): ${pendingDeep.join(", ")}.`
            : "Stage 2 Deep Fuzzing (300,000ms / 5 minutes per attempt, maxTests: 0) was never executed.";

        throw new Error(
          `Execution Gate Blocked (Gate 3: Deep Fuzzing Required): ${detail} You MUST execute Stage 2: Deep Fuzzing with timeoutMs: 300000 and maxTests: 0 for all declared entrypoints before advancing to contextualize_bugs.`
        );
      }

      if (session.benchmarkMode) {
        instructions = buildBenchmarkContextualizeBugsGuidance(
          options,
          toolName,
          tool,
          invariantSource,
          session.sessionId,
          session.reportPath
        );
      } else {
        instructions = buildContextualizeBugsGuidance(
          options,
          toolName,
          tool,
          invariantSource,
          session.sessionId
        );
      }
      nextPhase = "complete";
      break;
    }
    case "complete": {
      // In benchmark mode: verify that the report file exists and is non-empty (>500 bytes)
      if (session.benchmarkMode) {
        const reportPath = session.reportPath;
        const hasReport =
          reportPath &&
          fs.existsSync(reportPath) &&
          fs.statSync(reportPath).size > 500;
        if (!hasReport) {
          throw new Error(
            `Execution Gate Blocked (Bug Report File Required): You cannot complete the benchmark workflow without saving your evaluation report. You MUST write and save your comprehensive evaluation report to '${reportPath || "<assigned_report_path>"}' using create_file before completing this workflow.`
          );
        }
      }

      // Gate 3 Check: All declared entrypoints must have completed Stage 2 Deep Fuzzing
      const hasCompletedFuzzing =
        session.fuzzRuns.length > 0 &&
        sessionManager.hasCompletedDeepRun(session.sessionId);

      if (!hasCompletedFuzzing) {
        const pendingDeep = sessionManager.getPendingDeepEntrypoints(
          session.sessionId
        );
        const detail =
          pendingDeep.length > 0
            ? `Pending Stage 2 Deep Fuzzing for entrypoint(s): ${pendingDeep.join(", ")}.`
            : "Stage 2 Deep Fuzzing (300,000ms / 5 minutes per attempt, maxTests: 0) was never executed.";

        throw new Error(
          `Execution Gate Blocked (Gate 3: Deep Fuzzing Required): ${detail} You MUST execute Stage 2: Deep Fuzzing with timeoutMs: 300000 and maxTests: 0 for all declared entrypoints before completing the workflow.`
        );
      }

      // Phase 6 Check: If defects were found in fuzzing runs, Phase 6 contextualization must not have been skipped
      const totalFailuresInSession = session.fuzzRuns.reduce(
        (sum, r) => sum + r.failedTests + r.exceptions,
        0
      );
      const hasContextualized = session.transitions.some(
        (t) =>
          t.phaseTo === "contextualize_bugs" ||
          t.phaseFrom === "contextualize_bugs"
      );
      const shouldSkipContextualize =
        !session.benchmarkMode && skipContextualization;
      if (
        totalFailuresInSession > 0 &&
        !hasContextualized &&
        !shouldSkipContextualize
      ) {
        throw new Error(
          "Execution Gate Blocked (Phase 6 Contextualization Required): Defect failures were recorded during fuzzing, but Phase 6 (Bug Contextualization & Maintainer Intent Verification) was skipped. You must call nanofuzz_findBugs with phase: 'contextualize_bugs' to verify findings against public issues/PRs before completing the workflow."
        );
      }

      // Gate 4: Validate that reported bugs have genuine evidence and correspond to recorded failures
      const reportedBugs = payload.bugs;
      if (Array.isArray(reportedBugs) && reportedBugs.length > 0) {
        for (const bug of reportedBugs) {
          if (isRecord(bug)) {
            const entrypoint =
              typeof bug.entrypoint === "string" ? bug.entrypoint : undefined;
            if (
              entrypoint &&
              !session.fuzzRuns.some(
                (r) =>
                  (r.failedTests > 0 || r.exceptions > 0) &&
                  functionMatchesEntrypoint(r.functionName, entrypoint)
              )
            ) {
              throw new Error(
                `Execution Gate Blocked (Gate 4: Bug Validation): Bug reported for '${entrypoint}', but no failures or exceptions were recorded for '${entrypoint}' in any fuzzing run. Reported bugs must be backed by reproducible test failures.`
              );
            }
          }
        }
      }

      instructions = buildCompleteGuidance(options, toolName, session);
      nextPhase = undefined;
      break;
    }
    default: {
      instructions = `Unknown phase '${String(phase)}'. Valid phases are: 'init', 'invariants_extracted', 'fuzz_entrypoint', 'contextualize_bugs', 'complete'.`;
      nextPhase = "init";
      break;
    }
  }

  // Record transition telemetry at every phase boundary
  sessionManager.recordTransition(session, phase, nextPhase ?? "complete");

  const summaryText = [
    `## 🪲 ${toolName} Find Bugs: Phase \`${phase}\``,
    "",
    instructions,
  ].join("\n");

  return {
    phase,
    instructions,
    recommendedNextPhase: nextPhase,
    summaryText,
  };
} // fn: findBugs

// -------------------------------------------------------------------------- //
// Private Phase Guidance Generators
// -------------------------------------------------------------------------- //

/**
 * Builds guidance for Phase 1: Test discovery and black-box invariant extraction.
 */
function buildInitGuidance(
  options: FindBugsOptions,
  toolName: string,
  tool: FindBugsTool,
  invariantSource: FindBugsInvariantSource,
  targetScope: string[],
  sessionId: string
): string {
  const targetDir = options.targetPath
    ? resolveFilePath(options.targetPath)
    : process.cwd();

  const repoNotice = options.repoUrl
    ? `1. **Clone Repository**: Checkout \`${options.repoUrl}\` into a temporary directory if not already checked out.\n`
    : `1. **Verify Target Path**: Working directory is \`${targetDir}\`.\n`;

  const invariantSourceSection =
    invariantSource === "docs"
      ? [
          `2. **Find API Documentation (Primary Specification Oracle)**:`,
          `   - Locate documentation files (e.g. \`docs/\`, \`doc/\`, \`README.md\`, docstrings, architecture decisions).`,
          `   - ⚠️ **The documentation is your specification and primary oracle**: treat it as ground truth even when it disagrees with the implementation.`,
          `   - Think about this as: *"If I had to prove the library correct by random testing, what properties would I check?"*`,
          `   - Do NOT read internal function bodies at this stage; derive properties purely from documented contracts.`,
          "",
          `3. **Extract Documented Contracts & Concrete Seed Inputs**:`,
          `   - For each prioritized entrypoint, extract:`,
          `     - *Concrete Seed Inputs & Edge Cases*: literal example inputs found in documentation, docstrings, tutorial calls, and README examples (zero values, boundary strings, empty containers, documented numerical limits).`,
          `     - *Expected Error Contracts*: documented exceptions or errors when invalid arguments are provided.`,
          `     - *Documented Invariants*: return value promises, round-trip identities, and semantic constraints promised by documentation.`,
        ].join("\n")
      : invariantSource === "all"
        ? [
            `2. **Inspect Documentation (Step 1/2: Documented Invariants)**:`,
            `   - Read API documentation (\`docs/\`, \`README.md\`, docstrings) as your primary specification oracle for intended contracts.`,
            `   - ⚠️ **Strict Information Barrier (Black-Box Oracle Rule)**: Do NOT read existing test files or internal implementation bodies during this step. Extract invariants and example seeds strictly from documentation and type signatures.`,
            "",
            `3. **Extract Documented Contracts & Concrete Seed Inputs**:`,
            `   - For each prioritized entrypoint, extract:`,
            `     - *Concrete Seed Inputs & Edge Cases*: literal example inputs found in documentation, docstrings, tutorial calls, and README examples (zero values, boundary strings, empty containers, documented numerical limits).`,
            `     - *Expected Error Contracts*: documented exceptions or errors when invalid arguments are provided.`,
            `     - *Documented Invariants*: return value promises, round-trip identities, and semantic constraints promised by documentation.`,
          ].join("\n")
        : [
            `2. **Find Existing Test Suite & Documentation**:`,
            `   - Locate the project's test files (e.g. \`test/\`, \`tests/\`, \`__tests__/\`, \`*.test.*\`, \`*_test.*\`).`,
            `   - Read test cases, docstrings, README files, and exported function/type signatures.`,
            "",
            `3. **Strict Information Barrier (Black-Box Oracle Rule)**:`,
            `   - ⚠️ **DO NOT READ THE INTERNAL IMPLEMENTATION BODIES** of target functions during this phase.`,
            `   - Extract invariants *strictly* from tests, documentation, and public type contracts. Reading function bodies now risks mirroring bugs into your test validators (tautological oracles).`,
            "",
            `4. **Extract Empirical Contracts & Concrete Seed Inputs**:`,
            `   - For each prioritized entrypoint, extract:`,
            `     - *Concrete Seed Inputs & Edge Cases*: literal inputs tested in unit tests (zero values, boundary strings, empty containers, extreme values).`,
            `     - *Expected Error Contracts*: documented or tested exceptions for invalid arguments.`,
            `     - *Regression Invariants*: output properties verified by existing test assertions.`,
          ].join("\n");

  const propertyTaxonomy =
    invariantSource === "docs" || invariantSource === "all"
      ? [
          `   - Extract all documented behaviors, invariants, and boundary conditions for each prioritized entrypoint:`,
          `     - *Stated Semantic Contracts*: exact promises on return values, ranges, and state transitions.`,
          `     - *Model-Based Oracles*: compare results against simple reference implementations (like comparing to \`sorted()\`, a dictionary lookup, or an oracle loop).`,
          `     - *Round-Trip & Inverses*: inverse transformations promised in docs (like decode(encode(x)) == x).`,
          `     - *Documented Boundaries & Thresholds*: min/max sizes, zeros, empty collections, documented numerical limits.`,
          `     - *Error Contracts*: documented exceptions or errors when invalid arguments are provided.`,
          `   - ⚠️ **Do not spend budget hunting for a specific known bug**. Cover the specification broadly for each prioritized entrypoint; property fuzzing will find deviations.`,
        ].join("\n")
      : [
          `   - Formulate generalized invariants across diverse property classes:`,
          `     - *Round-Trip / Inverse Operations*: \`f_inv(f(x)) == x\` (encode/decode, serialize/deserialize, compress/decompress).`,
          `     - *Idempotence*: \`f(f(x)) == f(x)\` (formatting, sanitization, canonicalization, normalization).`,
          `     - *Metamorphic Relations*: predicting relative output changes under input perturbations (like inserting an item increments count by 1; scaling inputs scales numeric outputs proportionally).`,
          `     - *Invariant State Consistency*: structural integrity laws (like balance non-negative, acyclicity, balance factors within bounds, no duplicate keys).`,
          `     - *Differential / Reference Equivalence*: comparing optimized vs reference implementations.`,
          `     - *Error & Exception Safety*: inputs outside contract must raise structured, typed errors rather than crashing with unhandled runtime panics, segfaults, or infinite loops.`,
          `     - *Conservation Laws*: quantities conserved across transformations (like item counts, total mass, token conservation, checksums).`,
        ].join("\n");

  const extractionItems: string[] =
    invariantSource === "all"
      ? [
          "Documented Invariants (from docs)",
          "Empirical Invariants & Seed Extraction (from unit tests)",
        ]
      : [
          invariantSource === "docs"
            ? "Documented Invariants (from docs)"
            : "Empirical Invariants & Seed Extraction (from unit tests)",
        ];

  const todoItems = [
    "Codebase Discovery & Entrypoint Ranking",
    ...extractionItems,
    "Test Suite Synthesis",
    "Smoke Test & Oracle Validation",
    "Deep Fuzzing & Exploration Loop",
    "Bug Contextualization & Disposition",
  ]
    .map((item, idx) => `     ${idx + 1}. ${item}`)
    .join("\n");

  const nextStepPhase =
    invariantSource === "all"
      ? "invariants_from_tests"
      : "invariants_extracted";
  const nextStepDesc =
    invariantSource === "all"
      ? `When you have extracted entrypoints and documented invariants from docs, invoke \`${toolName.toLowerCase()}_findBugs\` to execute Step 2 (test extraction):`
      : `When you have extracted the list of entrypoints and invariants, invoke \`${toolName.toLowerCase()}_findBugs\` with:`;

  return [
    `### Instructions for Phase 1: Discovery & Invariant Extraction [Engine: ${tool} | Source: ${invariantSource}]`,
    "",
    `0. **Workflow Tracking (To-Do List Initialization)**:`,
    `   - If your environment provides a structured to-do list tool (e.g. \`manage_todo_list\`), initialize a to-do list with the following items, mark item 1 as \`in-progress\` before beginning, and update the list as you advance:`,
    todoItems,
    `   - ⚠️ **Zero Terminal Testing Rule**: NEVER run \`pytest\`, \`hypofuzz\`, or test runners directly in the terminal via shell commands. All test execution, fuzzing, and telemetry collection MUST be run through \`nanofuzz_fuzzFunction\`.`,
    "",
    repoNotice,
    invariantSourceSection,
    "",
    targetScope.length > 0
      ? [
          `4. **Target Pre-Selected Entrypoints (Prescribed Target Scope)**:`,
          `   - ⚠️ **Prescribed Target Scope**: This benchmark session has pre-selected the following ${targetScope.length} entrypoint(s) that you MUST target:`,
          ...targetScope.map((t, idx) => `     ${idx + 1}. \`${t}\``),
          `   - You MUST extract invariants and register each of these ${targetScope.length} pre-selected entrypoints. Do NOT substitute or omit any of them.`,
          `   - Inspect the source files and existing tests containing these symbols to extract their contract invariants.`,
        ].join("\n")
      : [
          `4. **Identify Program Entrypoints & Invariants**:`,
          `   - Call \`nanofuzz_listTargets\` on your source files to inspect functions and their computed \`priority\` scores (0-100).`,
          `   - **Sort functions by \`priority\` descending** and select the top-ranked public entrypoints first. Do NOT target low-priority internal helpers.`,
          `   - Identify coupled entrypoint groups (e.g. encode/decode, serialize/deserialize, stateful sequences).`,
        ].join("\n"),
    propertyTaxonomy,
    "",
    `5. **Next Step**:`,
    `   - ${nextStepDesc}`,
    "   ```json",
    "   {",
    `     "phase": "${nextStepPhase}",`,
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "statePayload": {',
    `       "sessionId": "${sessionId}",`,
    '       "entrypoints": [',
    targetScope.length > 0
      ? targetScope
          .map(
            (t) =>
              `         { "name": "${t}", "filePath": "<relPath>", "invariants": ["<desc1>", "<desc2>"], "harnessFunctionName": "test_${t.toLowerCase().replace(/^_+/, "")}", "seeds": [{"<param1>": "<seedVal>"}] }`
          )
          .join(",\n")
      : '         { "name": "<functionName>", "filePath": "<relPath>", "invariants": ["<desc1>", "<desc2>"], "harnessFunctionName": "test_<functionName>", "seeds": [{"<param1>": "<seedVal>"}] }',
    "       ]",
    "     }",
    "   }",
    "   ```",
  ].join("\n");
} // fn: buildInitGuidance

/**
 * Builds guidance for Phase 1b (when invariantSource === "all"): Empirical Invariant & Seed Extraction from unit tests.
 */
function buildExtractTestsGuidance(
  options: FindBugsOptions,
  toolName: string,
  tool: FindBugsTool,
  invariantSource: FindBugsInvariantSource,
  targetScope: string[],
  sessionId: string
): string {
  const scopeReminder =
    targetScope.length > 0
      ? `\n   - Focus extraction strictly on the ${targetScope.length} pre-selected entrypoints: ${targetScope.map((t) => `\`${t}\``).join(", ")}.`
      : "";

  return [
    `### Instructions for Phase 1b: Empirical Invariant & Seed Extraction [Engine: ${tool} | Source: all (Step 2/2: Tests)]`,
    "",
    `Now extract concrete input seeds, boundary behaviors, and regression contracts from established test files:${scopeReminder}`,
    "",
    `1. **Find Test Files**:`,
    `   - Locate the project's existing test files (e.g. \`test/\`, \`tests/\`, \`__tests__/\`, \`*.test.*\`, \`*_test.*\`).`,
    `   - Read test cases, assertions, mock objects, and example inputs for the prioritized entrypoints.`,
    "",
    `2. **Strict Information Barrier**:`,
    `   - ⚠️ **DO NOT READ INTERNAL IMPLEMENTATION CODE**: Inspect only tests and public type contracts. Reading function bodies risks copying implementation flaws into test assertions.`,
    "",
    `3. **Extract Empirical Contracts & Concrete Seed Inputs**:`,
    `   - For each prioritized entrypoint, extract:`,
    `     - *Concrete Seed Inputs & Edge Cases*: literal inputs tested in unit tests (zero values, boundary strings, empty containers, extreme values).`,
    `     - *Expected Error Contracts*: documented or tested exceptions for invalid arguments.`,
    `     - *Regression Invariants*: output properties verified by existing test assertions.`,
    `   - Merge these test-derived invariants with the documented invariants extracted in Step 1.`,
    "",
    `4. **Next Step**:`,
    `   - Advance to Phase 2 (Harness Synthesis) by invoking \`${toolName.toLowerCase()}_findBugs\` with:`,
    "   ```json",
    "   {",
    '     "phase": "invariants_extracted",',
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "statePayload": {',
    `       "sessionId": "${sessionId}",`,
    '       "entrypoints": [',
    '         { "name": "<functionName>", "filePath": "<relPath>", "invariants": ["<docInvariant>", "<testInvariant>"], "harnessFunctionName": "test_<functionName>", "seeds": [...] }',
    "       ]",
    "     }",
    "   }",
    "   ```",
  ].join("\n");
} // fn: buildExtractTestsGuidance

/**
 * Builds guidance for Phase 2: Harness, validator, transformer, and generator synthesis.
 */
function buildInvariantsGuidance(
  options: FindBugsOptions,
  toolName: string,
  tool: FindBugsTool,
  invariantSource: FindBugsInvariantSource,
  sessionId: string
): string {
  if (tool === "hypothesis" || tool === "hypofuzz") {
    return [
      `### Instructions for Phase 3: Hypothesis Test Suite Synthesis [Engine: ${tool} | Source: ${invariantSource}]`,
      "",
      `1. **Create Test File**:`,
      `   - Create a dedicated test file in the project's test directory (e.g. \`tests/test_pbt_<entrypoint>.py\`).`,
      `   - Import Hypothesis: \`from hypothesis import given, strategies as st\`.`,
      "",
      `2. **Design Inclusive Parameter Strategies**:`,
      `   - Construct strategies that faithfully match each parameter's domain—for example:`,
      `     - Use composite strategies (\`@st.composite\`) to build multi-attribute objects, records, or packet structures.`,
      `     - Use strategy transformations (like \`.map()\`, \`.filter()\`, or \`.flatmap()\`) to construct valid domain instances.`,
      `     - Use specialized strategy builders (like \`st.dates()\`, \`st.binary()\`, \`st.decimals()\`, or \`st.recursive()\` for nested structures).`,
      `     - Avoid unconstrained primitive defaults where structured inputs are required.`,
      "",
      `3. **Implement Focused Property Tests**:`,
      `   - Write focused test functions decorated with \`@given(...)\`.`,
      `   - Name each test function with \`test_<entrypoint>\` (e.g. \`test_trailing_bits_to_int\`).`,
      `   - Assert that the extracted invariants hold across all generated cases.`,
      `   - ⚠️ **STRICT EXECUTION RULE — DO NOT RUN PYTEST IN TERMINAL**: Do NOT run \`pytest\`, \`python\`, or shell commands in the terminal to "verify" or execute your tests. As soon as you write your test functions, proceed IMMEDIATELY to calling \`${toolName.toLowerCase()}_findBugs\` with \`phase: "fuzz_entrypoint"\`. NaNofuzz executes, measures, and triages Hypothesis tests automatically through its execution engine.`,
      "",
      `4. **Seed Properties with Harvested Inputs**:`,
      `   - Collect your concrete seed inputs extracted in Phase 1 and format them as an array of parameter objects (e.g. \`[{"<param1>": <val1>, "<param2>": <val2>}]\`).`,
      `   - Pass these seeds in \`"inputs": [...]\` when invoking \`nanofuzz_fuzzFunction\`.`,
      `   - Constrain all integer seed inputs to safe numeric bounds between \`-2**53 + 1\` and \`2**53 - 1\` (approximately \`-9e15\` to \`9e15\`).`,
      `   - The engine executes these concrete seeds first to verify baseline contracts before randomized exploration begins.`,
      "",
      `5. **Next Step**:`,
      `   - Call \`${toolName.toLowerCase()}_findBugs\` for your first entrypoint to begin Stage 1 Smoke Testing:`,
      "   ```json",
      "   {",
      '     "phase": "fuzz_smoke",',
      `     "model": "${options.model}",`,
      `     "vendor": "${options.vendor}",`,
      '     "statePayload": {',
      `       "sessionId": "${sessionId}",`,
      '       "harnessFilePath": "tests/test_pbt_<entrypoint>.py",',
      '       "functionName": "test_<entrypoint>",',
      '       "inputs": [{"<param1>": "<seedVal>"}]',
      "     }",
      "   }",
      "   ```",
    ].join("\n");
  }

  return [
    `### Instructions for Phase 3: Harness & Validator Synthesis [Engine: nanofuzz | Source: ${invariantSource}]`,
    "",
    `1. **Create Isolated Harness Files**:`,
    `   - For each entrypoint or coupled group, create a dedicated harness file **inside the project root/source tree** (e.g. \`<projectRoot>/nanofuzz_harness_<entrypoint>.<ext>\`).`,
    `   - ⚠️ Do NOT place harness files in an external \`/tmp\` directory—language runners need project \`tsconfig.json\`, \`package.json\`, \`Cargo.toml\`, or virtualenvs to resolve imports.`,
    `   - Define a typed function (e.g. \`fuzz_<entrypoint>\`) that takes typed arguments and calls the target entrypoint.`,
    `   - ⚠️ **No Hardcoded Lookup Tables or Initial States**: NEVER pass an integer index into a hardcoded array of test inputs (e.g. \`INITIAL_DOCS[idx % len(INITIAL_DOCS)]\`) or hardcode initial states inside the harness body. Always pass the initial state/document/data directly as a typed parameter (e.g. \`raw_doc: str\` or \`initial_items: list[...]\`) and construct the initial state dynamically from those inputs so NaNofuzz can generate, mutate, and shrink the initial state itself.`,
    "",
    `2. **Synthesize Skeletons with \`nanofuzz_listTargets\`**:`,
    `   - Call \`nanofuzz_listTargets\` on your harness file to inspect the generated templates:`,
    `     - \`validatorTemplate\` (e.g. \`<fn>Validator\` or \`<fn>_validator\`)`,
    `     - \`transformerTemplate\` (e.g. \`<fn>Transformer\` or \`<fn>_transformer\`)`,
    `     - \`generatorTemplate\` (e.g. \`<fn>Generator\` or \`<fn>_generator\`)`,
    "",
    `3. **Implement Property Validators (\`<fn>Validator\`)**:`,
    `   - Place the validator in the same harness file. Assert that the specification invariants hold.`,
    "",
    `4. **Implement Constructive Transformers (\`<fn>Transformer\`)**:`,
    `   - **Construct/Repair rather than filter**: Normalize bounds, compute checksums, and repair relations.`,
    `   - Avoid heavy \`assume()\` filtering to prevent starving the fuzzer.`,
    `   - Note: Dual-Mode fuzzing is supported by toggling \`useTransformer: true\` (Semantic Mode) vs \`useTransformer: false\` (Adversarial/Robustness Mode).`,
    "",
    `5. **Implement Custom Generators (\`<fn>Generator\`)**:`,
    `   - If inputs are structured (e.g. ASTs, grammar, XML, JSON), implement the PRNG generator template.`,
    "",
    `6. **Seed Properties with Harvested Inputs**:`,
    `   - Collect your concrete seed inputs extracted in Phase 1 and format them as an array of parameter objects (e.g. \`[{"<param1>": <val1>, "<param2>": <val2>}]\`).`,
    `   - Pass these seeds in \`"inputs": [...]\` when invoking \`nanofuzz_fuzzFunction\`.`,
    `   - Constrain all integer seed inputs to safe numeric bounds between \`-2**53 + 1\` and \`2**53 - 1\` (approximately \`-9e15\` to \`9e15\`).`,
    `   - The engine executes these concrete seeds first to verify baseline contracts before randomized exploration begins.`,
    "",
    `7. **Next Step**:`,
    `   - Call \`${toolName.toLowerCase()}_findBugs\` for your first entrypoint to begin Stage 1 smoke testing:`,
    "   ```json",
    "   {",
    '     "phase": "fuzz_smoke",',
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "statePayload": {',
    `       "sessionId": "${sessionId}",`,
    '       "stage": "smoke",',
    '       "harnessFilePath": "<path>",',
    '       "functionName": "fuzz_<entrypoint>",',
    '       "inputs": [{"<param1>": "<seedVal>"}]',
    "     }",
    "   }",
    "   ```",
  ].join("\n");
} // fn: buildInvariantsGuidance

/**
 * Builds guidance for Phase 3 Stage 1: Fast Smoke Testing and Oracle Validation.
 */
function buildFuzzSmokeGuidance(
  options: FindBugsOptions,
  toolName: string,
  tool: FindBugsTool,
  invariantSource: FindBugsInvariantSource,
  sessionId: string
): string {
  const payload = options.statePayload ?? {};
  const harnessPath =
    typeof payload.harnessFilePath === "string"
      ? payload.harnessFilePath
      : "<harnessFilePath>";
  const fnName =
    typeof payload.functionName === "string"
      ? payload.functionName
      : "<harnessFnName>";

  return [
    `### Instructions for Phase 4: Fast Smoke Testing & Oracle Validation [Engine: ${tool} | Source: ${invariantSource}]`,
    "",
    `Execute Stage 1 Smoke Testing for \`${fnName}\` in \`${harnessPath}\`:`,
    "",
    `⚠️ **STRICT TOOL INVOCATION RULE**: You MUST execute this run using \`nanofuzz_fuzzFunction\`. Do NOT run \`pytest\`, \`hypofuzz\`, or test runners directly in the terminal via shell commands. Running via \`nanofuzz_fuzzFunction\` captures structured telemetry, executes watchdog timeouts, and feeds results directly into the bug hunting state machine.`,
    "",
    `1. **Timeout Configuration (\`fnTimeout\`)**:`,
    `   - The default per-test execution timeout is **500ms**.`,
    `   - If the target function or transformer normally requires significant execution time, estimate the expected single-run execution time. If twice that expected runtime exceeds 500ms, set \`fnTimeout\` to **2x expected runtime** (e.g. \`1000\` or \`2000\`) in Stage 1 to prevent spurious timeouts while still catching true infinite loops.`,
    "",
    `2. **Stage 1: Fast Smoke Test (100 tests, 3000ms)**:`,
    `   Call \`nanofuzz_fuzzFunction\` with:`,
    "   ```json",
    "   {",
    `     "filePath": "${harnessPath}",`,
    `     "functionName": "${fnName}",`,
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "coverageScope": "project directimports",',
    '     "fnTimeout": 500,',
    '     "maxTests": 100,',
    '     "timeoutMs": 3000,',
    '     "inputs": [...]',
    "   }",
    "   ```",
    `   ⚠️ **Target Warning**: \`filePath\` MUST be \`${harnessPath}\` (the test file or harness you created), NOT the production source file! And \`functionName\` MUST be \`${fnName}\`.`,
    "",
    `3. **Verify Smoke Test Outcomes**:`,
    `   - If \`harnessErrors\` is non-empty or \`erroredTests > 0\`, fix the bug in \`<fn>Validator\`, \`<fn>Transformer\`, or \`<fn>Generator\` and re-run Stage 1.`,
    `   - If any seed test fails with \`category: "disagree"\` (or diagnosis reports "Property validator disagreed with the expected output"):`,
    `     ⚠️ **Your property validator invariant is wrong**: the real code produced what the established project unit test expected, but your validator rejected it. Fix \`<fn>Validator\` to match established specifications before proceeding.`,
    `   - If \`skippedTests\` rejection rate is high (>80%), rewrite \`<fn>Transformer\` to construct/clamp valid inputs instead of filtering.`,
    "",
    `4. **Next Step**:`,
    `   - Once Stage 1 completes cleanly without errors or oracle disagreements, call \`${toolName.toLowerCase()}_findBugs\` to get Stage 2 Deep Fuzzing guidance:`,
    "   ```json",
    "   {",
    '     "phase": "fuzz_deep",',
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "statePayload": {',
    `       "sessionId": "${sessionId}",`,
    '       "stage": "deep",',
    `       "harnessFilePath": "${harnessPath}",`,
    `       "functionName": "${fnName}",`,
    '       "inputs": [...]',
    "     }",
    "   }",
    "   ```",
  ].join("\n");
} // fn: buildFuzzSmokeGuidance

/**
 * Builds guidance for Phase 5: Deep Fuzzing execution, triage protocol, and 5-retry coverage loop.
 */
function buildFuzzEntrypointGuidance(
  options: FindBugsOptions,
  toolName: string,
  tool: FindBugsTool,
  invariantSource: FindBugsInvariantSource,
  _workerCount: number,
  _sessionId: string
): string {
  const payload = options.statePayload ?? {};
  const harnessPath =
    typeof payload.harnessFilePath === "string"
      ? payload.harnessFilePath
      : "<harnessFilePath>";
  const fnName =
    typeof payload.functionName === "string"
      ? payload.functionName
      : "<harnessFnName>";

  return [
    `### Instructions for Phase 5: Deep Fuzzing & Exploration Loop [Engine: ${tool} | Source: ${invariantSource}]`,
    "",
    `Execute Stage 2 Deep Fuzzing for \`${fnName}\` in \`${harnessPath}\`:`,
    "",
    `⚠️ **STRICT TOOL INVOCATION RULE**: All fuzzing must be executed using \`nanofuzz_fuzzFunction\`. Do NOT execute \`pytest\`, \`hypofuzz\`, or python commands directly in the terminal.`,
    "",
    `1. **Stage 2: Deep Fuzzing Run (Mandatory - 300,000ms / 5 minutes per attempt)**:`,
    `   Call \`nanofuzz_fuzzFunction\` with \`maxTests: 0\` (no test count limit, running for the full 300,000ms / 5 minutes timeoutMs per attempt to discover all reachable defects rather than aborting prematurely):`,
    `   - Always pass your harvested seed inputs from Phase 1 in \`"inputs": [...]\`.`,
    `   - Constrain all integer seed inputs to safe numeric bounds between \`-2**53 + 1\` and \`2**53 - 1\` (approximately \`-9e15\` to \`9e15\`).`,
    `   - The engine executes these concrete seeds first to verify known edge cases and baseline contracts before randomized exploration begins.`,
    "   ```json",
    "   {",
    `     "filePath": "${harnessPath}",`,
    `     "functionName": "${fnName}",`,
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "coverageScope": "project directimports",',
    '     "fnTimeout": 500,',
    '     "maxTests": 0,',
    '     "timeoutMs": 300000,',
    '     "inputs": [{"<param1>": "<seedVal>"}]',
    "   }",
    "   ```",
    `   ⚠️ **Target Warning**: \`filePath\` MUST be \`${harnessPath}\` (the test file or harness you created), NOT the production source file! And \`functionName\` MUST be \`${fnName}\`.`,
    "",
    `2. **Strict Counterexample Triage & Defect Cataloging Protocol**:`,
    `   - ⚠️ **Anti-Suppression Rule**: NEVER weaken a validator or add \`assume()\` just to make a failure pass.`,
    `   - Only modify the harness/transformer if the input demonstrably violates the public documented API contract.`,
    `   - If the input is legal and the invariant fails (or target crashes), it is a **confirmed bug**!`,
    `   - Synthesize a minimal reproducer test with \`exportSuite: true\` / \`exportFilePath: "..."\` and record which generator elicited the bug.`,
    `   - ⚠️ **Multi-Defect Rule (Do NOT Stop at the First Bug)**: Finding one counterexample does NOT mean fuzzing for this entrypoint is finished. Early bugs frequently shadow deeper, more critical bugs downstream. Catalog this defect and proceed to the coverage and deeper defect exploration loop.`,
    `   - ⚠️ **Forbidden Early Exit**: You are strictly FORBIDDEN from transitioning to \`phase: "contextualize_bugs"\` or \`phase: "complete"\` merely because a bug was found. If retry budget remains and uncovered branches exist, you MUST execute the next retry attempt.`,
    "",
    `3. **Branch Coverage & Deeper Defect Exploration Loop (Max 5 Retries)**:`,
    `   - Inspect target file coverage. Whether tests passed or bugs were discovered, as long as uncovered lines/branches remain in the target entrypoint:`,
    `     1. **Defect Shadowing Mitigation (In-Harness Precondition Clamping)**: If a discovered bug was an early crash or premature exit that prevented reaching downstream code, clamp or filter out that specific trigger in \`<fn>Transformer\` within the same harness so the fuzzer can penetrate deeper into remaining branches. Do NOT spawn secondary harness files. Keep the synthesized reproducer test intact on disk—never discard or suppress it.`,
    `     2. **Widen Inputs & Add Targeted Seeds (Strict Validator Immobility Rule)**: Inspect the remaining uncovered lines in the target file, widen \`<fn>Generator\` or parameter strategies, adjust \`<fn>Transformer\`, or add new targeted seed \`inputs\`. ⚠️ **NEVER modify property assertions or weaken validators during coverage expansion**: the validator embodies the specification and black-box invariants; altering or relaxing it to match uncovered internal code creates tautological oracles that mask genuine defects.`,
    `     3. **Re-run Stage 2**: Continue fuzzing to uncover deeper secondary defects (up to 5 retries total). Record a separate reproducer test and generator attribution for each distinct defect found.`,
    `   - **Stopping Criteria for this Entrypoint**: Stop retrying and move on ONLY when:`,
    `     - All reachable branches in the target entrypoint are covered, OR`,
    `     - The budget of 5 retries has been exhausted.`,
    `     - ⚠️ Finding a bug is NEVER a stopping condition on its own!`,
    "",
    `4. **Advance**:`,
    `   - Repeat Stages 1 & 2 for all remaining entrypoint harnesses.`,
    `   - ⚠️ You cannot advance until Stage 2 Deep Fuzzing has executed!`,
    `   - When all entrypoints are completed:`,
    `     - If any bugs/failing invariants were discovered, call \`${toolName.toLowerCase()}_findBugs\` with \`phase: "contextualize_bugs"\`.`,
    `     - If no bugs were found across all entrypoints, call \`${toolName.toLowerCase()}_findBugs\` with \`phase: "complete"\`.`,
  ].join("\n");
} // fn: buildFuzzEntrypointGuidance

/**
 * Builds benchmark-specific guidance for Phase 6: Bug contextualization without external searches,
 * requiring mandatory report file generation to the assigned benchmark report path.
 */
function buildBenchmarkContextualizeBugsGuidance(
  options: FindBugsOptions,
  toolName: string,
  tool: FindBugsTool,
  invariantSource: FindBugsInvariantSource,
  sessionId: string,
  reportPath?: string
): string {
  const targetReportPath = reportPath || `<assigned_report_path>`;
  return [
    `### Instructions for Phase 6: Bug Contextualization & Report Generation [Engine: ${tool} | Source: ${invariantSource}]`,
    "",
    `The fuzz testing execution phases are now complete. For each confirmed defect or failing invariant discovered:`,
    "",
    `1. **Failure Domain Characterization (Evaluation Rubric Preparation)**:`,
    `   Precisely characterize the failure domain for each defect:`,
    `   - **Root Cause & Trigger**: Identify the triggering module, line number, exception type, and unhandled condition.`,
    `   - **Exact Failure Domain (D*)**: State the exact input boundaries or conditions that cause the failure.`,
    `   - **Safe / Allowed Domain**: Contrast with inputs where the function behaves correctly.`,
    `   - **Minimal Counterexample**: Provide the simplest concrete failing inputs identified during testing and shrinking.`,
    "",
    `2. **Strict Evidentiary Standards (Anti-Rationalization Gate)**:`,
    `   - ⚠️ **CRITICAL ANTI-RATIONALIZATION RULE**: You must NOT classify a bug as "Intentional" or "WontFix" without direct, unambiguous maintainer evidence in the local docstrings, comments, or specifications.`,
    `   - In the absence of an explicit specification stating an exception is intended, the failure MUST be documented as an unintended defect.`,
    "",
    `3. **Taxonomy & Evidence Mapping**:`,
    `   Assign each finding to exactly one structured status:`,
    `   - **Crash / Unhandled Exception**: Unexpected runtime exception on valid or edge-case inputs.`,
    `   - **Contract / Range Violation**: Function returns invalid output, NaN, or violates type/semantic bounds.`,
    `   - **Behavior Discrepancy**: Function violates documented behavior or unit test expectations.`,
    "",
    `4. **Mandatory Bug Report File Generation**:`,
    `   You MUST write and save your comprehensive evaluation report to:`,
    `   \`${targetReportPath}\``,
    `   using \`create_file\`.`,
    `   `,
    `   Structure the report with the following sections:`,
    `   # Benchmark Evaluation Report: <entrypoint>`,
    `   ## Executive Summary (tested entrypoint, tool engine, duration, bugs found)`,
    `   ## Discovered Defects (for each defect: Bug Name, Exception, Exact Failure Domain D*, Minimal Reproducer, and Root Cause Analysis)`,
    `   ## Coverage & Fuzzing Metrics (test counts, branch coverage achieved)`,
    "",
    `5. **Next Step (Gated)**:`,
    `   You CANNOT complete the workflow until \`${targetReportPath}\` has been written to disk using \`create_file\`.`,
    `   Once the file is saved, call \`${toolName.toLowerCase()}_findBugs\` with:`,
    "   ```json",
    "   {",
    '     "phase": "complete",',
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "statePayload": {',
    `       "sessionId": "${sessionId}"`,
    "     }",
    "   }",
    "   ```",
  ].join("\n");
} // fn: buildBenchmarkContextualizeBugsGuidance

/**
 * Builds guidance for Phase 6: Bug contextualization and maintainer intent verification against public issues/PRs/docs.
 */
function buildContextualizeBugsGuidance(
  options: FindBugsOptions,
  toolName: string,
  tool: FindBugsTool,
  invariantSource: FindBugsInvariantSource,
  sessionId: string
): string {
  return [
    `### Instructions for Phase 6: Bug Contextualization & Maintainer Intent Verification [Engine: ${tool} | Source: ${invariantSource}]`,
    "",
    `For each confirmed bug or invariant failure discovered during testing:`,
    "",
    `1. **Scope & Access Assessment**:`,
    `   - Determine whether the target repository is a public open-source project with accessible issue trackers, PR discussions, and documentation.`,
    `   - **Public Repository**: Use GitHub/GitLab CLI, issue search APIs, or web retrieval tools.`,
    `   - **Private / Offline Repository**: Restrict search strictly to local repository files (\`docs/\`, architecture decision records / ADRs, \`CHANGELOG.md\`, \`README.md\`, docstrings, and \`git log --grep\`).`,
    `   - If remote queries fail (e.g. rate-limited, unauthorized), fall back gracefully to local files without failing the workflow.`,
    "",
    `2. **Multi-Faceted Search Strategy**:`,
    `   Execute targeted queries combining multiple discriminators to avoid superficial lexical matches:`,
    `   - *Query 1 (Exact Symbol + Concept)*: \`"<function_name>"\` AND (\`"<crash_exception>"\` OR \`"<invariant_concept>"\`)`,
    `   - *Query 2 (Edge Case Shape)*: \`"<function_name>"\` AND (\`"empty string"\` OR \`"null"\` OR \`"overflow"\` OR \`"negative"\`)`,
    `   - *Query 3 (Deprecation / Maintenance)*: \`"<module_or_file>"\` AND (\`"deprecated"\` OR \`"legacy"\` OR \`"wontfix"\` OR \`"by design"\`)`,
    "",
    `3. **Strict Evidentiary Standards (Anti-Rationalization Gate)**:`,
    `   - ⚠️ **CRITICAL ANTI-RATIONALIZATION RULE**: You must NOT classify a bug as "Intentional" or "WontFix" without direct, unambiguous maintainer evidence.`,
    `   - An issue closed as \`stale\`, \`inactive\`, or \`closed without explanation\` is **NOT** evidence of intentional behavior.`,
    `   - If evidence is ambiguous, or if discussions disagree, the bug **MUST** be classified as a novel bug or potential unintended defect.`,
    `   - You must extract:`,
    `     1. The exact URL or path of the issue/PR/commit/doc.`,
    `     2. The direct quote from a project maintainer explaining *why* the behavior is acceptable or out of scope.`,
    `     3. The date of the decision (flag any decision older than 2 years as *Historical - May Require Reconfirmation*).`,
    "",
    `4. **Taxonomy & Evidence Mapping**:`,
    `   Assign each finding to exactly one structured status:`,
    `   - **Novel / Unreported**: No matching prior reports found.`,
    `   - **Known Issue (Open)**: Active open issue/PR tracks this exact root cause (record Issue # and status).`,
    `   - **Previously Fixed (Regression)**: Closed as fixed in a prior release, indicating a regression (record PR/commit hash).`,
    `   - **Documented WontFix / Working as Intended**: Direct maintainer statement confirming the behavior is an intentional design choice or acceptable tradeoff (quote rationale and link).`,
    `   - **Deprecated / Unsupported API**: Official documentation or issue states the component is unmaintained or slated for removal (quote deprecation notice).`,
    "",
    `5. **Next Step**:`,
    `   - When contextualization is complete, call \`${toolName.toLowerCase()}_findBugs\` with:`,
    "   ```json",
    "   {",
    '     "phase": "complete",',
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "statePayload": {',
    `       "sessionId": "${sessionId}",`,
    '       "bugs": [',
    "         {",
    '           "entrypoint": "<functionName>",',
    '           "status": "<Novel / Unreported | Known Issue | Previously Fixed | Documented WontFix | Deprecated>",',
    '           "evidence": "<urlOrPath>",',
    '           "maintainerRationale": "<quoteOrSummary>"',
    "         }",
    "       ]",
    "     }",
    "   }",
    "   ```",
  ].join("\n");
} // fn: buildContextualizeBugsGuidance

/**
 * Builds guidance for Phase 6: Final reporting and interactive user disposition prompt.
 */
function buildCompleteGuidance(
  _options: FindBugsOptions,
  _toolName: string,
  session?: import("./FindBugsSessionManager").WorkflowSession
): string {
  const telemetrySummary = session
    ? sessionManager.finalizeSession(session)
    : "";

  return [
    `### Instructions for Phase 6: Reporting & Artifact Disposition`,
    "",
    `1. **Generate Structured Summary Report**:`,
    `   Present a clear summary of all tested entrypoints to the user:`,
    `   - Total entrypoints and invariants tested.`,
    `   - Branch and statement coverage achieved.`,
    `   - Discovered bugs: violated invariant / crash, minimal counterexample, input generator attribution (Random, Mutation, AI, User, etc.), reproducer test file path, and maintainer/issue context (e.g. Novel, Known Issue, WontFix/Working as Intended, or Deprecated).`,
    "",
    `2. **Interactive User Review & Artifact Disposition**:`,
    `   Ask the user (e.g. via askQuestions or clear options) how they would like to handle the results and generated files:`,
    `   - **Option 1: Discuss the bugs with the agent (Recommended)** — Review the findings in detail, examine whether counterexamples are code defects vs oracle discrepancies, inspect stack traces, and explore the root causes.`,
    `   - **Option 2: Investigate fixes for the discovered bugs** — Investigate and implement fixes for the discovered bugs that ensure both the project's existing test suite and the regression unit tests synthesized by NaNofuzz pass cleanly.`,
    `   - **Option 3: Keep bug-eliciting only** — Retain only bug-eliciting harnesses and synthesized counterexample tests; delete passing temporary harnesses.`,
    `   - **Option 4: Archive bug-eliciting to ZIP** — Package bug-eliciting harnesses and counterexample tests into a \`.zip\` archive and clean up temporary files.`,
    `   - **Option 5: Archive all to ZIP** — Package all generated harnesses (passing and failing) and tests into a \`.zip\` archive.`,
    `   - **Option 6: Keep all** — Retain all generated harness files and test suites in the working tree.`,
    `   - **Option 7: Clean up all temporary files** — Delete all temporary harnesses and files.`,
    "",
    `3. Perform the user's selected disposition action to complete the session.`,
    "",
    telemetrySummary,
  ].join("\n");
} // fn: buildCompleteGuidance

// -------------------------------------------------------------------------- //
// Type Definitions
// -------------------------------------------------------------------------- //

/**
 * Workflow phase for the Find Bugs multi-turn guidance engine
 */
export type FindBugsPhase =
  | "init"
  | "invariants_from_docs"
  | "invariants_from_tests"
  | "invariants_extracted"
  | "fuzz_smoke"
  | "fuzz_deep"
  | "fuzz_entrypoint"
  | "contextualize_bugs"
  | "complete";

/**
 * Experimental testing tool engine
 */
export type FindBugsTool = "nanofuzz" | "hypothesis" | "hypofuzz";

/**
 * Experimental source of specification invariants
 */
export type FindBugsInvariantSource = "tests" | "docs" | "all";

/**
 * Input arguments for nanofuzz_findBugs
 */
export type FindBugsOptions = {
  phase?: FindBugsPhase;
  model: string;
  vendor: string;
  targetPath?: string;
  repoUrl?: string;
  statePayload?: Record<string, unknown>;
};

/**
 * Result returned by findBugs
 */
export type FindBugsResult = {
  phase: FindBugsPhase;
  instructions: string;
  recommendedNextPhase?: FindBugsPhase;
  summaryText: string;
};

/**
 * Tests whether a fuzz/test function name matches a declared entrypoint name,
 * or its explicitly declared harness function name.
 *
 * @param runFn The function name executed during testing (e.g. "test_distance_norm", "fuzz_encode")
 * @param entrypoint The entrypoint record or name registered during Phase 1
 * @returns true if runFn matches the entrypoint
 */
export function functionMatchesEntrypoint(
  runFn: string,
  entrypoint: string | { name: string; harnessFunctionName?: string }
): boolean {
  const entryName =
    typeof entrypoint === "string" ? entrypoint : entrypoint.name;
  const harnessFn =
    typeof entrypoint === "object" && entrypoint !== null
      ? entrypoint.harnessFunctionName
      : undefined;

  if (runFn === entryName) return true;
  if (harnessFn && runFn === harnessFn) return true;

  // Normalized prefix/underscore matching: test_<fn> or fuzz_<fn>
  const cleanRun = runFn
    .toLowerCase()
    .replace(/^(test_|fuzz_)/, "")
    .replace(/^_+|_+$/g, "");
  const cleanEntry = entryName
    .toLowerCase()
    .replace(/^(test_|fuzz_)/, "")
    .replace(/^_+|_+$/g, "");

  return cleanRun.length > 0 && cleanRun === cleanEntry;
} // fn: functionMatchesEntrypoint

/**
 * Determines whether a target name or symbol from targetScope matches a registered entrypoint.
 *
 * @param target The target symbol or name specified in targetScope
 * @param entry The registered entrypoint record
 * @returns true if the entrypoint corresponds to the target
 */
export function targetMatchesEntrypoint(
  target: string,
  entry: {
    name: string;
    filePath?: string;
    harnessFilePath?: string;
    harnessFunctionName?: string;
  }
): boolean {
  if (functionMatchesEntrypoint(entry.name, target)) return true;
  if (
    entry.harnessFunctionName &&
    functionMatchesEntrypoint(entry.harnessFunctionName, target)
  ) {
    return true;
  }

  const strip = (s: string) =>
    s
      .toLowerCase()
      .replace(/^(test_|fuzz_)/, "")
      .replace(/[^a-z0-9]/g, "");

  const cleanTarget = strip(target);
  const cleanName = strip(entry.name);
  const cleanHarness = strip(entry.harnessFunctionName ?? "");

  if (cleanTarget.length > 0) {
    if (cleanName === cleanTarget || cleanHarness === cleanTarget) return true;
    if (cleanName.includes(cleanTarget) || cleanHarness.includes(cleanTarget)) {
      return true;
    }
    if (cleanTarget.includes(cleanName) && cleanName.length >= 4) {
      return true;
    }
  }

  // Generic file path matching
  if (entry.filePath && cleanTarget.length > 0) {
    const fileName = entry.filePath.split("/").pop() ?? "";
    const cleanFile = strip(fileName.replace(/\.[^.]+$/, ""));
    if (cleanFile === cleanTarget || cleanFile.includes(cleanTarget)) {
      return true;
    }
    if (cleanTarget.includes(cleanFile) && cleanFile.length >= 4) {
      return true;
    }
  }

  return false;
} // fn: targetMatchesEntrypoint
