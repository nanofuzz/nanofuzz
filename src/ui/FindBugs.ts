import { resolveFilePath, getToolName } from "./Agent";
import * as Config from "../Config";
import { determineWorkerCount } from "../fuzzer/Util";
import { sessionManager } from "./FindBugsSessionManager";

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

  const tool: FindBugsTool = Config.get<FindBugsTool>(
    "nanofuzz.experimental.findBugs.tool",
    "nanofuzz"
  );

  const invariantSource: FindBugsInvariantSource =
    Config.get<FindBugsInvariantSource>(
      "nanofuzz.experimental.findBugs.invariantSource",
      "tests"
    );

  const workerCount = determineWorkerCount(
    Config.get("nanofuzz.fuzzer.workers", "auto"),
    false
  );

  const payload = options.statePayload ?? {};
  const passedSessionId =
    typeof payload.sessionId === "string" ? payload.sessionId : undefined;
  const session = sessionManager.getOrCreateSession(
    passedSessionId,
    tool,
    invariantSource,
    workerCount,
    phase
  );

  let instructions: string;
  let nextPhase: FindBugsPhase | undefined;

  switch (phase) {
    case "init": {
      instructions = buildInitGuidance(
        options,
        toolName,
        tool,
        invariantSource,
        session.sessionId
      );
      nextPhase = "invariants_extracted";
      break;
    }
    case "invariants_extracted": {
      instructions = buildInvariantsGuidance(
        options,
        toolName,
        tool,
        invariantSource,
        session.sessionId
      );
      nextPhase = "fuzz_entrypoint";
      break;
    }
    case "fuzz_entrypoint": {
      const fnName =
        typeof payload.functionName === "string" ? payload.functionName : "";
      const hasSmokeRun = session.fuzzRuns.some(
        (r) => r.functionName === fnName
      );
      const isDeepStage =
        payload.stage === "deep" || (payload.stage !== "smoke" && hasSmokeRun);

      if (tool === "nanofuzz" && !isDeepStage) {
        instructions = buildFuzzSmokeGuidance(
          options,
          toolName,
          tool,
          invariantSource,
          session.sessionId
        );
        nextPhase = "fuzz_entrypoint";
      } else {
        instructions = buildFuzzEntrypointGuidance(
          options,
          toolName,
          tool,
          invariantSource,
          workerCount,
          session.sessionId
        );
        nextPhase = "contextualize_bugs";
      }
      break;
    }
    case "contextualize_bugs": {
      // Gate A: Reject premature phase advance if fuzzing was skipped entirely
      // or if only smoke runs occurred without executing Stage 2 deep fuzzing.
      const hasCompletedFuzzing =
        session.fuzzRuns.length > 0 &&
        sessionManager.hasCompletedDeepRun(session.sessionId);

      if (tool === "nanofuzz" && !hasCompletedFuzzing) {
        const failureReason =
          session.fuzzRuns.length === 0
            ? "No fuzzing runs were recorded for this session."
            : `Only ${session.fuzzRuns.length} smoke run(s) recorded (${session.fuzzRuns.reduce((sum, r) => sum + r.totalTests, 0)} total tests). Stage 2 Deep Fuzzing (300,000ms / 5 minutes per attempt, maxTests: 0) was never executed.`;

        instructions = [
          `### ⚠️ Execution Gate Blocked: Deep Fuzzing Required`,
          "",
          `You cannot advance to \`phase: "contextualize_bugs"\` yet: ${failureReason}`,
          "",
          `You MUST execute **Stage 2: Deep Fuzzing** with \`timeoutMs: 300000\` and \`maxTests: 0\` for your entrypoint(s). Finding an early bug or passing a quick smoke test does NOT complete testing for an entrypoint.`,
          "",
          buildFuzzEntrypointGuidance(
            options,
            toolName,
            tool,
            invariantSource,
            workerCount,
            session.sessionId
          ),
        ].join("\n");
        nextPhase = "contextualize_bugs";
        break;
      }

      instructions = buildContextualizeBugsGuidance(
        options,
        toolName,
        tool,
        invariantSource,
        session.sessionId
      );
      nextPhase = "complete";
      break;
    }
    case "complete": {
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
  sessionManager.recordTransition(session, nextPhase ?? "complete");

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
        ].join("\n")
      : invariantSource === "all"
        ? [
            `2. **Inspect Documentation and Existing Test Suite**:`,
            `   - Read API documentation (\`docs/\`, \`README.md\`, docstrings) as your primary specification oracle for intended contracts.`,
            `   - Locate existing test files (e.g. \`test/\`, \`tests/\`, \`__tests__/\`) to extract concrete seeds, known valid input domains, and regression assertions.`,
            "",
            `3. **Strict Information Barrier (Black-Box Oracle Rule)**:`,
            `   - ⚠️ **DO NOT READ THE INTERNAL IMPLEMENTATION BODIES** of target functions during this phase.`,
            `   - Extract invariants and seed examples from documentation and test suites without inspecting internal helper code.`,
          ].join("\n")
        : [
            `2. **Find Existing Test Suite & Documentation**:`,
            `   - Locate the project's test files (e.g. \`test/\`, \`tests/\`, \`__tests__/\`, \`*.test.*\`, \`*_test.*\`).`,
            `   - Read test cases, docstrings, README files, and exported function/type signatures.`,
            "",
            `3. **Strict Information Barrier (Black-Box Oracle Rule)**:`,
            `   - ⚠️ **DO NOT READ THE INTERNAL IMPLEMENTATION BODIES** of target functions during this phase.`,
            `   - Extract invariants *strictly* from tests, documentation, and public type contracts. Reading function bodies now risks mirroring bugs into your test validators (tautological oracles).`,
          ].join("\n");

  const propertyTaxonomy =
    invariantSource === "docs"
      ? [
          `   - Extract all documented behaviors, invariants, and boundary conditions for each prioritized entrypoint:`,
          `     - *Stated Semantic Contracts*: exact promises on return values, ranges, and state transitions.`,
          `     - *Model-Based Oracles*: compare results against simple reference implementations (like comparing to \`sorted()\`, a dictionary lookup, or an oracle loop).`,
          `     - *Round-Trip & Inverses*: inverse transformations promised in docs (like decode(encode(x)) == x).`,
          `     - *Documented Boundaries & Thresholds*: min/max sizes, zeros, empty collections, documented numerical limits.`,
          `     - *Error Contracts*: documented exceptions or errors when invalid arguments are provided.`,
          `   - ⚠️ **Do not spend budget hunting for a specific known bug**. Cover the specification broadly for each prioritized entrypoint; ${tool === "nanofuzz" ? "NaNofuzz" : tool === "hypofuzz" ? "Hypofuzz" : "Hypothesis"} will find deviations.`,
        ].join("\n")
      : invariantSource === "all"
        ? [
            `   - Formulate invariants by combining documented specifications with empirical test cases, such as:`,
            `     - *Documented Semantic Contracts & Model Oracles*: verify return values, state transitions, and equivalence with reference models.`,
            `     - *Round-Trip & Inverses*: \`f_inv(f(x)) == x\` (encode/decode, serialize/deserialize, compress/decompress).`,
            `     - *Metamorphic Relations & Invariant Consistency*: structural integrity laws and relative output relationships.`,
            `     - *Boundary & Error Contracts*: boundary limits from docs plus error conditions confirmed by existing unit tests.`,
            `   - ⚠️ Cover both the written documentation and established test surfaces.`,
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

  const todoSourceLabel =
    invariantSource === "docs"
      ? "from docs"
      : invariantSource === "all"
        ? "from docs & unit tests"
        : "from unit tests";

  return [
    `### Instructions for Phase 1: Discovery & Invariant Extraction [Engine: ${tool} | Source: ${invariantSource}]`,
    "",
    `0. **Workflow Tracking (To-Do List Initialization)**:`,
    `   - If your environment provides a structured to-do list tool (e.g. \`manage_todo_list\`), initialize a to-do list with the following items, mark item 1 as \`in-progress\` before beginning, and update the list as you advance:`,
    `     1. Codebase Discovery & Entrypoint Ranking`,
    `     2. Invariant & Spec Extraction (${todoSourceLabel})`,
    `     3. Harness / Test Suite Synthesis (${tool})`,
    `     4. Smoke Test & Oracle Validation`,
    `     5. Deep Fuzzing & Exploration Loop (${tool})`,
    `     6. Bug Contextualization & Disposition`,
    "",
    repoNotice,
    invariantSourceSection,
    "",
    `4. **Identify Program Entrypoints & Invariants**:`,
    `   - Call \`nanofuzz_listTargets\` on your source files to inspect functions and their computed \`priority\` scores (0-100).`,
    `   - **Sort functions by \`priority\` descending** and select the top-ranked public entrypoints first. Do NOT target low-priority internal helpers.`,
    `   - Identify coupled entrypoint groups (e.g. encode/decode, serialize/deserialize, stateful sequences).`,
    propertyTaxonomy,
    "",
    `5. **Next Step**:`,
    `   - When you have extracted the list of entrypoints and invariants, invoke \`${toolName.toLowerCase()}_findBugs\` with:`,
    "   ```json",
    "   {",
    '     "phase": "invariants_extracted",',
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "statePayload": {',
    `       "sessionId": "${sessionId}",`,
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
  toolName: string,
  tool: FindBugsTool,
  invariantSource: FindBugsInvariantSource,
  sessionId: string
): string {
  if (tool === "hypothesis" || tool === "hypofuzz") {
    return [
      `### Instructions for Phase 2: Hypothesis Test Suite Synthesis [Engine: ${tool} | Source: ${invariantSource}]`,
      "",
      `1. **Create Test File**:`,
      `   - Create a dedicated test file in the project's test directory (e.g. \`tests/test_pbt_<entrypoint>.py\`).`,
      `   - Import Hypothesis: \`from hypothesis import given, settings, HealthCheck, strategies as st\`.`,
      "",
      `2. **Design Inclusive Parameter Strategies**:`,
      `   - Construct strategies that faithfully match each parameter's domain—for example:`,
      `     - Use composite strategies (\`@st.composite\`) to build multi-attribute objects, records, or packet structures.`,
      `     - Use strategy transformations (like \`.map()\`, \`.filter()\`, or \`.flatmap()\`) to construct valid domain instances.`,
      `     - Use specialized strategy builders (like \`st.dates()\`, \`st.binary()\`, \`st.decimals()\`, or \`st.recursive()\` for nested structures).`,
      `     - Avoid unconstrained primitive defaults where structured inputs are required.`,
      "",
      `3. **Implement Focused Property Tests**:`,
      `   - Write focused test functions decorated with \`@given(...)\` and \`@settings(suppress_health_check=list(HealthCheck))\`.`,
      `   - Assert that the extracted invariants hold across all generated cases.`,
      "",
      `4. **Next Step**:`,
      `   - Call \`${toolName.toLowerCase()}_findBugs\` for your first entrypoint:`,
      "   ```json",
      "   {",
      '     "phase": "fuzz_entrypoint",',
      `     "model": "${options.model}",`,
      `     "vendor": "${options.vendor}",`,
      '     "statePayload": {',
      `       "sessionId": "${sessionId}",`,
      '       "harnessFilePath": "<testFilePath>",',
      '       "functionName": "<entrypointName>"',
      "     }",
      "   }",
      "   ```",
    ].join("\n");
  }

  return [
    `### Instructions for Phase 2: Harness & Validator Synthesis [Engine: nanofuzz | Source: ${invariantSource}]`,
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
    `6. **Extract Concrete Seed Inputs with Ground-Truth Expected Outcomes**:`,
    `   - Collect example inputs from existing project tests and format them as an array of parameter objects or test specifications.`,
    `   - Include expected outcomes from the unit tests whenever available:`,
    `     - For normal return values: \`{ "input": { ... }, "expectedOutput": <expectedVal> }\``,
    `     - For expected exceptions/errors: \`{ "input": { ... }, "expectedException": true }\``,
    `     - For expected timeouts: \`{ "input": { ... }, "expectedTimeout": true }\``,
    `   - Injected tests run through both the Example Oracle and Property Oracle to validate both the implementation and your property invariants.`,
    "",
    `7. **Next Step**:`,
    `   - Call \`${toolName.toLowerCase()}_findBugs\` for your first entrypoint to begin Stage 1 smoke testing:`,
    "   ```json",
    "   {",
    '     "phase": "fuzz_entrypoint",',
    `     "model": "${options.model}",`,
    `     "vendor": "${options.vendor}",`,
    '     "statePayload": {',
    `       "sessionId": "${sessionId}",`,
    '       "stage": "smoke",',
    '       "harnessFilePath": "<path>",',
    '       "functionName": "fuzz_<entrypoint>",',
    '       "inputs": [...]',
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
    `### Instructions for Phase 3: Fuzzing Execution — Stage 1: Fast Smoke Test [Engine: ${tool} | Source: ${invariantSource}]`,
    "",
    `Execute Stage 1 Smoke Testing for \`${fnName}\` in \`${harnessPath}\`:`,
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
    '     "phase": "fuzz_entrypoint",',
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
 * Builds guidance for Phase 3: Fuzzing execution, triage protocol, and 5-retry coverage loop.
 */
function buildFuzzEntrypointGuidance(
  options: FindBugsOptions,
  toolName: string,
  tool: FindBugsTool,
  invariantSource: FindBugsInvariantSource,
  workerCount: number,
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

  if (tool === "hypothesis") {
    return [
      `### Instructions for Phase 3: Hypothesis Test Execution & Triage [Engine: hypothesis | Source: ${invariantSource}]`,
      "",
      `Execute Hypothesis tests for \`${fnName}\` in \`${harnessPath}\`:`,
      "",
      `1. **Run Tests with Pytest**:`,
      `   Execute with ${workerCount} concurrent workers:`,
      `   \`\`\`bash`,
      `   pytest -n ${workerCount} ${harnessPath} --tb=short -v`,
      `   \`\`\``,
      "",
      `2. **Triage & Iteration**:`,
      `   - If tests fail, inspect the falsifying counterexample reported by Hypothesis.`,
      `   - If the input is valid according to the specification, record it as a **confirmed bug**.`,
      `   - If tests fail due to an invalid input strategy, adjust the strategy domain without weakening the assertion.`,
      "",
      `3. **Advance**:`,
      `   - When completed, invoke \`${toolName.toLowerCase()}_findBugs\` with:`,
      "   ```json",
      "   {",
      '     "phase": "contextualize_bugs",',
      `     "model": "${options.model}",`,
      `     "vendor": "${options.vendor}",`,
      '     "statePayload": {',
      `       "sessionId": "${sessionId}",`,
      '       "bugs": [...]',
      "     }",
      "   }",
      "   ```",
    ].join("\n");
  }

  if (tool === "hypofuzz") {
    return [
      `### Instructions for Phase 3: Hypofuzz Adaptive Fuzzing & Triage [Engine: hypofuzz | Source: ${invariantSource}]`,
      "",
      `Execute Hypofuzz coverage-guided fuzzing for \`${fnName}\` in \`${harnessPath}\`:`,
      "",
      `1. **Run Hypofuzz**:`,
      `   Execute with ${workerCount} concurrent workers:`,
      `   \`\`\`bash`,
      `   hypofuzz -n ${workerCount} -- ${harnessPath} --max-total-time=300s`,
      `   \`\`\``,
      "",
      `2. **Triage & Iteration**:`,
      `   - Inspect discovered counterexamples and shrinking traces.`,
      `   - Record confirmed bugs that violate the specification.`,
      "",
      `3. **Advance**:`,
      `   - When completed, invoke \`${toolName.toLowerCase()}_findBugs\` with:`,
      "   ```json",
      "   {",
      '     "phase": "contextualize_bugs",',
      `     "model": "${options.model}",`,
      `     "vendor": "${options.vendor}",`,
      '     "statePayload": {',
      `       "sessionId": "${sessionId}",`,
      '       "bugs": [...]',
      "     }",
      "   }",
      "   ```",
    ].join("\n");
  }

  return [
    `### Instructions for Phase 3: Fuzzing Execution — Stage 2: Deep Fuzzing & Coverage Loop [Engine: nanofuzz | Source: ${invariantSource}]`,
    "",
    `Execute Stage 2 Deep Fuzzing for \`${fnName}\` in \`${harnessPath}\`:`,
    "",
    `1. **Stage 2: Deep Fuzzing Run (Mandatory - 300,000ms / 5 minutes per attempt)**:`,
    `   Call \`nanofuzz_fuzzFunction\` with \`maxTests: 0\` (no test count limit, running for the full 300,000ms / 5 minutes timeoutMs per attempt to discover all reachable defects rather than aborting prematurely):`,
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
    `     2. **Widen Inputs (Strict Validator Immobility Rule)**: Inspect the remaining uncovered lines in the target file, widen \`<fn>Generator\`, adjust \`<fn>Transformer\`, or add targeted seed \`inputs\`. ⚠️ **NEVER modify \`<fn>Validator\` during coverage expansion**: the validator embodies the specification and black-box invariants; altering or relaxing it to match uncovered internal code creates tautological oracles that mask genuine defects.`,
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
 * Builds guidance for Phase 4: Bug contextualization and maintainer intent verification against public issues/PRs/docs.
 */
function buildContextualizeBugsGuidance(
  options: FindBugsOptions,
  toolName: string,
  tool: FindBugsTool,
  invariantSource: FindBugsInvariantSource,
  sessionId: string
): string {
  return [
    `### Instructions for Phase 4: Bug Contextualization & Maintainer Intent Verification [Engine: ${tool} | Source: ${invariantSource}]`,
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
 * Builds guidance for Phase 5: Final reporting and interactive user disposition prompt.
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
  | "invariants_extracted"
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
