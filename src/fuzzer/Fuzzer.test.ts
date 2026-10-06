import { Tester } from "./Fuzzer";
import { FuzzBusyStatusMessage, FuzzStopReason } from "./Types";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { getToolVersion } from "../ToolVersion";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("fuzzer: general", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("includes the tool version in initialized results", async () => {
    const results = await new Tester(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      { ...intOptions, maxTests: 1 }
    ).test();

    expect(results.toolVersion).toBe(getToolVersion());
  });

  it("mutation-only fuzzing", async () => {
    const options = {
      ...intOptions,
      maxTests: 20,
      generators: {
        RandomInputGenerator: { enabled: false },
        MutationInputGenerator: { enabled: true },
        AiInputGenerator: { enabled: false },
        UserInputGenerator: { enabled: false },
      },
    };

    const results = await new Tester(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    ).test();

    expect(results.stats.outcomes.total).toBeGreaterThan(0);
    expect(results.stopReason).toBe("maxTests");
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

    const results = await new Tester(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    ).test();

    expect(results.stopReason).toBe("noMoreInputs");
  });

  it("posts periodic status bar updates if 200ms elapses without a new update", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-update-"));
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
      await new Tester(tsFile, "slowFn", {
        ...intOptions,
        maxTests: 2,
        fnTimeout: 1000,
      }).test(undefined, { gen: true }, (payload) => {
        updates.push({ ...payload });
      });

      const statusUpdates = updates.filter(
        (u) => u.type === "testing" || u.type === "progress-tick"
      );
      expect(statusUpdates.length).toBeGreaterThan(2);
      expect(statusUpdates.every((u) => typeof u.pct === "number")).toBeTrue();
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

  it("emits progress updates when waiting for async input generator", async () => {
    class TestableTester extends Tester {
      public get compositeInputGenerator() {
        return this._compositeInputGenerator;
      }
    }

    const tmpdir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-wait-update-")
    );
    const tsFile = path.join(tmpdir, "waitTarget.ts");
    fs.writeFileSync(
      tsFile,
      `
      export function dummyFn(x: number): number {
        return x;
      }
      `
    );

    const updates: FuzzBusyStatusMessage[] = [];
    const tester = new TestableTester(tsFile, "dummyFn", {
      ...intOptions,
      maxTests: 5,
      generators: {
        RandomInputGenerator: { enabled: false },
        MutationInputGenerator: { enabled: false },
        AiInputGenerator: { enabled: true },
        UserInputGenerator: { enabled: false },
      },
    });

    const cig = tester.compositeInputGenerator;
    let nextableCallCount = 0;
    spyOn(cig, "nextable").and.callFake(() => {
      nextableCallCount++;
      return nextableCallCount <= 2 ? "soon" : false;
    });
    spyOn(cig, "getPendingGeneratorNames").and.returnValue(["AI"]);
    spyOn(cig, "waitForNextInput").and.callFake(async () => {
      await new Promise((r) => setTimeout(r, 250));
      return false;
    });

    try {
      await tester.test(undefined, { gen: true }, (payload) => {
        updates.push({ ...payload });
      });

      const waitUpdates = updates.filter(
        (u) => u.type === "waiting-for-generator"
      );
      expect(waitUpdates.length).toBeGreaterThan(0);
      expect(waitUpdates.every((u) => typeof u.pct === "number")).toBeTrue();
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

  it("terminate & discard in-flight PUT executions", async () => {
    const tmpdir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-cancel-put-")
    );
    const tsFile = path.join(tmpdir, "cancelTarget.ts");
    fs.writeFileSync(
      tsFile,
      `
      export function slowTarget(x: number): number {
        const start = Date.now();
        while (Date.now() - start < 5000) {}
        return x;
      }
      `
    );

    let cancelled = false;
    setTimeout(() => {
      cancelled = true;
    }, 100);

    try {
      const tester = new Tester(tsFile, "slowTarget", {
        ...intOptions,
        maxTests: 10,
        fnTimeout: 10000,
      });

      const res = await tester.test(
        undefined,
        { gen: true },
        undefined,
        () => cancelled
      );

      expect(res.stopReason).toBe(FuzzStopReason.PAUSE);
      expect(res.stats.outcomes.total).toBe(0);
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
