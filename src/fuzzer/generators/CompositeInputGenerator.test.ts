import { CompositeInputGenerator } from "./CompositeInputGenerator";
import { Leaderboard } from "./Leaderboard";
import { FuzzStopReason, FuzzTestResults, FuzzTestStats } from "../Fuzzer";
import * as ProgramFactory from "../analysis/ProgramFactory";
import { ArgDef } from "../analysis/ArgDef";
import { FuzzOptions, InputAndSource } from "../Types";
import * as Config from "../../Config";

describe("src/fuzzer/generators/CompositeInputGenerator:", () => {
  it("checkpoint stats not tracked by default", async () => {
    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];

    const genStats: FuzzTestStats["generators"] = {
      RandomInputGenerator: {
        counters: { inputsGenerated: 0, dupesGenerated: 0 },
        timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
      },
      MutationInputGenerator: {
        counters: { inputsGenerated: 0, dupesGenerated: 0 },
        timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
      },
      AiInputGenerator: {
        counters: { inputsGenerated: 0, dupesGenerated: 0 },
        timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
      },
    };

    const options = {
      RandomInputGenerator: { enabled: true },
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: false },
    };

    const leaderboard = new Leaderboard<InputAndSource>();
    const allInputs = new Map<string, unknown>();

    const cig = new CompositeInputGenerator(
      options,
      fnDef,
      "test-seed",
      [],
      leaderboard,
      genStats,
      allInputs
    );

    cig.onRunStart(true);
    cig.next();

    const mockFuzzOptions: FuzzOptions = {
      argDefaults: ArgDef.getDefaultOptions(),
      measures: {
        FailedTestMeasure: { enabled: true, weight: 1 },
        CoverageMeasure: { enabled: false, weight: 0 },
      },
      generators: options,
      maxTests: 100,
      fnTimeout: 1000,
      suiteTimeout: 10000,
      seed: "test-seed",
      maxDupeInputs: 100,
      maxFailures: 0,
      useImplicit: true,
      useHuman: false,
      useProperty: true,
      useTransformer: false,
    };

    const mockResults: FuzzTestResults = {
      toolVersion: "test",
      env: {
        options: mockFuzzOptions,
        function: fnDef,
        validators: [],
        transformers: [],
      },
      results: [],
      interesting: { inputs: [] },
      stopReason: FuzzStopReason.MAXTESTS,
      stats: {
        timers: {
          total: 0,
          compile: 0,
          put: 0,
          val: 0,
          gen: 0,
          transform: 0,
          measure: 0,
        },
        counters: {
          testingRuns: 1,
          inputsGenerated: 1,
          dupesGenerated: 0,
          inputsInjected: 0,
          erroredTests: 0,
          passedTests: 1,
          inputsSkipped: 0,
          failedTests: 0,
        },
        generators: genStats,
        measures: {},
      },
    };

    await cig.onRunEnd(mockResults);

    const cigStats = mockResults.stats.generators.CompositeInputGenerator;
    expect(cigStats).toBeDefined();
    expect(cigStats?.checkpoints).toEqual([]);
  });

  it("checkpoint stats tracked if enabled", async () => {
    Config.override("nanofuzz.generators.compositeTrackCheckpoints", true);
    try {
      const program = ProgramFactory.fromSource(
        () => `export function dummyFn(x: number) {}`,
        "typescript"
      );
      const fnDef = program.functionsExported["dummyFn"];

      const genStats: FuzzTestStats["generators"] = {
        RandomInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0 },
          timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
        },
        MutationInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0 },
          timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
        },
        AiInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0 },
          timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
        },
      };

      const options = {
        RandomInputGenerator: { enabled: true },
        MutationInputGenerator: { enabled: false },
        AiInputGenerator: { enabled: false },
      };

      const leaderboard = new Leaderboard<InputAndSource>();
      const allInputs = new Map<string, unknown>();

      const cig = new CompositeInputGenerator(
        options,
        fnDef,
        "test-seed",
        [],
        leaderboard,
        genStats,
        allInputs
      );

      cig.onRunStart(true);

      // Generating inputs triggers _selectNextSubGen
      expect(cig.nextable()).toBeTrue();
      const input1 = cig.next();
      expect(input1).toBeDefined();

      const mockFuzzOptions: FuzzOptions = {
        argDefaults: ArgDef.getDefaultOptions(),
        measures: {
          FailedTestMeasure: { enabled: true, weight: 1 },
          CoverageMeasure: { enabled: false, weight: 0 },
        },
        generators: options,
        maxTests: 100,
        fnTimeout: 1000,
        suiteTimeout: 10000,
        seed: "test-seed",
        maxDupeInputs: 100,
        maxFailures: 0,
        useImplicit: true,
        useHuman: false,
        useProperty: true,
        useTransformer: false,
      };

      const mockResults: FuzzTestResults = {
        toolVersion: "test",
        env: {
          options: mockFuzzOptions,
          function: fnDef,
          validators: [],
          transformers: [],
        },
        results: [],
        interesting: { inputs: [] },
        stopReason: FuzzStopReason.MAXTESTS,
        stats: {
          timers: {
            total: 0,
            compile: 0,
            put: 0,
            val: 0,
            gen: 0,
            transform: 0,
            measure: 0,
          },
          counters: {
            testingRuns: 1,
            inputsGenerated: 1,
            dupesGenerated: 0,
            inputsInjected: 0,
            erroredTests: 0,
            passedTests: 1,
            inputsSkipped: 0,
            failedTests: 0,
          },
          generators: genStats,
          measures: {},
        },
      };

      await cig.onRunEnd(mockResults);

      const cigStats = mockResults.stats.generators.CompositeInputGenerator;
      expect(cigStats).toBeDefined();
      expect(cigStats?.checkpoints).toBeDefined();
      expect(cigStats?.checkpoints.length).toBeGreaterThan(0);

      const firstCheckpoint = cigStats?.checkpoints[0];
      expect(firstCheckpoint?.tick).toBeDefined();
      expect(firstCheckpoint?.gens.RandomInputGenerator).toBeDefined();
      expect(typeof firstCheckpoint?.gens.RandomInputGenerator.nextable).toBe(
        "boolean"
      );
      expect(
        typeof firstCheckpoint?.gens.RandomInputGenerator.productivity
      ).toBe("number");
      expect(typeof firstCheckpoint?.gens.RandomInputGenerator.cost).toBe(
        "number"
      );
    } finally {
      Config.override("nanofuzz.generators.compositeTrackCheckpoints", false);
    }
  });

  it("rotates subgens after chunkSize generated inputs", async () => {
    Config.override("nanofuzz.generators.compositeTrackCheckpoints", true);
    try {
      const program = ProgramFactory.fromSource(
        () => `export function dummyFn(x: number) {}`,
        "typescript"
      );
      const fnDef = program.functionsExported["dummyFn"];

      const genStats: FuzzTestStats["generators"] = {
        RandomInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0 },
          timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
        },
        MutationInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0 },
          timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
        },
        AiInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0 },
          timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
        },
      };

      const options = {
        RandomInputGenerator: { enabled: true },
        MutationInputGenerator: { enabled: false },
        AiInputGenerator: { enabled: false },
      };

      const leaderboard = new Leaderboard<InputAndSource>();
      const allInputs = new Map<string, unknown>();

      const cig = new CompositeInputGenerator(
        options,
        fnDef,
        "test-seed",
        [],
        leaderboard,
        genStats,
        allInputs
      );

      cig.onRunStart(true);

      const chunkSize = 20;
      for (let i = 0; i < chunkSize * 2; i++) {
        cig.next();
      }

      const mockFuzzOptions: FuzzOptions = {
        argDefaults: ArgDef.getDefaultOptions(),
        measures: {
          FailedTestMeasure: { enabled: true, weight: 1 },
          CoverageMeasure: { enabled: false, weight: 0 },
        },
        generators: options,
        maxTests: 100,
        fnTimeout: 1000,
        suiteTimeout: 10000,
        seed: "test-seed",
        maxDupeInputs: 100,
        maxFailures: 0,
        useImplicit: true,
        useHuman: false,
        useProperty: true,
        useTransformer: false,
      };

      const mockResults: FuzzTestResults = {
        toolVersion: "test",
        env: {
          options: mockFuzzOptions,
          function: fnDef,
          validators: [],
          transformers: [],
        },
        results: [],
        interesting: { inputs: [] },
        stopReason: FuzzStopReason.MAXTESTS,
        stats: {
          timers: {
            total: 0,
            compile: 0,
            put: 0,
            val: 0,
            gen: 0,
            transform: 0,
            measure: 0,
          },
          counters: {
            testingRuns: 1,
            inputsGenerated: chunkSize * 2,
            dupesGenerated: 0,
            inputsInjected: 0,
            erroredTests: 0,
            passedTests: chunkSize * 2,
            inputsSkipped: 0,
            failedTests: 0,
          },
          generators: genStats,
          measures: {},
        },
      };

      await cig.onRunEnd(mockResults);

      const cigStats = mockResults.stats.generators.CompositeInputGenerator;
      expect(cigStats?.checkpoints.length).toBe(2);
      expect(cigStats?.checkpoints[0].tick).toBe(1);
      expect(cigStats?.checkpoints[1].tick).toBe(chunkSize + 1);
    } finally {
      Config.override("nanofuzz.generators.compositeTrackCheckpoints", false);
    }
  });
});
