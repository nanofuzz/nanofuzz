import { Tester as TesterV1 } from "./Fuzzer";
import { FuzzerV2 as TesterV2 } from "./FuzzerV2";
import { FuzzerFactory } from "./FuzzerFactory";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { getToolVersion } from "../ToolVersion";
import { FuzzBusyStatusMessage, FuzzStopReason } from "./Types";

describe("fuzzer V2: general & parity tests", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("TesterFactory instantiates V1 or V2 based on engine option and defaults to V2", () => {
    const testerDefault = FuzzerFactory(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      intOptions
    );
    expect(testerDefault instanceof TesterV2).toBe(true);

    const testerV1 = FuzzerFactory(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      intOptions,
      { engine: "v1" }
    );
    expect(testerV1 instanceof TesterV1).toBe(true);

    const testerV2 = FuzzerFactory(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      intOptions,
      { engine: "v2" }
    );
    expect(testerV2 instanceof TesterV2).toBe(true);
  });

  it("includes the tool version in initialized results", async () => {
    const results = await new TesterV2(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      { ...intOptions, maxTests: 1 }
    ).test();

    expect(results.toolVersion).toBe(getToolVersion());
  });

  it("mutation-only fuzzing parity", async () => {
    const options = {
      ...intOptions,
      maxTests: 20,
      seed: "fixed-seed-parity",
      generators: {
        RandomInputGenerator: { enabled: false },
        MutationInputGenerator: { enabled: true },
        AiInputGenerator: { enabled: false },
      },
    };

    const resultsV1 = await new TesterV1(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    ).test();

    const resultsV2 = await new TesterV2(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    ).test();

    expect(resultsV2.stopReason).toBe(resultsV1.stopReason);
    expect(resultsV2.stats.outcomes.total).toBe(resultsV1.stats.outcomes.total);
    expect(resultsV2.results.length).toBe(resultsV1.results.length);
  });

  it("CIG: NOMOREINPUTS if no rnd ig & no other ig provides inputs", async () => {
    const options = {
      ...intOptions,
      maxTests: 100,
      generators: {
        RandomInputGenerator: { enabled: false },
        MutationInputGenerator: { enabled: false },
        AiInputGenerator: { enabled: false },
      },
    };

    const results = await new TesterV2(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    ).test();

    expect(results.stopReason).toBe(FuzzStopReason.NOMOREINPUTS);
  });

  it("retests injected pinned tests identically", async () => {
    const options = {
      ...intOptions,
      maxTests: 10,
      seed: "injected-test-seed",
    };

    const injected = [
      {
        input: [
          {
            name: "a",
            offset: 0,
            value: 42,
            origin: { type: "user" as const },
          },
          {
            name: "b",
            offset: 1,
            value: 99,
            origin: { type: "user" as const },
          },
        ],
        output: [],
        pinned: true,
      },
    ];

    const resultsV1 = await new TesterV1(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    ).test(injected);

    const resultsV2 = await new TesterV2(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    ).test(injected);

    expect(resultsV2.stats.counters.inputsInjected).toBe(1);
    expect(resultsV1.stats.counters.inputsInjected).toBe(1);
    expect(resultsV2.results[0].pinned).toBe(true);
    expect<unknown>(resultsV2.results[0].input[0].value).toBe(42);
    expect<unknown>(resultsV2.results[0].input[1].value).toBe(99);
  });

  it("test execution with status updates", async () => {
    const options = {
      ...intOptions,
      maxTests: 15,
      seed: "async-seed",
    };

    const tester = new TesterV2(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    );

    const updates: FuzzBusyStatusMessage[] = [];
    const results = await tester.test([], { gen: true }, (payload) => {
      updates.push(payload);
    });

    expect(results.stats.outcomes.total).toBe(15);
    expect(results.stopReason).toBe(FuzzStopReason.MAXTESTS);
    expect(updates.length).toBeGreaterThan(0);
    expect(
      updates.some((u) => u.type === "testing" && typeof u.pct === "number")
    ).toBeTrue();
  });
});
