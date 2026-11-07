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
        entrypoints: [{ name: "encode", filePath: "src/codec.ts" }],
      },
    });

    expect(result.phase).toBe("invariants_extracted");
    expect(result.recommendedNextPhase).toBe("fuzz_entrypoint");
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
    const result = await findBugs({
      phase: "fuzz_entrypoint",
      model,
      vendor,
      statePayload: {
        stage: "deep",
        harnessFilePath: "nanofuzz_harness_encode.ts",
        functionName: "fuzz_encode",
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
    const result = await findBugs({
      phase: "fuzz_entrypoint",
      model,
      vendor,
      statePayload: {
        stage: "smoke",
        harnessFilePath: "nanofuzz_harness_encode.ts",
        functionName: "fuzz_encode",
      },
    });

    expect(result.phase).toBe("fuzz_entrypoint");
    expect(result.recommendedNextPhase).toBe("fuzz_entrypoint");
    expect(result.instructions).toContain("Stage 1: Fast Smoke Test");
    expect(result.instructions).toContain('"timeoutMs": 3000');
    expect(result.instructions).toContain('"stage": "deep"');
  });

  it("handles phase 'contextualize_bugs' with maintainer intent verification and anti-rationalization rule", async () => {
    // Session needs a completed deep run to pass the execution gate
    const sessionId = "deep-run-valid-session";
    sessionManager.getOrCreateSession(
      sessionId,
      "nanofuzz",
      "tests",
      4,
      "fuzz_entrypoint"
    );
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
    const result = await findBugs({
      phase: "complete",
      model,
      vendor,
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
      statePayload: { sessionId: "exp-session-1" },
    });

    expect(synthRes.instructions).toContain("Hypothesis Test Suite Synthesis");
    expect(synthRes.instructions).toContain("@st.composite");
    expect(synthRes.instructions).toContain(".map()");
    expect(synthRes.instructions).toContain("@given");

    const fuzzRes = await findBugs({
      phase: "fuzz_entrypoint",
      model,
      vendor,
      statePayload: {
        sessionId: "exp-session-1",
        harnessFilePath: "tests/test_pbt_encode.py",
        functionName: "encode",
      },
    });

    expect(fuzzRes.instructions).toContain("pytest -n");
    expect(fuzzRes.instructions).toContain("tests/test_pbt_encode.py");

    const compRes = await findBugs({
      phase: "complete",
      model,
      vendor,
      statePayload: { sessionId: "exp-session-1" },
    });

    expect(compRes.instructions).toContain("Workflow Execution Telemetry");
    expect(compRes.instructions).toContain("exp-session-1");
  });

  it("handles experimental option: tool='hypofuzz'", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "hypofuzz");
    Config.override("nanofuzz.experimental.findBugs.invariantSource", "tests");

    const fuzzRes = await findBugs({
      phase: "fuzz_entrypoint",
      model,
      vendor,
      statePayload: {
        harnessFilePath: "tests/test_pbt_parser.py",
        functionName: "parse",
      },
    });

    expect(fuzzRes.instructions).toContain("hypofuzz -n");
    expect(fuzzRes.instructions).toContain("--max-total-time=300s");
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
      "Inspect Documentation and Existing Test Suite"
    );
    expect(initRes.instructions).toContain("Strict Information Barrier");
    expect(initRes.instructions).toContain("from docs & unit tests");
    expect(initRes.instructions).toContain(
      "Formulate invariants by combining documented specifications with empirical test cases, such as:"
    );
  });

  it("blocks transition to contextualize_bugs when nanofuzz fuzzing was never executed", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "nanofuzz");

    const blockedRes = await findBugs({
      phase: "contextualize_bugs",
      model,
      vendor,
      statePayload: { sessionId: "gate-test-session" },
    });

    expect(blockedRes.phase).toBe("contextualize_bugs");
    expect(blockedRes.recommendedNextPhase).toBe("contextualize_bugs");
    expect(blockedRes.instructions).toContain(
      "Execution Gate Blocked: Deep Fuzzing Required"
    );
    expect(blockedRes.instructions).toContain(
      "No fuzzing runs were recorded for this session"
    );
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

    // Advance to fuzz_entrypoint
    await findBugs({
      phase: "invariants_extracted",
      model,
      vendor,
      statePayload: { sessionId: "smoke-only-session" },
    });

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
      "smoke-only-session"
    );

    // Attempt to skip to contextualize_bugs
    const blockedRes = await findBugs({
      phase: "contextualize_bugs",
      model,
      vendor,
      statePayload: {
        sessionId: "smoke-only-session",
        bugs: [{ entrypoint: "fuzz_target", error: "smoke failure" }],
      },
    });

    expect(blockedRes.phase).toBe("contextualize_bugs");
    expect(blockedRes.recommendedNextPhase).toBe("contextualize_bugs");
    expect(blockedRes.instructions).toContain(
      "Execution Gate Blocked: Deep Fuzzing Required"
    );
    expect(blockedRes.instructions).toContain("Only 1 smoke run(s) recorded");
  });
});
