import { Tester as TesterV1, FuzzStopReason, FuzzTestResults } from "./Fuzzer";
import { FuzzerV2 as TesterV2 } from "./FuzzerV2";
import { FuzzerFactory } from "./FuzzerFactory";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { getToolVersion } from "../ToolVersion";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as JSONN from "../Jsonn";

describe("fuzzer V2: general & parity tests", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("TesterFactory instantiates V1 or V2 based on engine option", () => {
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

  it("includes the tool version in initialized and persisted results", async () => {
    const tmpdir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-v2-version-")
    );
    const outputFile = path.join(tmpdir, "results.json5");

    try {
      const results = await new TesterV2(
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
        // Ignore cleanup errors
      }
    }
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
    ).testSync();

    const resultsV2 = await new TesterV2(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    ).testSync();

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
    ).testSync();

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
    ).testSync(injected);

    const resultsV2 = await new TesterV2(
      "nanofuzz-study/examples/1.ts",
      "minValue",
      options
    ).testSync(injected);

    expect(resultsV2.stats.counters.inputsInjected).toBe(1);
    expect(resultsV1.stats.counters.inputsInjected).toBe(1);
    expect(resultsV2.results[0].pinned).toBe(true);
    expect<unknown>(resultsV2.results[0].input[0].value).toBe(42);
    expect<unknown>(resultsV2.results[0].input[1].value).toBe(99);
  });

  it("async test run with callback", async () => {
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

    const completed = new Promise<FuzzTestResults>((resolve, reject) => {
      tester.testAsync([], { gen: true }, (res) => {
        if (res instanceof Error) {
          reject(res);
        } else {
          resolve(res);
        }
      });
    });

    const results = await completed;
    expect(results.stats.outcomes.total).toBe(15);
    expect(results.stopReason).toBe(FuzzStopReason.MAXTESTS);
  });
});
