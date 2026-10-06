import { Tester as TesterV1 } from "./Fuzzer";
import { FuzzerV2 as TesterV2 } from "./FuzzerV2";
import { FuzzerFactory } from "./FuzzerFactory";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { getToolVersion } from "../ToolVersion";
import { FuzzBusyStatusMessage, FuzzStopReason } from "./Types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

  it("resuming after maxTests runs fresh tests per run and accumulates stats across runs (parity with V1)", async () => {
    const options = {
      ...intOptions,
      maxTests: 10,
      seed: "resume-max-tests",
    };

    const testerV1 = new TesterV1(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    );
    const run1V1 = await testerV1.test();
    expect(testerV1.state).toBe("paused");
    expect(run1V1.stopReason).toBe(FuzzStopReason.MAXTESTS);
    expect(run1V1.stats.counters.testingRuns).toBe(1);
    expect(run1V1.stats.outcomes.total).toBe(10);
    expect(run1V1.results.length).toBe(10);

    const run2V1 = await testerV1.test();
    expect(testerV1.state).toBe("paused");
    expect(run2V1.stopReason).toBe(FuzzStopReason.MAXTESTS);
    expect(run2V1.stats.counters.testingRuns).toBe(2);
    expect(run2V1.stats.outcomes.total).toBe(20);
    expect(run2V1.results.length).toBe(20);

    const testerV2 = new TesterV2(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    );
    const run1V2 = await testerV2.test();
    expect(testerV2.state).toBe("paused");
    expect(run1V2.stopReason).toBe(FuzzStopReason.MAXTESTS);
    expect(run1V2.stats.counters.testingRuns).toBe(1);
    expect(run1V2.stats.outcomes.total).toBe(10);
    expect(run1V2.results.length).toBe(10);

    const run2V2 = await testerV2.test();
    expect(testerV2.state).toBe("paused");
    expect(run2V2.stopReason).toBe(FuzzStopReason.MAXTESTS);
    expect(run2V2.stats.counters.testingRuns).toBe(2);
    expect(run2V2.stats.outcomes.total).toBe(20);
    expect(run2V2.results.length).toBe(20);
  });

  it("resuming after cancellation executes the target number of tests in the new run", async () => {
    const options = {
      ...intOptions,
      maxTests: 10,
      seed: "resume-cancel-seed",
    };

    const tester = new TesterV2(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    );

    let cancel = false;
    let count = 0;
    const run1 = await tester.test(
      [],
      { gen: true },
      undefined,
      () => cancel,
      () => {
        count++;
        if (count >= 3) {
          cancel = true;
        }
      }
    );

    expect(tester.state).toBe("paused");
    expect(run1.stopReason).toBe(FuzzStopReason.PAUSE);
    expect(run1.stats.counters.testingRuns).toBe(1);
    const run1Total = run1.stats.outcomes.total;
    expect(run1Total).toBeGreaterThanOrEqual(3);

    // Resume testing without cancellation
    const run2 = await tester.test();
    expect(tester.state).toBe("paused");
    expect(run2.stopReason).toBe(FuzzStopReason.MAXTESTS);
    expect(run2.stats.counters.testingRuns).toBe(2);
    expect(run2.stats.outcomes.total).toBe(run1Total + 10);
    expect(run2.results.length).toBe(run1Total + 10);
  });

  it("resuming after maxFailures uses per-run failure counts (parity with V1)", async () => {
    const tmpdir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-fail-parity-")
    );
    const tsFile = path.join(tmpdir, "failTarget.ts");
    fs.writeFileSync(
      tsFile,
      `
      export function throwFn(x: number): number {
        throw new Error("fail on purpose");
      }
      `
    );

    const options = {
      ...intOptions,
      maxTests: 20,
      maxFailures: 2,
    };

    try {
      const testerV1 = new TesterV1(tsFile, "throwFn", options);
      const run1V1 = await testerV1.test();
      expect(testerV1.state).toBe("paused");
      expect(run1V1.stopReason).toBe(FuzzStopReason.MAXFAILURES);
      expect(run1V1.stats.counters.testingRuns).toBe(1);
      expect(run1V1.stats.counters.failedTests).toBe(2);

      const run2V1 = await testerV1.test();
      expect(testerV1.state).toBe("paused");
      expect(run2V1.stopReason).toBe(FuzzStopReason.MAXFAILURES);
      expect(run2V1.stats.counters.testingRuns).toBe(2);
      expect(run2V1.stats.counters.failedTests).toBe(4);

      const testerV2 = new TesterV2(tsFile, "throwFn", options);
      const run1V2 = await testerV2.test();
      expect(testerV2.state).toBe("paused");
      expect(run1V2.stopReason).toBe(FuzzStopReason.MAXFAILURES);
      expect(run1V2.stats.counters.testingRuns).toBe(1);
      expect(run1V2.stats.counters.failedTests).toBe(2);

      const run2V2 = await testerV2.test();
      expect(testerV2.state).toBe("paused");
      expect(run2V2.stopReason).toBe(FuzzStopReason.MAXFAILURES);
      expect(run2V2.stats.counters.testingRuns).toBe(2);
      expect(run2V2.stats.counters.failedTests).toBe(4);
    } finally {
      try {
        fs.rmSync(tmpdir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // Ignore
      }
    }
  });

  it("resuming after maxDupes resets sequential duplicate counter per run (parity with V1)", async () => {
    const tmpdir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-dupes-parity-")
    );
    const tsFile = path.join(tmpdir, "boolTarget.ts");
    fs.writeFileSync(
      tsFile,
      `
      export function boolFn(x: boolean): boolean {
        return !x;
      }
      `
    );

    const options = {
      ...intOptions,
      maxTests: 100,
      maxDupeInputs: 5,
    };

    try {
      const testerV1 = new TesterV1(tsFile, "boolFn", options);
      const run1V1 = await testerV1.test();
      expect(testerV1.state).toBe("paused");
      expect(run1V1.stopReason).toBe(FuzzStopReason.MAXDUPES);
      expect(run1V1.stats.counters.testingRuns).toBe(1);

      const run2V1 = await testerV1.test();
      expect(testerV1.state).toBe("paused");
      expect(run2V1.stopReason).toBe(FuzzStopReason.MAXDUPES);
      expect(run2V1.stats.counters.testingRuns).toBe(2);

      const testerV2 = new TesterV2(tsFile, "boolFn", options);
      const run1V2 = await testerV2.test();
      expect(testerV2.state).toBe("paused");
      expect(run1V2.stopReason).toBe(FuzzStopReason.MAXDUPES);
      expect(run1V2.stats.counters.testingRuns).toBe(1);

      const run2V2 = await testerV2.test();
      expect(testerV2.state).toBe("paused");
      expect(run2V2.stopReason).toBe(FuzzStopReason.MAXDUPES);
      expect(run2V2.stats.counters.testingRuns).toBe(2);
    } finally {
      try {
        fs.rmSync(tmpdir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // Ignore
      }
    }
  });

  it("resuming after maxTime uses per-run timeout clock (parity with V1)", async () => {
    const tmpdir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-timeout-parity-")
    );
    const tsFile = path.join(tmpdir, "sleepTarget.ts");
    fs.writeFileSync(
      tsFile,
      `
      export function sleepFn(x: number): number {
        const start = Date.now();
        while (Date.now() - start < 60) {}
        return x;
      }
      `
    );

    const options = {
      ...intOptions,
      maxTests: 50,
      suiteTimeout: 150,
      fnTimeout: 1000,
    };

    try {
      const testerV1 = new TesterV1(tsFile, "sleepFn", options);
      const run1V1 = await testerV1.test();
      expect(testerV1.state).toBe("paused");
      expect(run1V1.stopReason).toBe(FuzzStopReason.MAXTIME);
      expect(run1V1.stats.counters.testingRuns).toBe(1);
      const run1V1Total = run1V1.stats.outcomes.total;
      expect(run1V1Total).toBeGreaterThan(0);

      const run2V1 = await testerV1.test();
      expect(testerV1.state).toBe("paused");
      expect(run2V1.stopReason).toBe(FuzzStopReason.MAXTIME);
      expect(run2V1.stats.counters.testingRuns).toBe(2);
      expect(run2V1.stats.outcomes.total).toBeGreaterThan(run1V1Total);

      const testerV2 = new TesterV2(tsFile, "sleepFn", options);
      const run1V2 = await testerV2.test();
      expect(testerV2.state).toBe("paused");
      expect(run1V2.stopReason).toBe(FuzzStopReason.MAXTIME);
      expect(run1V2.stats.counters.testingRuns).toBe(1);
      const run1V2Total = run1V2.stats.outcomes.total;
      expect(run1V2Total).toBeGreaterThan(0);

      const run2V2 = await testerV2.test();
      expect(testerV2.state).toBe("paused");
      expect(run2V2.stopReason).toBe(FuzzStopReason.MAXTIME);
      expect(run2V2.stats.counters.testingRuns).toBe(2);
      expect(run2V2.stats.outcomes.total).toBeGreaterThan(run1V2Total);
    } finally {
      try {
        fs.rmSync(tmpdir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // Ignore
      }
    }
  });
});
