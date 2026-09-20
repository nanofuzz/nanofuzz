import { Tester } from "./Fuzzer";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { getToolVersion } from "../ToolVersion";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as JSONN from "../Jsonn";

describe("fuzzer: general", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("includes the tool version in initialized and persisted results", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-version-"));
    const outputFile = path.join(tmpdir, "results.json5");

    try {
      const results = await new Tester(
        "nanofuzz-study/examples/1.ts",
        "minValue",
        { ...intOptions, maxTests: 1, outputFile }
      ).testSync();
      const persisted = JSONN.parse(fs.readFileSync(outputFile, "utf8"));

      expect(results.toolVersion).toBe(getToolVersion());
      expect(persisted).toEqual(
        jasmine.objectContaining({ toolVersion: getToolVersion() })
      );
    } finally {
      try {
        fs.rmSync(tmpdir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // Ignore residual Windows file lock cleanup errors
      }
    }
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

    const results = await new Tester(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    ).testSync();

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

    const updates: { msg: string; channel: string; pct?: number }[] = [];
    try {
      await new Tester(tsFile, "slowFn", {
        ...intOptions,
        maxTests: 2,
        fnTimeout: 1000,
      }).testSync(undefined, { gen: true }, (payload) => {
        updates.push({ ...payload });
      });

      const statusUpdates = updates.filter((u) => u.channel === "update");
      expect(statusUpdates.length).toBeGreaterThan(2);

      const example1Updates = statusUpdates.filter((u) =>
        u.msg.includes("input# 1")
      );
      expect(example1Updates.length).toBeGreaterThanOrEqual(2);
      expect(example1Updates[0].msg).toEqual(example1Updates[1].msg);
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

  it("includes test counts in waiting msg", async () => {
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

    const updates: { msg: string; channel: string; pct?: number }[] = [];
    const tester = new TestableTester(tsFile, "dummyFn", {
      ...intOptions,
      maxTests: 5,
      generators: {
        RandomInputGenerator: { enabled: false },
        MutationInputGenerator: { enabled: false },
        AiInputGenerator: { enabled: true },
      },
    });

    const cig = tester.compositeInputGenerator;
    let nextableCallCount = 0;
    spyOn(cig, "nextable").and.callFake(() => {
      nextableCallCount++;
      return nextableCallCount <= 2 ? "soon" : false;
    });
    spyOn(cig, "getPendingGeneratorNames").and.returnValue(["AI"]);

    try {
      await tester.testSync(undefined, { gen: true }, (payload) => {
        updates.push({ ...payload });
      });

      const waitUpdates = updates.filter(
        (u) =>
          u.channel === "update" &&
          u.msg.includes("Waiting for AI input generator...")
      );
      expect(waitUpdates.length).toBeGreaterThan(0);
      expect(waitUpdates[0].msg).toContain("Passed: 0");
      expect(waitUpdates[0].msg).toContain("Failed: 0");
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
