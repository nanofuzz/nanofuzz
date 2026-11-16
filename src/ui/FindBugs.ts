import { resolveFilePath, getToolName } from "./Agent";

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

  let instructions: string;
  let nextPhase: FindBugsPhase | undefined;

  switch (phase) {
    case "init": {
      instructions = buildInitGuidance(options, toolName);
      nextPhase = "invariants_extracted";
      break;
    }
    case "invariants_extracted": {
      instructions = buildInvariantsGuidance(options, toolName);
      nextPhase = "fuzz_entrypoint";
      break;
    }
    case "fuzz_entrypoint": {
      instructions = buildFuzzEntrypointGuidance(options, toolName);
      nextPhase = "contextualize_bugs";
      break;
    }
    case "contextualize_bugs": {
      instructions = buildContextualizeBugsGuidance(options, toolName);
      nextPhase = "complete";
      break;
    }
    case "complete": {
      instructions = buildCompleteGuidance(options, toolName);
      nextPhase = undefined;
      break;
    }
    default: {
      instructions = `Unknown phase '${String(phase)}'. Valid phases are: 'init', 'invariants_extracted', 'fuzz_entrypoint', 'contextualize_bugs', 'complete'.`;
      nextPhase = "init";
      break;
    }
  }

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
function buildInitGuidance(options: FindBugsOptions, toolName: string): string {
  const targetDir = options.targetPath
    ? resolveFilePath(options.targetPath)
    : process.cwd();

  const repoNotice = options.repoUrl
    ? `1. **Clone Repository**: Checkout \`${options.repoUrl}\` into a temporary directory if not already checked out.\n`
    : `1. **Verify Target Path**: Working directory is \`${targetDir}\`.\n`;

  return [
    `### Instructions for Phase 1: Discovery & Black-Box Invariant Extraction`,
    "",
    repoNotice,
    `2. **Find Existing Test Suite & Documentation**:`,
    `   - Locate the project's test files (e.g. \`test/\`, \`tests/\`, \`__tests__/\`, \`*.test.*\`, \`*_test.*\`).`,
    `   - Read test cases, docstrings, README files, and exported function/type signatures.`,
    "",
    `3. **Strict Information Barrier (Black-Box Oracle Rule)**:`,
    `   - ⚠️ **DO NOT READ THE INTERNAL IMPLEMENTATION BODIES** of target functions during this phase.`,
    `   - Extract invariants *strictly* from tests, documentation, and public type contracts. Reading function bodies now risks mirroring bugs into your test validators (tautological oracles).`,
    "",
    `4. **Identify Program Entrypoints & Invariants**:`,
    `   - Identify public entrypoints and coupled entrypoint groups (e.g. encode/decode, serialize/deserialize, stateful sequences).`,
    `   - Formulate generalized invariants: round-trip properties, idempotence, conservation laws, monotonicity, and contract error conditions.`,
    "",
    `5. **Next Step**:`,
    `   - When you have extracted the list of entrypoints and invariants, invoke \`${toolName.toLowerCase()}_findBugs\` with:`,
    "   ```json",
    "   {",
    '     "phase": "invariants_extracted",',
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "statePayload": {',
    '       "entrypoints": [',
    '         { "name": "<functionOrGroupName>", "filePath": "<relPath>", "invariants": ["<desc1>", "<desc2>"] }',
    "       ]",
    "     }",
    "   }",
    "   ```",
  ].join("\n");
} // fn: buildInitGuidance

/**
 * Builds guidance for Phase 2: Harness, validator, transformer, and generator synthesis.
 */
function buildInvariantsGuidance(
  options: FindBugsOptions,
  toolName: string
): string {
  return [
    `### Instructions for Phase 2: Harness & Validator Synthesis`,
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
    `   - Place the validator in the same harness file. Assert that the black-box invariants hold.`,
    "",
    `4. **Implement Constructive Transformers (\`<fn>Transformer\`)**:`,
    `   - **Construct/Repair rather than filter**: Normalize bounds, compute checksums, and repair relations.`,
    `   - Avoid heavy \`assume()\` filtering to prevent starving the fuzzer.`,
    `   - Note: Dual-Mode fuzzing is supported by toggling \`useTransformer: true\` (Semantic Mode) vs \`useTransformer: false\` (Adversarial/Robustness Mode).`,
    "",
    `5. **Implement Custom Generators (\`<fn>Generator\`)**:`,
    `   - If inputs are structured (e.g. ASTs, grammar, XML, JSON), implement the PRNG generator template.`,
    "",
    `6. **Extract Concrete Seed Inputs**:`,
    `   - Collect example inputs from existing project tests and format them as an array of parameter objects.`,
    "",
    `7. **Next Step**:`,
    `   - Call \`${toolName.toLowerCase()}_findBugs\` for your first entrypoint:`,
    "   ```json",
    "   {",
    '     "phase": "fuzz_entrypoint",',
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "statePayload": {',
    '       "harnessFilePath": "<path>",',
    '       "functionName": "fuzz_<entrypoint>",',
    '       "inputs": [...]',
    "     }",
    "   }",
    "   ```",
  ].join("\n");
} // fn: buildInvariantsGuidance

/**
 * Builds guidance for Phase 3: Fuzzing execution, triage protocol, and 5-retry coverage loop.
 */
function buildFuzzEntrypointGuidance(
  options: FindBugsOptions,
  toolName: string
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
    `### Instructions for Phase 3: Fuzzing Execution, Triage & Coverage Gating`,
    "",
    `Execute the following steps for \`${fnName}\` in \`${harnessPath}\`:`,
    "",
    `1. **Timeout Configuration (\`fnTimeout\`)**:`,
    `   - The default per-test execution timeout is **500ms**.`,
    `   - If the target function or transformer normally requires significant execution time, estimate the expected single-run execution time. If twice that expected runtime exceeds 500ms, set \`fnTimeout\` to **2x expected runtime** (e.g. \`1000\` or \`2000\`) in both Stage 1 and Stage 2 to prevent spurious timeouts while still catching true infinite loops.`,
    "",
    `2. **Stage 1: Fast Smoke Run (100 tests, 3000ms)**:`,
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
    "",
    `3. **Check for Harness/Validator Errors**:`,
    `   - If \`harnessErrors\` is non-empty or \`erroredTests > 0\`, fix the bug in \`<fn>Validator\`, \`<fn>Transformer\`, or \`<fn>Generator\` and re-run Stage 1.`,
    `   - If \`skippedTests\` rejection rate is high (>80%), rewrite \`<fn>Transformer\` to construct/clamp valid inputs instead of filtering.`,
    "",
    `4. **Stage 2: Deep Fuzzing Run (300,000ms / 5 minutes per attempt)**:`,
    `   Once Stage 1 succeeds without harness errors, run deep fuzzing with \`maxTests: 0\` (no test count limit, running for the full 300,000ms (5 minutes) timeoutMs per attempt to discover all reachable defects rather than aborting prematurely):`,
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
    '     "inputs": [...]',
    "   }",
    "   ```",
    "",
    `5. **Strict Counterexample Triage & Defect Cataloging Protocol**:`,
    `   - ⚠️ **Anti-Suppression Rule**: NEVER weaken a validator or add \`assume()\` just to make a failure pass.`,
    `   - Only modify the harness/transformer if the input demonstrably violates the public documented API contract.`,
    `   - If the input is legal and the invariant fails (or target crashes), it is a **confirmed bug**!`,
    `   - Synthesize a minimal reproducer test with \`exportSuite: true\` / \`exportFilePath: "..."\` and record which generator elicited the bug.`,
    `   - ⚠️ **Multi-Defect Rule (Do NOT Stop at the First Bug)**: Finding one counterexample does NOT mean fuzzing for this entrypoint is finished. Early bugs (e.g. shallow null checks, trivial input validation misses) frequently shadow deeper, more critical bugs downstream. Catalog this defect and proceed to the coverage and deeper defect exploration loop.`,
    "",
    `6. **Branch Coverage & Deeper Defect Exploration Loop (Max 5 Retries)**:`,
    `   - Inspect target file coverage. Whether tests passed or bugs were discovered, as long as uncovered lines/branches remain in the target entrypoint:`,
    `     1. **Defect Shadowing Mitigation**: If a discovered bug was an early crash or premature exit that prevented reaching downstream code, isolate that specific trigger in \`<fn>Transformer\` (or a secondary deep harness) so the fuzzer can penetrate deeper into the remaining branches. Keep the original reproducer test intact and cataloged—never discard or suppress it.`,
    `     2. **Widen Inputs**: Inspect the remaining uncovered lines in the target file, widen \`<fn>Generator\`, adjust \`<fn>Transformer\`, or add targeted seed \`inputs\`.`,
    `     3. **Re-run Stage 2**: Continue fuzzing to uncover deeper secondary defects (up to 5 retries total). Record a separate reproducer test and generator attribution for each distinct defect found.`,
    `   - **Stopping Criteria for this Entrypoint**: Stop retrying and move on ONLY when:`,
    `     - All reachable branches in the target entrypoint are covered, OR`,
    `     - The budget of 5 retries has been exhausted.`,
    `     - ⚠️ Finding a bug is NEVER a stopping condition on its own!`,
    "",
    `7. **Advance**:`,
    `   - Repeat for all remaining entrypoint harnesses.`,
    `   - When all entrypoints are completed:`,
    `     - If any bugs/failing invariants were discovered, call \`${toolName.toLowerCase()}_findBugs\` with \`phase: "contextualize_bugs"\`.`,
    `     - If no bugs were found across all entrypoints, call \`${toolName.toLowerCase()}_findBugs\` with \`phase: "complete"\`.`,
  ].join("\n");
} // fn: buildFuzzEntrypointGuidance

/**
 * Builds guidance for Phase 4: Bug contextualization and maintainer intent verification against public issues/PRs/docs.
 */
function buildContextualizeBugsGuidance(
  options: FindBugsOptions,
  toolName: string
): string {
  return [
    `### Instructions for Phase 4: Bug Contextualization & Maintainer Intent Verification`,
    "",
    `For each confirmed bug or invariant failure discovered during fuzzing:`,
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
 * Builds guidance for Phase 5: Final reporting and interactive user disposition prompt.
 */
function buildCompleteGuidance(
  _options: FindBugsOptions,
  _toolName: string
): string {
  return [
    `### Instructions for Phase 5: Reporting & Artifact Disposition`,
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
  | "invariants_extracted"
  | "fuzz_entrypoint"
  | "contextualize_bugs"
  | "complete";

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
