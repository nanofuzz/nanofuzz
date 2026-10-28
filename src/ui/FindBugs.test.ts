import { findBugs } from "./FindBugs";

describe("FindBugs", () => {
  const model = "gemini-2.0-flash";
  const vendor = "google";

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
    expect(result.instructions).toContain("Max 5 Retries");
    expect(result.instructions).toContain("contextualize_bugs");
  });

  it("handles phase 'contextualize_bugs' with maintainer intent verification and anti-rationalization rule", async () => {
    const result = await findBugs({
      phase: "contextualize_bugs",
      model,
      vendor,
      statePayload: {
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
});
