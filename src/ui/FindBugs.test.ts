import { findBugs } from "./FindBugs";
import * as Config from "../Config";
import { sessionManager } from "./FindBugsSessionManager";

describe("FindBugs", () => {
  const model = "gemini-2.0-flash";
  const vendor = "google";

  afterEach(() => {
    Config.clearOverrides();
    sessionManager.clear();
  });

  it("handles phase 'init' with black-box rule and model/vendor", async () => {
    const result = await findBugs({
      phase: "init",
      model,
      vendor,
    });

    expect(result.phase).toBe("init");
    expect(result.recommendedNextPhase).toBe("invariants_extracted");
    expect(result.summaryText).toContain("Find Bugs: Phase `init`");
    expect(result.instructions).toContain(
      "DO NOT READ THE INTERNAL IMPLEMENTATION BODIES"
    );
    expect(result.instructions).toContain(`"model": "${model}"`);
    expect(result.instructions).toContain(`"vendor": "${vendor}"`);
  });

  it("defaults to phase 'init' when no phase is specified", async () => {
    const result = await findBugs({
      model,
      vendor,
    });

    expect(result.phase).toBe("init");
    expect(result.recommendedNextPhase).toBe("invariants_extracted");
  });

  it("handles phase 'invariants_extracted' with harness placement rules", async () => {
    const result = await findBugs({
      phase: "invariants_extracted",
      model,
      vendor,
      statePayload: {
        entrypoints: [
          { name: "encode", filePath: "src/codec.ts", invariants: ["inv1"] },
          { name: "decode", filePath: "src/codec.ts", invariants: ["inv2"] },
        ],
      },
    });

    expect(result.phase).toBe("invariants_extracted");
    expect(result.recommendedNextPhase).toBe("fuzz_smoke");
    expect(result.instructions).toContain(
      "inside the project root/source tree"
    );
    expect(result.instructions).toContain(
      "Do NOT place harness files in an external `/tmp`"
    );
    expect(result.instructions).toContain("nanofuzz_listTargets");
    expect(result.instructions).toContain("validatorTemplate");
    expect(result.instructions).toContain("transformerTemplate");
    expect(result.instructions).toContain("generatorTemplate");
    expect(result.instructions).toContain(
      "No Hardcoded Lookup Tables or Initial States"
    );
  });

  it("handles phase 'fuzz_entrypoint' with 5-retry coverage loop and anti-suppression rule", async () => {
    // Register entrypoints in session first
    await findBugs({
      phase: "invariants_extracted",
      model,
      vendor,
      statePayload: {
        sessionId: "deep-loop-session",
        entrypoints: [
          {
            name: "fuzz_encode",
            filePath: "src/codec.ts",
            invariants: ["inv1"],
          },
        ],
      },
    });

    // Record a smoke run and a 100% branch coverage deep run so stopping criteria is met
    sessionManager.recordFuzzRun(
      {
        functionName: "fuzz_encode",
        filePath: "nanofuzz_harness_encode.ts",
        timestamp: Date.now(),
        totalTests: 100,
        passedTests: 100,
        failedTests: 0,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 3000,
      },
      "deep-loop-session"
    );
    sessionManager.recordFuzzRun(
      {
        functionName: "fuzz_encode",
        filePath: "nanofuzz_harness_encode.ts",
        timestamp: Date.now(),
        totalTests: 10000,
        passedTests: 10000,
        failedTests: 0,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 300000,
        suiteTimeout: 300000,
        maxTests: 0,
        branchCoveragePct: 100,
      },
      "deep-loop-session"
    );

    const result = await findBugs({
      phase: "fuzz_entrypoint",
      model,
      vendor,
      statePayload: {
        sessionId: "deep-loop-session",
        stage: "deep",
        functionName: "fuzz_encode",
        harnessFilePath: "nanofuzz_harness_encode.ts",
      },
    });

    expect(result.phase).toBe("fuzz_entrypoint");
    expect(result.recommendedNextPhase).toBe("contextualize_bugs");
    expect(result.instructions).toContain("nanofuzz_harness_encode.ts");
    expect(result.instructions).toContain("fuzz_encode");
    expect(result.instructions).toContain(
      '"coverageScope": "project directimports"'
    );
    expect(result.instructions).toContain("Anti-Suppression Rule");
    expect(result.instructions).toContain("Multi-Defect Rule");
    expect(result.instructions).toContain("Defect Shadowing Mitigation");
    expect(result.instructions).toContain("Validator Immobility Rule");
    expect(result.instructions).toContain("Max 5 Retries");
    expect(result.instructions).toContain("contextualize_bugs");
  });

  it("handles phase 'fuzz_entrypoint' stage 'smoke' with fast smoke test", async () => {
    await findBugs({
      phase: "invariants_extracted",
      model,
      vendor,
      statePayload: {
        sessionId: "smoke-stage-session",
        entrypoints: [
          {
            name: "fuzz_encode",
            filePath: "src/codec.ts",
            invariants: ["inv1"],
          },
        ],
      },
    });

    const result = await findBugs({
      phase: "fuzz_entrypoint",
      model,
      vendor,
      statePayload: {
        sessionId: "smoke-stage-session",
        stage: "smoke",
        harnessFilePath: "nanofuzz_harness_encode.ts",
        functionName: "fuzz_encode",
      },
    });

    expect(result.phase).toBe("fuzz_entrypoint");
    expect(result.recommendedNextPhase).toBe("fuzz_deep");
    expect(result.instructions).toContain("Stage 1: Fast Smoke Test");
    expect(result.instructions).toContain('"timeoutMs": 3000');
    expect(result.instructions).toContain('"stage": "deep"');
  });

  it("handles phase 'contextualize_bugs' with maintainer intent verification and anti-rationalization rule", async () => {
    // Session needs at least 2 entrypoints with smoke runs and a completed deep run
    const sessionId = "deep-run-valid-session";
    sessionManager.getOrCreateSession(
      sessionId,
      "nanofuzz",
      "tests",
      4,
      "fuzz_entrypoint"
    );
    // Record smoke runs for 2 distinct entrypoints
    sessionManager.recordFuzzRun(
      {
        functionName: "fuzz_encode",
        filePath: "src/codec.ts",
        timestamp: Date.now(),
        totalTests: 100,
        passedTests: 100,
        failedTests: 0,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 3000,
      },
      sessionId
    );
    sessionManager.recordFuzzRun(
      {
        functionName: "fuzz_decode",
        filePath: "src/codec.ts",
        timestamp: Date.now(),
        totalTests: 100,
        passedTests: 100,
        failedTests: 0,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 3000,
      },
      sessionId
    );
    // Record deep run
    sessionManager.recordFuzzRun(
      {
        functionName: "fuzz_encode",
        filePath: "src/codec.ts",
        timestamp: Date.now(),
        totalTests: 15000,
        passedTests: 14999,
        failedTests: 1,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 300000,
        suiteTimeout: 300000,
        maxTests: 0,
      },
      sessionId
    );

    const result = await findBugs({
      phase: "contextualize_bugs",
      model,
      vendor,
      statePayload: {
        sessionId,
        bugs: [{ entrypoint: "fuzz_encode", error: "Invariant violation" }],
      },
    });

    expect(result.phase).toBe("contextualize_bugs");
    expect(result.recommendedNextPhase).toBe("complete");
    expect(result.summaryText).toContain(
      "Find Bugs: Phase `contextualize_bugs`"
    );
    expect(result.instructions).toContain(
      "Bug Contextualization & Maintainer Intent Verification"
    );
    expect(result.instructions).toContain("Scope & Access Assessment");
    expect(result.instructions).toContain("CRITICAL ANTI-RATIONALIZATION RULE");
    expect(result.instructions).toContain(
      "Documented WontFix / Working as Intended"
    );
    expect(result.instructions).toContain(`"model": "${model}"`);
    expect(result.instructions).toContain(`"vendor": "${vendor}"`);
  });

  it("handles phase 'complete' with report guidelines and user disposition options", async () => {
    sessionManager.recordFuzzRun(
      {
        functionName: "test_fn",
        filePath: "src/fn.ts",
        timestamp: Date.now(),
        totalTests: 1000,
        passedTests: 1000,
        failedTests: 0,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 300000,
        suiteTimeout: 300000,
        maxTests: 0,
      },
      "complete-test-session"
    );

    const result = await findBugs({
      phase: "complete",
      model,
      vendor,
      statePayload: { sessionId: "complete-test-session" },
    });

    expect(result.phase).toBe("complete");
    expect(result.recommendedNextPhase).toBeUndefined();
    expect(result.instructions).toContain("Structured Summary Report");
    expect(result.instructions).toContain(
      "Interactive User Review & Artifact Disposition"
    );
    expect(result.instructions).toContain(
      "Option 1: Discuss the bugs with the agent (Recommended)"
    );
    expect(result.instructions).toContain(
      "Option 2: Investigate fixes for the discovered bugs"
    );
    expect(result.instructions).toContain("Option 3: Keep bug-eliciting only");
    expect(result.instructions).toContain(
      "Option 4: Archive bug-eliciting to ZIP"
    );
    expect(result.instructions).toContain("Option 5: Archive all to ZIP");
  });

  it("handles experimental options: tool='hypothesis' and invariantSource='docs'", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "hypothesis");
    Config.override("nanofuzz.experimental.findBugs.invariantSource", "docs");

    const initRes = await findBugs({
      phase: "init",
      model,
      vendor,
    });

    expect(initRes.instructions).toContain("Engine: hypothesis | Source: docs");
    expect(initRes.instructions).toContain("Find API Documentation");
    expect(initRes.instructions).toContain(
      "The documentation is your specification and primary oracle"
    );
    expect(initRes.instructions).toContain("Model-Based Oracles");
    expect(initRes.instructions).toContain(
      "Do not spend budget hunting for a specific known bug"
    );

    const synthRes = await findBugs({
      phase: "invariants_extracted",
      model,
      vendor,
      statePayload: {
        sessionId: "exp-session-1",
        entrypoints: [
          {
            name: "encode",
            filePath: "tests/test_pbt_encode.py",
            invariants: ["inv1"],
          },
          {
            name: "decode",
            filePath: "tests/test_pbt_encode.py",
            invariants: ["inv2"],
          },
        ],
      },
    });

    expect(synthRes.instructions).toContain("Hypothesis Test Suite Synthesis");
    expect(synthRes.instructions).toContain("@st.composite");
    expect(synthRes.instructions).toContain(".map()");
    expect(synthRes.instructions).toContain("@given");

    // Record smoke runs for both declared entrypoints
    sessionManager.recordFuzzRun(
      {
        functionName: "encode",
        filePath: "tests/test_pbt_encode.py",
        timestamp: Date.now(),
        totalTests: 100,
        passedTests: 100,
        failedTests: 0,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 3000,
      },
      "exp-session-1"
    );
    sessionManager.recordFuzzRun(
      {
        functionName: "decode",
        filePath: "tests/test_pbt_encode.py",
        timestamp: Date.now(),
        totalTests: 100,
        passedTests: 100,
        failedTests: 0,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 3000,
      },
      "exp-session-1"
    );

    const fuzzRes = await findBugs({
      phase: "fuzz_entrypoint",
      model,
      vendor,
      statePayload: {
        sessionId: "exp-session-1",
        stage: "deep",
        harnessFilePath: "tests/test_pbt_encode.py",
        functionName: "encode",
      },
    });

    expect(fuzzRes.instructions).toContain("nanofuzz_fuzzFunction");
    expect(fuzzRes.instructions).toContain("tests/test_pbt_encode.py");
    expect(fuzzRes.instructions).toContain("Stage 2: Deep Fuzzing Run");

    // Record deep fuzz runs satisfying stopping criteria (100% branch coverage) so gate passes
    sessionManager.recordFuzzRun(
      {
        functionName: "encode",
        filePath: "tests/test_pbt_encode.py",
        timestamp: Date.now(),
        totalTests: 10000,
        passedTests: 9999,
        failedTests: 1,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 300000,
        suiteTimeout: 300000,
        maxTests: 0,
        branchCoveragePct: 100,
      },
      "exp-session-1"
    );
    sessionManager.recordFuzzRun(
      {
        functionName: "decode",
        filePath: "tests/test_pbt_encode.py",
        timestamp: Date.now(),
        totalTests: 10000,
        passedTests: 10000,
        failedTests: 0,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 300000,
        suiteTimeout: 300000,
        maxTests: 0,
        branchCoveragePct: 100,
      },
      "exp-session-1"
    );

    // Contextualize bugs before complete
    await findBugs({
      phase: "contextualize_bugs",
      model,
      vendor,
      statePayload: {
        sessionId: "exp-session-1",
        bugs: [
          {
            entrypoint: "encode",
            status: "Novel / Unreported",
            evidence: "tests/test_pbt_encode.py",
            maintainerRationale: "Test bug",
          },
        ],
      },
    });

    const compRes = await findBugs({
      phase: "complete",
      model,
      vendor,
      statePayload: {
        sessionId: "exp-session-1",
        bugs: [
          {
            entrypoint: "encode",
            status: "Novel / Unreported",
            evidence: "tests/test_pbt_encode.py",
            maintainerRationale: "Test bug",
          },
        ],
      },
    });

    expect(compRes.instructions).toContain("Workflow Execution Telemetry");
    expect(compRes.instructions).toContain("exp-session-1");
  });

  it("handles experimental option: tool='hypofuzz'", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "hypofuzz");
    Config.override("nanofuzz.experimental.findBugs.invariantSource", "tests");

    // Register entrypoints in session first
    await findBugs({
      phase: "invariants_extracted",
      model,
      vendor,
      statePayload: {
        sessionId: "hypofuzz-session",
        entrypoints: [
          {
            name: "parse",
            filePath: "tests/test_pbt_parser.py",
            invariants: ["inv1"],
          },
        ],
      },
    });

    // Record smoke run first so it can advance to Stage 2
    sessionManager.recordFuzzRun(
      {
        functionName: "parse",
        filePath: "tests/test_pbt_parser.py",
        timestamp: Date.now(),
        totalTests: 100,
        passedTests: 100,
        failedTests: 0,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 3000,
      },
      "hypofuzz-session"
    );

    const fuzzRes = await findBugs({
      phase: "fuzz_entrypoint",
      model,
      vendor,
      statePayload: {
        sessionId: "hypofuzz-session",
        stage: "deep",
        harnessFilePath: "tests/test_pbt_parser.py",
        functionName: "parse",
      },
    });

    expect(fuzzRes.instructions).toContain("nanofuzz_fuzzFunction");
    expect(fuzzRes.instructions).toContain("Stage 2: Deep Fuzzing Run");
  });

  it("handles experimental option: invariantSource='all'", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "nanofuzz");
    Config.override("nanofuzz.experimental.findBugs.invariantSource", "all");

    const initRes = await findBugs({
      phase: "init",
      model,
      vendor,
    });

    expect(initRes.instructions).toContain("Source: all");
    expect(initRes.instructions).toContain(
      "Inspect Documentation (Step 1/2: Documented Invariants)"
    );
    expect(initRes.instructions).toContain("Strict Information Barrier");
    expect(initRes.instructions).toContain(
      "2. Documented Invariants (from docs)"
    );
    expect(initRes.instructions).toContain(
      "3. Empirical Invariants & Seed Extraction (from unit tests)"
    );
    expect(initRes.recommendedNextPhase).toBe("invariants_from_tests");

    // Advance to Step 2
    const step2Res = await findBugs({
      phase: "invariants_from_tests",
      model,
      vendor,
      statePayload: {
        sessionId: "exp-session-all",
        entrypoints: [
          { name: "foo", filePath: "foo.py", invariants: ["inv1"] },
          { name: "bar", filePath: "bar.py", invariants: ["inv2"] },
        ],
      },
    });

    expect(step2Res.instructions).toContain(
      "Phase 1b: Empirical Invariant & Seed Extraction"
    );
    expect(step2Res.instructions).toContain("Step 2/2: Tests");
    expect(step2Res.recommendedNextPhase).toBe("invariants_extracted");
  });

  it("blocks transition to contextualize_bugs when nanofuzz fuzzing was never executed", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "nanofuzz");

    let threw = false;
    try {
      await findBugs({
        phase: "contextualize_bugs",
        model,
        vendor,
        statePayload: { sessionId: "gate-test-session" },
      });
    } catch (err: unknown) {
      threw = true;
      if (err instanceof Error) {
        expect(err.message).toContain("Execution Gate Blocked");
      } else {
        fail("Expected error to be an instance of Error");
      }
    }
    expect(threw).toBe(true);
  });

  it("blocks transition to contextualize_bugs when only smoke runs occurred without Stage 2 deep fuzzing", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "nanofuzz");

    // Initialize session and record a smoke run (3000ms, 100 tests)
    const initRes = await findBugs({
      phase: "init",
      model,
      vendor,
      statePayload: { sessionId: "smoke-only-session" },
    });
    expect(initRes.phase).toBe("init");

    // Advance to fuzz_entrypoint with at least 2 valid entrypoints
    await findBugs({
      phase: "invariants_extracted",
      model,
      vendor,
      statePayload: {
        sessionId: "smoke-only-session",
        entrypoints: [
          {
            name: "fuzz_target1",
            filePath: "src/foo.ts",
            invariants: ["inv1"],
          },
          {
            name: "fuzz_target2",
            filePath: "src/foo.ts",
            invariants: ["inv2"],
          },
        ],
      },
    });

    sessionManager.recordFuzzRun(
      {
        functionName: "fuzz_target1",
        filePath: "src/foo.ts",
        timestamp: Date.now(),
        totalTests: 100,
        passedTests: 90,
        failedTests: 10,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 3000,
      },
      "smoke-only-session"
    );
    sessionManager.recordFuzzRun(
      {
        functionName: "fuzz_target2",
        filePath: "src/foo.ts",
        timestamp: Date.now(),
        totalTests: 100,
        passedTests: 90,
        failedTests: 10,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 3000,
      },
      "smoke-only-session"
    );

    // Attempt to skip to contextualize_bugs
    let threw = false;
    try {
      await findBugs({
        phase: "contextualize_bugs",
        model,
        vendor,
        statePayload: {
          sessionId: "smoke-only-session",
          bugs: [{ entrypoint: "fuzz_target1", error: "smoke failure" }],
        },
      });
    } catch (err: unknown) {
      threw = true;
      if (err instanceof Error) {
        expect(err.message).toContain("Execution Gate Blocked");
        expect(err.message).toContain("Gate 3: Deep Fuzzing Required");
      } else {
        fail("Expected error to be an instance of Error");
      }
    }
    expect(threw).toBe(true);
  });

  it("blocks transition to complete when Stage 2 deep fuzzing was never executed", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "nanofuzz");

    let threw = false;
    try {
      await findBugs({
        phase: "complete",
        model,
        vendor,
        statePayload: { sessionId: "incomplete-session" },
      });
    } catch (err: unknown) {
      threw = true;
      if (err instanceof Error) {
        expect(err.message).toContain("Execution Gate Blocked");
      } else {
        fail("Expected error to be an instance of Error");
      }
    }
    expect(threw).toBe(true);
  });

  it("handles pre-selected targetScope option: instructs agent and blocks Gate 1 if entrypoints are omitted", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "hypothesis");

    const initRes = await findBugs({
      phase: "init",
      model,
      vendor,
      statePayload: {
        sessionId: "target-scope-session",
        targetScope: [
          "encode",
          "decode",
          "parse",
          "validate",
          "serialize",
        ],
      },
    });

    expect(initRes.instructions).toContain("Prescribed Target Scope");
    expect(initRes.instructions).toContain("encode");
    expect(initRes.instructions).toContain("decode");
    expect(initRes.instructions).toContain("parse");
    expect(initRes.instructions).toContain("validate");
    expect(initRes.instructions).toContain("serialize");

    // Agent attempts to submit only 2 of the 5 entrypoints
    let threw = false;
    try {
      await findBugs({
        phase: "invariants_extracted",
        model,
        vendor,
        statePayload: {
          sessionId: "target-scope-session",
          entrypoints: [
            {
              name: "encode",
              filePath: "src/codec/encode.py",
              invariants: ["inv1"],
            },
            {
              name: "validate",
              filePath: "src/codec/validate.py",
              invariants: ["inv2"],
            },
          ],
        },
      });
    } catch (err: unknown) {
      threw = true;
      if (err instanceof Error) {
        expect(err.message).toContain("Execution Gate Blocked");
        expect(err.message).toContain(
          "Gate 1: Missing Pre-Selected Entrypoints"
        );
        expect(err.message).toContain("decode");
        expect(err.message).toContain("parse");
        expect(err.message).toContain("serialize");
      } else {
        fail("Expected error to be an instance of Error");
      }
    }
    expect(threw).toBe(true);
  });

  it("allows Gate 1 to pass when all pre-selected entrypoints in targetScope are registered", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "hypothesis");

    const extractedRes = await findBugs({
      phase: "invariants_extracted",
      model,
      vendor,
      statePayload: {
        sessionId: "target-scope-pass-session",
        targetScope: [
          "encode",
          "decode",
          "parse",
          "validate",
          "serialize",
        ],
        entrypoints: [
          {
            name: "encode",
            filePath: "src/codec/encode.py",
            invariants: ["inv1"],
          },
          {
            name: "decode",
            filePath: "src/codec/decode.py",
            invariants: ["inv2"],
          },
          {
            name: "parse",
            filePath: "src/codec/parse.py",
            invariants: ["inv3"],
          },
          {
            name: "validate",
            filePath: "src/codec/validate.py",
            invariants: ["inv4"],
          },
          {
            name: "serialize",
            filePath: "src/codec/serialize.py",
            invariants: ["inv5"],
          },
        ],
      },
    });

    expect(extractedRes.phase).toBe("invariants_extracted");
    expect(extractedRes.recommendedNextPhase).toBe("fuzz_smoke");
  });

  it("runs normally through Gate 1 when targetScope is empty", async () => {
    const initRes = await findBugs({
      phase: "init",
      model,
      vendor,
      statePayload: { sessionId: "empty-scope-session" },
    });

    expect(initRes.instructions).not.toContain("Prescribed Target Scope");

    const extractedRes = await findBugs({
      phase: "invariants_extracted",
      model,
      vendor,
      statePayload: {
        sessionId: "empty-scope-session",
        entrypoints: [
          {
            name: "custom_fn",
            filePath: "src/custom.ts",
            invariants: ["inv1"],
          },
        ],
      },
    });

    expect(extractedRes.phase).toBe("invariants_extracted");
    expect(extractedRes.recommendedNextPhase).toBe("fuzz_smoke");
  });

  it("handles skipContextualization: skips Phase 4 directly to complete without error", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "nanofuzz");
    Config.override(
      "nanofuzz.experimental.findBugs.skipContextualization",
      true
    );

    const sessionId = "skip-context-session";
    await findBugs({
      phase: "init",
      model,
      vendor,
      statePayload: { sessionId },
    });

    await findBugs({
      phase: "invariants_extracted",
      model,
      vendor,
      statePayload: {
        sessionId,
        entrypoints: [
          {
            name: "fuzz_target",
            filePath: "src/foo.ts",
            invariants: ["inv1"],
          },
        ],
      },
    });

    // Record smoke run
    sessionManager.recordFuzzRun(
      {
        functionName: "fuzz_target",
        filePath: "src/foo.ts",
        timestamp: Date.now(),
        totalTests: 100,
        passedTests: 90,
        failedTests: 10,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 3000,
      },
      sessionId
    );

    // Record deep run meeting criteria (300000ms, maxTests: 0, 100% branch coverage)
    sessionManager.recordFuzzRun(
      {
        functionName: "fuzz_target",
        filePath: "src/foo.ts",
        timestamp: Date.now(),
        totalTests: 5000,
        passedTests: 4900,
        failedTests: 100,
        erroredTests: 0,
        skippedTests: 0,
        timeouts: 0,
        exceptions: 0,
        durationMs: 300000,
        suiteTimeout: 300000,
        maxTests: 0,
        branchCoveragePct: 100,
      },
      sessionId
    );

    // Check fuzz_entrypoint nextPhase
    const deepRes = await findBugs({
      phase: "fuzz_entrypoint",
      model,
      vendor,
      statePayload: {
        sessionId,
        stage: "deep",
        functionName: "fuzz_target",
      },
    });
    expect(deepRes.recommendedNextPhase).toBe("complete");

    // Complete directly without contextualize_bugs
    const compRes = await findBugs({
      phase: "complete",
      model,
      vendor,
      statePayload: {
        sessionId,
        bugs: [{ entrypoint: "fuzz_target", error: "test failure" }],
      },
    });
    expect(compRes.phase).toBe("complete");
    expect(compRes.instructions).toContain("Workflow Execution Telemetry");
  });

  const tools = ["nanofuzz", "hypothesis", "hypofuzz"] as const;
  const sources = ["docs", "tests", "all"] as const;

  for (const tool of tools) {
    for (const source of sources) {
      it(`walks through full workflow with all gates for tool='${tool}' and invariantSource='${source}'`, async () => {
        Config.override("nanofuzz.experimental.findBugs.tool", tool);
        Config.override(
          "nanofuzz.experimental.findBugs.invariantSource",
          source
        );

        const sessionId = `full-workflow-${tool}-${source}`;

        // Phase: init
        const initRes = await findBugs({
          phase: "init",
          model,
          vendor,
          statePayload: { sessionId },
        });
        expect(initRes.phase).toBe("init");
        if (source === "all") {
          expect(initRes.recommendedNextPhase).toBe("invariants_from_tests");

          // Phase: invariants_from_tests
          const testsRes = await findBugs({
            phase: "invariants_from_tests",
            model,
            vendor,
            statePayload: { sessionId },
          });
          expect(testsRes.phase).toBe("invariants_from_tests");
          expect(testsRes.recommendedNextPhase).toBe("invariants_extracted");
        } else {
          expect(initRes.recommendedNextPhase).toBe("invariants_extracted");
        }

        // Gate 1: Register entrypoint
        const epName = tool === "nanofuzz" ? "fuzz_target" : "test_target";
        const synthRes = await findBugs({
          phase: "invariants_extracted",
          model,
          vendor,
          statePayload: {
            sessionId,
            entrypoints: [
              {
                name: epName,
                filePath: "src/target.py",
                invariants: ["inv_always_positive"],
                harnessFunctionName: epName,
              },
            ],
          },
        });
        expect(synthRes.phase).toBe("invariants_extracted");
        expect(synthRes.recommendedNextPhase).toBe("fuzz_smoke");

        // Stage 1 Smoke Guidance
        const smokeRes = await findBugs({
          phase: "fuzz_entrypoint",
          model,
          vendor,
          statePayload: {
            sessionId,
            stage: "smoke",
            functionName: epName,
            harnessFilePath: "src/target.py",
          },
        });
        expect(smokeRes.phase).toBe("fuzz_entrypoint");
        expect(smokeRes.recommendedNextPhase).toBe("fuzz_deep");

        // Record Stage 1 Smoke Run
        sessionManager.recordFuzzRun(
          {
            functionName: epName,
            filePath: "src/target.py",
            timestamp: Date.now(),
            totalTests: 100,
            passedTests: 99,
            failedTests: 1,
            erroredTests: 0,
            skippedTests: 0,
            timeouts: 0,
            exceptions: 0,
            durationMs: 3000,
            suiteTimeout: 3000,
            maxTests: 100,
          },
          sessionId
        );

        // Stage 2 Deep Guidance (before deep run satisfies criteria)
        const deepRes = await findBugs({
          phase: "fuzz_entrypoint",
          model,
          vendor,
          statePayload: {
            sessionId,
            stage: "deep",
            functionName: epName,
            harnessFilePath: "src/target.py",
          },
        });
        expect(deepRes.phase).toBe("fuzz_entrypoint");
        expect(deepRes.recommendedNextPhase).toBe("fuzz_deep");

        // Record Stage 2 Deep Run satisfying exit criteria (100% branch coverage)
        sessionManager.recordFuzzRun(
          {
            functionName: epName,
            filePath: "src/target.py",
            timestamp: Date.now(),
            totalTests: 10000,
            passedTests: 9990,
            failedTests: 10,
            erroredTests: 0,
            skippedTests: 0,
            timeouts: 0,
            exceptions: 0,
            durationMs: 300000,
            suiteTimeout: 300000,
            maxTests: 0,
            branchCoveragePct: 100,
          },
          sessionId
        );

        // After deep run satisfies criteria, calling fuzz_entrypoint recommends contextualize_bugs
        const deepRes2 = await findBugs({
          phase: "fuzz_entrypoint",
          model,
          vendor,
          statePayload: {
            sessionId,
            stage: "deep",
            functionName: epName,
            harnessFilePath: "src/target.py",
          },
        });
        expect(deepRes2.recommendedNextPhase).toBe("contextualize_bugs");

        // Phase: contextualize_bugs
        const bugs = [
          {
            entrypoint: epName,
            status: "Novel / Unreported",
            evidence: "src/target.py",
            maintainerRationale: "Discovered novel edge case",
          },
        ];
        const ctxRes = await findBugs({
          phase: "contextualize_bugs",
          model,
          vendor,
          statePayload: {
            sessionId,
            bugs,
          },
        });
        expect(ctxRes.phase).toBe("contextualize_bugs");
        expect(ctxRes.recommendedNextPhase).toBe("complete");

        // Phase: complete
        const compRes = await findBugs({
          phase: "complete",
          model,
          vendor,
          statePayload: {
            sessionId,
            bugs,
          },
        });
        expect(compRes.phase).toBe("complete");
        expect(compRes.recommendedNextPhase).toBeUndefined();
        expect(compRes.instructions).toContain("Structured Summary Report");
        expect(compRes.instructions).toContain("Workflow Execution Telemetry");
      });
    }
  }
});
