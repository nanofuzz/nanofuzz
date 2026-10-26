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
      nextPhase = "complete";
      break;
    }
    case "complete": {
      instructions = buildCompleteGuidance(options, toolName);
      nextPhase = undefined;
      break;
    }
    default: {
      instructions = `Unknown phase '${String(phase)}'. Valid phases are: 'init', 'invariants_extracted', 'fuzz_entrypoint', 'complete'.`;
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
  _toolName: string
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
    `4. **Stage 2: Deep Fuzzing Run (60,000ms)**:`,
    `   Once Stage 1 succeeds without harness errors, run deep fuzzing with \`maxTests: 0\` (no test count limit, running for the full 60,000ms timeoutMs to discover all reachable defects rather than aborting prematurely):`,
    "   ```json",
    "   {",
    `     "filePath": "${harnessPath}",`,
    `     "functionName": "${fnName}",`,
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "coverageScope": "project directimports",',
    '     "fnTimeout": 500,',
    '     "maxTests": 0,',
    '     "timeoutMs": 60000,',
    '     "inputs": [...]',
    "   }",
    "   ```",
    "",
    `5. **Strict Counterexample Triage Protocol**:`,
    `   - ⚠️ **Anti-Suppression Rule**: NEVER weaken a validator or add \`assume()\` just to make a failure pass.`,
    `   - Only modify the harness/transformer if the input demonstrably violates the public documented API contract.`,
    `   - If the input is legal and the invariant fails (or target crashes), it is a **confirmed bug**!`,
    `   - Synthesize a minimal reproducer test with \`exportSuite: true\` / \`exportFilePath: "..."\` and record which generator elicited the bug.`,
    "",
    `6. **Branch Coverage Improvement Loop (Max 5 Retries)**:`,
    `   - If all tests passed but uncovered lines/branches remain in the target entrypoint:`,
    `     1. Inspect the uncovered lines in the target file.`,
    `     2. Widen \`<fn>Generator\`, adjust \`<fn>Transformer\`, or add targeted seed \`inputs\`.`,
    `     3. Re-run Stage 2 (up to 5 retries total).`,
    "",
    `7. **Advance**:`,
    `   - Repeat for all remaining entrypoint harnesses.`,
    `   - When all entrypoints are completed, call \`nanofuzz_findBugs\` with \`phase: "complete"\`.`,
  ].join("\n");
} // fn: buildFuzzEntrypointGuidance

/**
 * Builds guidance for Phase 4: Final reporting and interactive user disposition prompt.
 */
function buildCompleteGuidance(
  _options: FindBugsOptions,
  _toolName: string
): string {
  return [
    `### Instructions for Phase 4: Reporting & Artifact Disposition`,
    "",
    `1. **Generate Structured Summary Report**:`,
    `   Present a clear summary of all tested entrypoints to the user:`,
    `   - Total entrypoints and invariants tested.`,
    `   - Branch and statement coverage achieved.`,
    `   - Discovered bugs: violated invariant / crash, minimal counterexample, input generator attribution (Random, Mutation, AI, User, etc.), and reproducer test file path.`,
    "",
    `2. **Interactive User Review & Artifact Disposition**:`,
    `   Ask the user (e.g. via askQuestions or clear options) how they would like to handle the results and generated files:`,
    `   - **Option 1: Discuss the bugs with the agent** — Review the findings in detail, examine whether counterexamples are code defects vs oracle discrepancies, inspect stack traces, and explore the root causes.`,
    `   - **Option 2: Investigate fixes for the discovered bugs** — Investigate and implement fixes for the discovered bugs that ensure both the project's existing test suite and the regression unit tests synthesized by NaNofuzz pass cleanly.`,
    `   - **Option 3: Keep bug-eliciting only (Recommended)** — Retain only bug-eliciting harnesses and synthesized counterexample tests; delete passing temporary harnesses.`,
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
