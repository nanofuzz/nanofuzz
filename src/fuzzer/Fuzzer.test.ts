import { FuzzerEngineVersion, FuzzerFactory } from "./FuzzerFactory";
import { FuzzerV3, WorkerContext } from "./FuzzerV3";
import { AbstractRunner } from "./runners/AbstractRunner";
import { FuzzBusyStatusMessage, FuzzStopReason } from "./Types";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { getToolVersion } from "../ToolVersion";
import { determineWorkerCount } from "./Util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

class TestableFuzzerV3 extends FuzzerV3 {
  public async initRunnersForTest(): Promise<void> {
    await this._initRunners([], { gen: true }, () => {});
  } // fn: initRunnersForTest

  public get workers(): readonly WorkerContext[] {
    return this._executor?.workers ?? [];
  } // get: workers

  public get userGenRunner(): AbstractRunner | undefined {
    return this._executor?.userGenRunner;
  } // get: userGenRunner

  public get transformRunner(): AbstractRunner | undefined {
    return this._executor?.transformRunner;
  } // get: transformRunner

  public async stopRunnersForTest(): Promise<void> {
    await this._stopRunners();
  } // fn: stopRunnersForTest
} // class: TestableFuzzerV3

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

  describe("resolveWorkerCount calculation", () => {
    it("respects explicit positive integer counts", () => {
      expect(determineWorkerCount(1, true)).toBe(1);
      expect(determineWorkerCount(4, false)).toBe(4);
      expect(determineWorkerCount("3", true)).toBe(3);
    });

    it("resolves 'auto' mode adapting for CLI (C-1) and non-CLI (C/2) with memory clamp", () => {
      const cliAuto = determineWorkerCount("auto", true);
      const nonCliAuto = determineWorkerCount("auto", false);
      expect(cliAuto).toBeGreaterThanOrEqual(1);
      expect(nonCliAuto).toBeGreaterThanOrEqual(1);
    });

    it("computes exact worker counts for 2-, 4-, 8-, and 16-core systems in CLI and IDE modes", () => {
      const mem16GB = 16 * 1024 * 1024 * 1024;

      // 2 Cores (16 GB)
      expect(determineWorkerCount("auto", true, 2, mem16GB)).toBe(1); // CLI: max(1, 2 - 1) = 1
      expect(determineWorkerCount("auto", false, 2, mem16GB)).toBe(1); // IDE: max(1, floor(2 / 2)) = 1

      // 4 Cores (16 GB)
      expect(determineWorkerCount("auto", true, 4, mem16GB)).toBe(3); // CLI: max(1, 4 - 1) = 3
      expect(determineWorkerCount("auto", false, 4, mem16GB)).toBe(2); // IDE: max(1, floor(4 / 2)) = 2

      // 8 Cores (16 GB)
      expect(determineWorkerCount("auto", true, 8, mem16GB)).toBe(7); // CLI: max(1, 8 - 1) = 7
      expect(determineWorkerCount("auto", false, 8, mem16GB)).toBe(4); // IDE: max(1, floor(8 / 2)) = 4

      // 16 Cores (16 GB)
      expect(determineWorkerCount("auto", true, 16, mem16GB)).toBe(15); // CLI: max(1, 16 - 1) = 15
      expect(determineWorkerCount("auto", false, 16, mem16GB)).toBe(8); // IDE: max(1, floor(16 / 2)) = 8
    });
  });

  describe("FuzzerV3 runner and worker allocation accounting", () => {
    it("verifies runner instances per worker and total runners created across core configurations", async () => {
      // 1. Base PUT target with no validator, no transformer, no user gen
      const fuzzerBase = new TestableFuzzerV3(
        "nanofuzz-study/examples/1.ts",
        "minValue",
        {
          ...intOptions,
          workers: 4,
          maxTests: 10,
          useTransformer: false,
          useProperty: false,
          generators: {
            ...intOptions.generators,
            UserInputGenerator: { enabled: false },
          },
        }
      );

      await fuzzerBase.initRunnersForTest();
      expect(fuzzerBase.workers.length).toBe(4);
      expect(fuzzerBase.userGenRunner).toBeUndefined();
      expect(fuzzerBase.transformRunner).toBeUndefined();
      fuzzerBase.workers.forEach((w) => {
        expect(w.runner).toBeDefined();
        expect(w.propRunners.length).toBe(0);
      });
      // 4 workers * (1 PUT) + 0 user gen = 4 total runners
      await fuzzerBase.stopRunnersForTest();

      // 2. PUT target with property validator (e.g. from Python fixture with validator)
      const fuzzerWithValidator = new TestableFuzzerV3(
        "./test_fixtures/Fuzzer.testfixtures.py",
        "async_greeting",
        {
          ...intOptions,
          workers: 3,
          maxTests: 10,
          useProperty: true,
          useTransformer: false,
          generators: {
            ...intOptions.generators,
            UserInputGenerator: { enabled: false },
          },
        }
      );

      await fuzzerWithValidator.initRunnersForTest();
      expect(fuzzerWithValidator.workers.length).toBe(3);
      expect(fuzzerWithValidator.userGenRunner).toBeUndefined();
      expect(fuzzerWithValidator.transformRunner).toBeUndefined();
      fuzzerWithValidator.workers.forEach((w) => {
        expect(w.runner).toBeDefined();
        expect(w.propRunners.length).toBe(1); // 1 property validator runner per worker
      });
      // 3 workers * (1 PUT + 1 Validator) + 0 user gen = 6 total runners
      await fuzzerWithValidator.stopRunnersForTest();

      // 3. PUT target with UserInputGenerator enabled
      const fuzzerWithUserGen = new TestableFuzzerV3(
        "./test_fixtures/Fuzzer.testfixtures.py",
        "py_user_gen",
        {
          ...intOptions,
          workers: 3,
          maxTests: 10,
          useProperty: false,
          useTransformer: false,
          generators: {
            RandomInputGenerator: { enabled: false },
            MutationInputGenerator: { enabled: false },
            AiInputGenerator: { enabled: false },
            UserInputGenerator: { enabled: true },
          },
        }
      );

      await fuzzerWithUserGen.initRunnersForTest();
      expect(fuzzerWithUserGen.workers.length).toBe(3);
      expect(fuzzerWithUserGen.userGenRunner).toBeDefined(); // Centralized 1 user gen runner
      expect(fuzzerWithUserGen.transformRunner).toBeUndefined();
      fuzzerWithUserGen.workers.forEach((w) => {
        expect(w.runner).toBeDefined();
        expect(w.propRunners.length).toBe(0);
      });
      // 3 workers * (1 PUT) + 1 centralized user gen = 4 total runners
      await fuzzerWithUserGen.stopRunnersForTest();

      // 4. PUT target with Transformer enabled
      const fuzzerWithTransformer = new TestableFuzzerV3(
        "./test_fixtures/Fuzzer.testfixtures.ts",
        "targetTransformed",
        {
          ...intOptions,
          workers: 4,
          maxTests: 10,
          useTransformer: true,
          useProperty: false,
          generators: {
            ...intOptions.generators,
            UserInputGenerator: { enabled: false },
          },
        }
      );

      await fuzzerWithTransformer.initRunnersForTest();
      expect(fuzzerWithTransformer.workers.length).toBe(4);
      expect(fuzzerWithTransformer.userGenRunner).toBeUndefined();
      expect(fuzzerWithTransformer.transformRunner).toBeDefined(); // Centralized 1 transformer runner
      fuzzerWithTransformer.workers.forEach((w) => {
        expect(w.runner).toBeDefined();
        expect(w.propRunners.length).toBe(0);
      });
      // 4 workers * (1 PUT) + 1 centralized transformer = 5 total runners
      await fuzzerWithTransformer.stopRunnersForTest();
    });
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
        const cov = await results.stats.measures.CodeCoverageMeasure?.();
        expect(cov).toBeDefined();
        if (cov) {
          expect(cov.counters.statementsTotal).toBeGreaterThan(0);
          expect(cov.counters.statementsCovered).toBeGreaterThan(0);
        }
      });

      it("static coverage with 0 tests across engines", async () => {
        const results = await FuzzerFactory(
          "nanofuzz-study/examples/1.ts",
          "minValue",
          { ...intOptions, maxTests: 0 },
          { engine }
        ).test([], {});

        const cov = await results.stats.measures.CodeCoverageMeasure?.();
        expect(cov).toBeDefined();
        if (cov) {
          expect(cov.counters.statementsTotal).toBeGreaterThan(0);
          expect(cov.counters.statementsCovered).toBe(1);
        }
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
            UserInputGenerator: { enabled: false },
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
            UserInputGenerator: { enabled: false },
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

      it("user generator completes maxTests w/o exhaustion", async () => {
        const options = {
          ...intOptions,
          maxTests: 25,
          generators: {
            RandomInputGenerator: { enabled: false },
            MutationInputGenerator: { enabled: false },
            AiInputGenerator: { enabled: false },
            UserInputGenerator: { enabled: true },
          },
        };

        const results = await FuzzerFactory(
          "./test_fixtures/Fuzzer.testfixtures.ts",
          "targetUserGen",
          options,
          { engine }
        ).test();

        expect(results.stats.outcomes.total).toBe(25);
        expect(results.stopReason).toBe(FuzzStopReason.MAXTESTS);
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

      it("posts periodic status bar updates if 200ms elapses without a new update", async () => {
        const tmpdir = fs.mkdtempSync(
          path.join(os.tmpdir(), `nanofuzz-update-${engine}-`)
        );
        const tsFile = path.join(tmpdir, "slowTarget.ts");
        fs.writeFileSync(
          tsFile,
          `
          export function slowFn(x: number): number {
            const start = Date.now();
            while (Date.now() - start < 350) {}
            return x;
          }
          `
        );

        const updates: FuzzBusyStatusMessage[] = [];
        try {
          await FuzzerFactory(
            tsFile,
            "slowFn",
            {
              ...intOptions,
              maxTests: 2,
              fnTimeout: 1000,
            },
            { engine }
          ).test(undefined, { gen: true }, (payload) => {
            updates.push({ ...payload });
          });

          const statusUpdates = updates.filter(
            (u) => u.type === "testing" || u.type === "progress-tick"
          );
          expect(statusUpdates.length).toBeGreaterThan(2);
          expect(
            statusUpdates.every((u) => typeof u.pct === "number")
          ).toBeTrue();
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
            while (Date.now() - start < 40) {}
            return x;
          }
          `
        );

        const options = {
          ...intOptions,
          maxTests: 50,
          suiteTimeout: 300,
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
