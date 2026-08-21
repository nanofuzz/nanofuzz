import { CompositeInputGenerator } from "./CompositeInputGenerator";
import { Leaderboard } from "./Leaderboard";
import { FuzzStopReason, FuzzTestResults, FuzzTestStats } from "../Fuzzer";
import * as ProgramFactory from "../analysis/ProgramFactory";
import { ArgDef } from "../analysis/ArgDef";
import { FuzzOptions, InputAndSource } from "../Types";

describe("src/fuzzer/generators/CompositeInputGenerator:", () => {
  it("builds checkpoints during _selectNextSubGen and populates them onRunEnd", async () => {
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
    expect(typeof firstCheckpoint?.gens.RandomInputGenerator.productivity).toBe(
      "number"
    );
    expect(typeof firstCheckpoint?.gens.RandomInputGenerator.cost).toBe(
      "number"
    );
  });
});
