import { FuzzerEngineVersion, FuzzerFactory } from "./FuzzerFactory";
import { FuzzBusyStatusMessage, FuzzStopReason } from "./Types";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { getToolVersion } from "../ToolVersion";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const engines: FuzzerEngineVersion[] = ["v1", "v2", "v3"];

describe("fuzzer: general & parameterized engine tests", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("FuzzerFactory instantiates v1, v2, or v3 based on engine option and defaults to v3", () => {
    const testerDefault = FuzzerFactory(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      intOptions
    );
    expect(testerDefault.constructor.name).toBe("FuzzerV3");

    const testerV1 = FuzzerFactory(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      intOptions,
      { engine: "v1" }
    );
    expect(testerV1.constructor.name).toBe("Tester");

    const testerV2 = FuzzerFactory(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      intOptions,
      { engine: "v2" }
    );
    expect(testerV2.constructor.name).toBe("FuzzerV2");

    const testerV3 = FuzzerFactory(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      intOptions,
      { engine: "v3" }
    );
    expect(testerV3.constructor.name).toBe("FuzzerV3");
  });

  engines.forEach((engine) => {
    describe(`engine: ${engine}`, () => {
      it("includes the tool version in initialized results", async () => {
        const results = await FuzzerFactory(
          "nanofuzz-study/examples/1.ts",
          "minValue",
          { ...intOptions, maxTests: 1 },
          { engine }
        ).test();

        expect(results.toolVersion).toBe(getToolVersion());
      });

      it("mutation-only fuzzing", async () => {
        const options = {
          ...intOptions,
          maxTests: 20,
          seed: "fixed-seed-mutation",
          generators: {
            RandomInputGenerator: { enabled: false },
            MutationInputGenerator: { enabled: true },
            AiInputGenerator: { enabled: false },
          },
        };

        const results = await FuzzerFactory(
          "nanofuzz-study/examples/1.ts",
          "minValue",
          options,
          { engine }
        ).test();

        expect(results.stats.outcomes.total).toBeGreaterThan(0);
        expect(results.stopReason).toBe(FuzzStopReason.MAXTESTS);
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

        const results = await FuzzerFactory(
          "nanofuzz-study/examples/1.ts",
          "minValue",
          options,
          { engine }
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

        const results = await FuzzerFactory(
          "nanofuzz-study/examples/1.ts",
          "minValue",
          options,
          { engine }
        ).test(injected);

        expect(results.stats.counters.inputsInjected).toBe(1);
        expect(results.results[0].pinned).toBe(true);
        expect<unknown>(results.results[0].input[0].value).toBe(42);
        expect<unknown>(results.results[0].input[1].value).toBe(99);
      });

      it("test execution with status updates", async () => {
        const options = {
          ...intOptions,
          maxTests: 15,
          seed: "async-seed",
        };

        const tester = FuzzerFactory(
          "nanofuzz-study/examples/1.ts",
          "minValue",
          options,
          { engine }
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

      it("resuming after maxTests runs fresh tests per run and accumulates stats across runs", async () => {
        const options = {
          ...intOptions,
          maxTests: 10,
          seed: "resume-max-tests",
        };

        const tester = FuzzerFactory(
          "nanofuzz-study/examples/1.ts",
          "minValue",
          options,
          { engine }
        );
        const run1 = await tester.test();
        expect(tester.state).toBe("paused");
        expect(run1.stopReason).toBe(FuzzStopReason.MAXTESTS);
        expect(run1.stats.counters.testingRuns).toBe(1);
        expect(run1.stats.outcomes.total).toBe(10);
        expect(run1.results.length).toBe(10);

        const run2 = await tester.test();
        expect(tester.state).toBe("paused");
        expect(run2.stopReason).toBe(FuzzStopReason.MAXTESTS);
        expect(run2.stats.counters.testingRuns).toBe(2);
        expect(run2.stats.outcomes.total).toBe(20);
        expect(run2.results.length).toBe(20);
      });

      it("resuming after cancellation executes the target number of tests in the new run", async () => {
        const options = {
          ...intOptions,
          maxTests: 10,
          seed: "resume-cancel-seed",
        };

        const tester = FuzzerFactory(
          "nanofuzz-study/examples/1.ts",
          "minValue",
          options,
          { engine }
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

        const run2 = await tester.test();
        expect(tester.state).toBe("paused");
        expect(run2.stopReason).toBe(FuzzStopReason.MAXTESTS);
        expect(run2.stats.counters.testingRuns).toBe(2);
        expect(run2.stats.outcomes.total).toBe(run1Total + 10);
        expect(run2.results.length).toBe(run1Total + 10);
      });

      it("resuming after maxFailures uses per-run failure counts", async () => {
        const tmpdir = fs.mkdtempSync(
          path.join(os.tmpdir(), `nanofuzz-fail-parity-${engine}-`)
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
          const tester = FuzzerFactory(tsFile, "throwFn", options, { engine });
          const run1 = await tester.test();
          expect(tester.state).toBe("paused");
          expect(run1.stopReason).toBe(FuzzStopReason.MAXFAILURES);
          expect(run1.stats.counters.testingRuns).toBe(1);
          expect(run1.stats.counters.failedTests).toBe(2);

          const run2 = await tester.test();
          expect(tester.state).toBe("paused");
          expect(run2.stopReason).toBe(FuzzStopReason.MAXFAILURES);
          expect(run2.stats.counters.testingRuns).toBe(2);
          expect(run2.stats.counters.failedTests).toBe(4);
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

      it("resuming after maxDupes resets sequential duplicate counter per run", async () => {
        const tmpdir = fs.mkdtempSync(
          path.join(os.tmpdir(), `nanofuzz-dupes-parity-${engine}-`)
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
          const tester = FuzzerFactory(tsFile, "boolFn", options, { engine });
          const run1 = await tester.test();
          expect(tester.state).toBe("paused");
          expect(run1.stopReason).toBe(FuzzStopReason.MAXDUPES);
          expect(run1.stats.counters.testingRuns).toBe(1);

          const run2 = await tester.test();
          expect(tester.state).toBe("paused");
          expect(run2.stopReason).toBe(FuzzStopReason.MAXDUPES);
          expect(run2.stats.counters.testingRuns).toBe(2);
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

      it("resuming after maxTime uses per-run timeout clock", async () => {
        const tmpdir = fs.mkdtempSync(
          path.join(os.tmpdir(), `nanofuzz-timeout-parity-${engine}-`)
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
          const tester = FuzzerFactory(tsFile, "sleepFn", options, { engine });
          const run1 = await tester.test();
          expect(tester.state).toBe("paused");
          expect(run1.stopReason).toBe(FuzzStopReason.MAXTIME);
          expect(run1.stats.counters.testingRuns).toBe(1);
          const run1Total = run1.stats.outcomes.total;
          expect(run1Total).toBeGreaterThan(0);

          const run2 = await tester.test();
          expect(tester.state).toBe("paused");
          expect(run2.stopReason).toBe(FuzzStopReason.MAXTIME);
          expect(run2.stats.counters.testingRuns).toBe(2);
          expect(run2.stats.outcomes.total).toBeGreaterThan(run1Total);
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
  });
});
