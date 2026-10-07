import { CompositeInputGenerator } from "./CompositeInputGenerator";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { Leaderboard } from "./Leaderboard";
import {
  FuzzOptions,
  FuzzStopReason,
  FuzzTestResults,
  FuzzTestStats,
  InputAndSource,
} from "../Types";
import * as ProgramFactory from "../analysis/ProgramFactory";
import { ArgDef } from "../analysis/ArgDef";
import { FunctionDef } from "../analysis/FunctionDef";
import { NextableStatus } from "./Types";
import { AbstractRunner, RunnerResult } from "../runners/AbstractRunner";
import * as Config from "../../Config";

function createGenStats(): FuzzTestStats["generators"] {
  return {
    RandomInputGenerator: {
      counters: { inputsGenerated: 0, dupesGenerated: 0, dupeTicks: [] },
      timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
    },
    MutationInputGenerator: {
      counters: { inputsGenerated: 0, dupesGenerated: 0, dupeTicks: [] },
      timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
    },
    AiInputGenerator: {
      counters: { inputsGenerated: 0, dupesGenerated: 0, dupeTicks: [] },
      timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
    },
    UserInputGenerator: {
      counters: { inputsGenerated: 0, dupesGenerated: 0, dupeTicks: [] },
      timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
    },
  };
}

function createGenOptions(
  overrides: Partial<FuzzOptions["generators"]> = {}
): FuzzOptions["generators"] {
  return {
    RandomInputGenerator: { enabled: true },
    MutationInputGenerator: { enabled: false },
    AiInputGenerator: { enabled: false },
    UserInputGenerator: { enabled: false },
    ...overrides,
  };
}

describe("src/fuzzer/generators/CompositeInputGenerator:", () => {
  it("checkpoint stats not tracked by default", async () => {
    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];

    const genStats = createGenStats();
    const options = createGenOptions();

    const leaderboard = new Leaderboard<InputAndSource>();
    const allInputs = new Map<string, unknown>();

    const cig = new CompositeInputGenerator(
      options,
      fnDef,
      "test-seed",
      [],
      leaderboard,
      genStats,
      allInputs,
      program.src
    );

    cig.onRunStart(true, [], undefined, 200, 1000);
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
      workers: "auto",
    };

    const mockResults: FuzzTestResults = {
      toolVersion: "test",
      env: {
        options: mockFuzzOptions,
        function: fnDef,
        validators: [],
        transformers: [],
        userGenerators: [],
      },
      results: [],
      interesting: { inputs: [] },
      stopReason: FuzzStopReason.MAXTESTS,
      stats: {
        timers: {
          total: 0,
          compile: 0,
          instrument: 0,
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
        outcomes: {
          total: 0,
          oracles: {
            heuristic: {
              pass: 0,
              fail: 0,
              unknown: 0,
            },
            human: {
              fail: 0,
              unknown: 0,
              pass: 0,
            },
            property: {
              fail: 0,
              unknown: 0,
              pass: 0,
            },
          },
          exceptions: 0,
          timeouts: 0,
          categories: {
            ok: 0,
            badValue: 0,
            timeout: 0,
            exception: 0,
            skip: 0,
            disagree: 0,
            failure: 0,
          },
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

      const genStats = createGenStats();
      const options = createGenOptions();

      const leaderboard = new Leaderboard<InputAndSource>();
      const allInputs = new Map<string, unknown>();

      const cig = new CompositeInputGenerator(
        options,
        fnDef,
        "test-seed",
        [],
        leaderboard,
        genStats,
        allInputs,
        program.src
      );

      cig.onRunStart(true, [], undefined, 200, 1000);

      // Generating inputs triggers _selectNextSubGen
      expect(cig.nextable()).toBeTruthy();
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
        workers: "auto",
      };

      const mockResults: FuzzTestResults = {
        toolVersion: "test",
        env: {
          options: mockFuzzOptions,
          function: fnDef,
          validators: [],
          transformers: [],
          userGenerators: [],
        },
        results: [],
        interesting: { inputs: [] },
        stopReason: FuzzStopReason.MAXTESTS,
        stats: {
          timers: {
            total: 0,
            compile: 0,
            instrument: 0,
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
          outcomes: {
            total: 0,
            oracles: {
              heuristic: {
                pass: 0,
                fail: 0,
                unknown: 0,
              },
              human: {
                fail: 0,
                unknown: 0,
                pass: 0,
              },
              property: {
                fail: 0,
                unknown: 0,
                pass: 0,
              },
            },
            exceptions: 0,
            timeouts: 0,
            categories: {
              ok: 0,
              badValue: 0,
              timeout: 0,
              exception: 0,
              skip: 0,
              disagree: 0,
              failure: 0,
            },
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
        "string"
      );
      expect(
        typeof firstCheckpoint?.gens.RandomInputGenerator.productivity
      ).toBe("number");
      expect(typeof firstCheckpoint?.gens.RandomInputGenerator.cost).toBe(
        "number"
      );
      expect(firstCheckpoint?.gens.RandomInputGenerator.selected).toBeTrue();
    } finally {
      Config.override("nanofuzz.generators.compositeTrackCheckpoints", false);
    }
  });

  it("rotates subgens after chunkSize generated inputs", async () => {
    Config.override("nanofuzz.generators.compositeTrackCheckpoints", true);
    try {
      const program = ProgramFactory.fromSource(
        () => `export function dummyFn(x: string) {}`,
        "typescript"
      );
      const fnDef = program.functionsExported["dummyFn"];

      const genStats = createGenStats();
      const options = createGenOptions();

      const leaderboard = new Leaderboard<InputAndSource>();
      const allInputs = new Map<string, unknown>();

      const cig = new CompositeInputGenerator(
        options,
        fnDef,
        "test-seed",
        [],
        leaderboard,
        genStats,
        allInputs,
        program.src
      );

      cig.onRunStart(true, [], undefined, 200, 1000);

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
        workers: "auto",
      };

      const mockResults: FuzzTestResults = {
        toolVersion: "test",
        env: {
          options: mockFuzzOptions,
          function: fnDef,
          validators: [],
          transformers: [],
          userGenerators: [],
        },
        results: [],
        interesting: { inputs: [] },
        stopReason: FuzzStopReason.MAXTESTS,
        stats: {
          timers: {
            total: 0,
            compile: 0,
            instrument: 0,
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
          outcomes: {
            total: 0,
            oracles: {
              heuristic: {
                pass: 0,
                fail: 0,
                unknown: 0,
              },
              human: {
                fail: 0,
                unknown: 0,
                pass: 0,
              },
              property: {
                fail: 0,
                unknown: 0,
                pass: 0,
              },
            },
            exceptions: 0,
            timeouts: 0,
            categories: {
              ok: 0,
              badValue: 0,
              timeout: 0,
              exception: 0,
              skip: 0,
              disagree: 0,
              failure: 0,
            },
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

  it("scheduler selection and toggling between runs (mab, random, round-robin)", async () => {
    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];

    const genStats = createGenStats();
    const options = createGenOptions({
      MutationInputGenerator: { enabled: true },
    });

    const leaderboard = new Leaderboard<InputAndSource>();
    const allInputs = new Map<string, unknown>();

    const cig = new CompositeInputGenerator(
      options,
      fnDef,
      "test-seed",
      [],
      leaderboard,
      genStats,
      allInputs,
      program.src
    );

    try {
      // Run 1: mab (default)
      Config.override("nanofuzz.generators.scheduler.impl", "mab");
      cig.onRunStart(true, [], undefined, 200, 1000);
      expect(cig.scheduler.type).toBe("mab");
      expect(cig.nextable()).toBeTruthy();
      const inputRun1 = cig.next();
      expect(inputRun1).toBeDefined();

      // Run 2: switch to random
      Config.override("nanofuzz.generators.scheduler.impl", "random");
      cig.onRunStart(true, [], undefined, 200, 1000);
      expect(cig.scheduler.type).toBe("random");
      expect(cig.nextable()).toBeTruthy();
      const inputRun2 = cig.next();
      expect(inputRun2).toBeDefined();

      // Run 3: switch to round-robin
      Config.override("nanofuzz.generators.scheduler.impl", "round-robin");
      cig.onRunStart(true, [], undefined, 200, 1000);
      expect(cig.scheduler.type).toBe("round-robin");
      expect(cig.nextable()).toBeTruthy();
      const inputRun3 = cig.next();
      expect(inputRun3).toBeDefined();

      // Run 4: switch to ucb1
      Config.override("nanofuzz.generators.scheduler.impl", "ucb1");
      cig.onRunStart(true, [], undefined, 200, 1000);
      expect(cig.scheduler.type).toBe("ucb1");
      expect(cig.nextable()).toBeTruthy();
      const inputRun4 = cig.next();
      expect(inputRun4).toBeDefined();

      // Run 5: switch to thompson
      Config.override("nanofuzz.generators.scheduler.impl", "thompson");
      cig.onRunStart(true, [], undefined, 200, 1000);
      expect(cig.scheduler.type).toBe("thompson");
      expect(cig.nextable()).toBeTruthy();
      const inputRun5 = cig.next();
      expect(inputRun5).toBeDefined();

      // Run 6: switch to ewma
      Config.override("nanofuzz.generators.scheduler.impl", "ewma");
      cig.onRunStart(true, [], undefined, 200, 1000);
      expect(cig.scheduler.type).toBe("ewma");
      expect(cig.nextable()).toBeTruthy();
      const inputRun6 = cig.next();
      expect(inputRun6).toBeDefined();

      // Run 7: switch to mopt
      Config.override("nanofuzz.generators.scheduler.impl", "mopt");
      cig.onRunStart(true, [], undefined, 200, 1000);
      expect(cig.scheduler.type).toBe("mopt");
      expect(cig.nextable()).toBeTruthy();
      const inputRun7 = cig.next();
      expect(inputRun7).toBeDefined();
    } finally {
      Config.override("nanofuzz.generators.scheduler.impl", "mab");
    }
  });

  it("accumulates checkpoints across runs when scheduler changes in between runs", async () => {
    Config.override("nanofuzz.generators.compositeTrackCheckpoints", true);
    try {
      const program = ProgramFactory.fromSource(
        () => `export function dummyFn(x: number) {}`,
        "typescript"
      );
      const fnDef = program.functionsExported["dummyFn"];

      const genStats = createGenStats();
      const options = createGenOptions({
        MutationInputGenerator: { enabled: true },
      });

      const leaderboard = new Leaderboard<InputAndSource>();
      const allInputs = new Map<string, unknown>();

      const cig = new CompositeInputGenerator(
        options,
        fnDef,
        "test-seed",
        [],
        leaderboard,
        genStats,
        allInputs,
        program.src
      );

      // Run 1 with MAB
      Config.override("nanofuzz.generators.scheduler.impl", "mab");
      cig.onRunStart(true, [], undefined, 200, 1000);
      cig.next();

      // Run 2 with Round-Robin
      Config.override("nanofuzz.generators.scheduler.impl", "round-robin");
      cig.onRunStart(true, [], undefined, 200, 1000);
      cig.next();

      const mockFuzzOptions: FuzzOptions = {
        argDefaults: ArgDef.getDefaultOptions(),
        measures: {
          FailedTestMeasure: { enabled: true, weight: 1 },
          CoverageMeasure: { enabled: false, weight: 0 },
        },
        generators: options,
        maxTests: 10,
        fnTimeout: 1000,
        suiteTimeout: 10000,
        seed: "test-seed",
        maxDupeInputs: 100,
        maxFailures: 0,
        useImplicit: true,
        useHuman: false,
        useProperty: true,
        useTransformer: false,
        workers: "auto",
      };

      const mockResults: FuzzTestResults = {
        toolVersion: "test",
        env: {
          options: mockFuzzOptions,
          function: fnDef,
          validators: [],
          transformers: [],
          userGenerators: [],
        },
        results: [],
        interesting: { inputs: [] },
        stopReason: FuzzStopReason.MAXTESTS,
        stats: {
          timers: {
            total: 0,
            compile: 0,
            instrument: 0,
            put: 0,
            val: 0,
            gen: 0,
            transform: 0,
            measure: 0,
          },
          counters: {
            testingRuns: 2,
            inputsGenerated: 2,
            dupesGenerated: 0,
            inputsInjected: 0,
            erroredTests: 0,
            passedTests: 2,
            inputsSkipped: 0,
            failedTests: 0,
          },
          outcomes: {
            total: 0,
            oracles: {
              heuristic: {
                pass: 0,
                fail: 0,
                unknown: 0,
              },
              human: {
                fail: 0,
                unknown: 0,
                pass: 0,
              },
              property: {
                fail: 0,
                unknown: 0,
                pass: 0,
              },
            },
            exceptions: 0,
            timeouts: 0,
            categories: {
              ok: 0,
              badValue: 0,
              timeout: 0,
              exception: 0,
              skip: 0,
              disagree: 0,
              failure: 0,
            },
          },
          generators: genStats,
          measures: {},
        },
      };

      await cig.onRunEnd(mockResults);

      const checkpoints =
        mockResults.stats.generators.CompositeInputGenerator?.checkpoints;
      expect(checkpoints).toBeDefined();
      expect(checkpoints?.length).toBe(2);
      expect(checkpoints?.[0].scheduler).toBe("mab");
      expect(checkpoints?.[1].scheduler).toBe("round-robin");
    } finally {
      Config.override("nanofuzz.generators.compositeTrackCheckpoints", false);
      Config.override("nanofuzz.generators.scheduler.impl", "mab");
    }
  });

  it("nextable: 'now' when an input is immediately available", () => {
    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();
    const options = createGenOptions();

    const cig = new CompositeInputGenerator(
      options,
      fnDef,
      "seed",
      [],
      new Leaderboard<InputAndSource>(),
      genStats,
      new Map(),
      program.src
    );

    cig.onRunStart(true, [], undefined, 200, 1000);
    // Tri-state expectation: 'now' (or truthy 'now')
    expect(cig.nextable()).toBe("now");
  });

  it("nextable: 'soon' when no input is ready now, but async input generation is pending", () => {
    class SoonCompositeInputGenerator extends CompositeInputGenerator {
      public setSubgenSoon(name: string): void {
        const idx = this._subgens.findIndex((g) => g.name === name);
        this._subgens[idx].nextable = () => "soon";
      }
    }

    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();
    const options = createGenOptions({
      RandomInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: true },
    });

    const cig = new SoonCompositeInputGenerator(
      options,
      fnDef,
      "seed",
      [],
      new Leaderboard<InputAndSource>(),
      genStats,
      new Map(),
      program.src
    );

    cig.onRunStart(true, [], undefined, 200, 1000);
    cig.setSubgenSoon("AiInputGenerator"); // Set AI generator to 'soon'
    expect(cig.nextable()).toBe("soon");
  });

  it("nextable: `false` when all active subgens are exhausted or disabled", () => {
    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();
    const options = createGenOptions({
      RandomInputGenerator: { enabled: false },
    });

    const cig = new CompositeInputGenerator(
      options,
      fnDef,
      "seed",
      [],
      new Leaderboard<InputAndSource>(),
      genStats,
      new Map(),
      program.src
    );

    cig.onRunStart(true, [], undefined, 200, 1000);
    expect(cig.nextable()).toBe(false);
  });

  it("nextable: waits asynch while status is 'soon'", async () => {
    class SoonCompositeInputGenerator extends CompositeInputGenerator {
      public setSubgenSoonThenNow(name: string): void {
        let status: NextableStatus = "soon";
        const idx = this._subgens.findIndex((g) => g.name === name);
        this._subgens[idx].nextable = () => status;
        this._subgens[idx].nextSoon = async () => {
          status = "now";
          return {
            tick: 1,
            value: [],
            source: {
              type: "generator",
              generator: "AiInputGenerator",
              model: "test",
            },
          };
        };
      }
    }

    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();
    const options = createGenOptions({
      RandomInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: true },
    });

    const cig = new SoonCompositeInputGenerator(
      options,
      fnDef,
      "seed",
      [],
      new Leaderboard<InputAndSource>(),
      genStats,
      new Map(),
      program.src
    );

    cig.onRunStart(true, [], undefined, 200, 1000);
    cig.setSubgenSoonThenNow("AiInputGenerator");

    const result = await cig.waitForNextInput();
    expect(result).toBeTrue();
  });

  it("getPendingGeneratorNames human-readable labe", () => {
    class SoonCompositeInputGenerator extends CompositeInputGenerator {
      public setSubgenSoon(name: string): void {
        const idx = this._subgens.findIndex((g) => g.name === name);
        this._subgens[idx].nextable = () => "soon";
      }
    }

    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();
    const options = createGenOptions({
      RandomInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: true },
    });

    const cig = new SoonCompositeInputGenerator(
      options,
      fnDef,
      "seed",
      [],
      new Leaderboard<InputAndSource>(),
      genStats,
      new Map(),
      program.src
    );

    cig.onRunStart(true, [], undefined, 200, 1000);
    cig.setSubgenSoon("AiInputGenerator");

    expect(cig.getPendingGeneratorNames()).toEqual(["AI"]);
  });

  it("waitForNextInput: respects timeoutMs on 'soon'", async () => {
    class NeverReadyCompositeInputGenerator extends CompositeInputGenerator {
      public setSubgenNeverReady(name: string): void {
        const idx = this._subgens.findIndex((g) => g.name === name);
        this._subgens[idx].nextable = () => "soon";
        this._subgens[idx].nextSoon = async () => {
          await new Promise((r) => setTimeout(r, 5000));
          return {
            tick: 1,
            value: [],
            source: {
              type: "generator",
              generator: "AiInputGenerator",
              model: "test",
            },
          };
        };
      }
    }

    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();
    const options = createGenOptions({
      RandomInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: true },
    });

    const cig = new NeverReadyCompositeInputGenerator(
      options,
      fnDef,
      "seed",
      [],
      new Leaderboard<InputAndSource>(),
      genStats,
      new Map(),
      program.src
    );

    cig.onRunStart(true, [], undefined, 200, 1000);
    cig.setSubgenNeverReady("AiInputGenerator");

    const start = performance.now();
    const result = await cig.waitForNextInput(100);
    const elapsed = performance.now() - start;

    expect(result).toBeFalse();
    expect(elapsed).toBeLessThan(1000);
  });

  it("subgen selection ignores `soon` subgens", async () => {
    class SoonPendingCompositeInputGenerator extends CompositeInputGenerator {
      public testSelectNextSubGen(): number {
        return this._selectNextSubGen();
      }
      public setSubgenSoon(name: string): void {
        const idx = this._subgens.findIndex((g) => g.name === name);
        this._subgens[idx].nextable = () => "soon";
      }
    }

    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();
    const options = createGenOptions({
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: true },
    });

    const cig = new SoonPendingCompositeInputGenerator(
      options,
      fnDef,
      "seed",
      [],
      new Leaderboard<InputAndSource>(),
      genStats,
      new Map(),
      program.src
    );

    cig.onRunStart(true, [], undefined, 200, 1000);
    cig.setSubgenSoon("AiInputGenerator"); // AI generator is "soon"

    expect(() => cig.testSelectNextSubGen()).not.toThrow();
    const randomIdx = cig["_subgens"].findIndex(
      (g) => g.name === "RandomInputGenerator"
    );
    expect(cig.testSelectNextSubGen()).toBe(randomIdx); // RandomInputGenerator selected
  });

  it("prioritize 'now!' over 'now' or 'soon'", () => {
    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();
    const options = createGenOptions();

    const cig = new CompositeInputGenerator(
      options,
      fnDef,
      "seed",
      [],
      new Leaderboard<InputAndSource>(),
      genStats,
      new Map(),
      program.src
    );

    cig.onRunStart(
      true,
      [
        {
          value: [{ tag: "ArgValueTypeWrapped", value: 999 }],
          source: { type: "user" },
          injected: true,
        },
      ],
      undefined,
      200,
      1000
    );

    expect(cig.nextable()).toBe("now!");

    const first = cig.next();
    expect(first.injected).toBeTrue();
    expect<unknown>(first.value).toEqual([
      { tag: "ArgValueTypeWrapped", value: 999 },
    ]);

    // After human input is drained, status returns to "now" from RandomInputGenerator
    expect(cig.nextable()).toBe("now");
  });

  it("next() throws if an input transformer is configured", () => {
    class MockTransformerRunner extends AbstractRunner {
      public override async run(): Promise<RunnerResult> {
        return {
          result: { tag: "value", value: [1], seq: 0 },
          env: {},
        };
      }
      public override killHost(): void {
        // No-op
      }
    }

    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();

    const cig = new CompositeInputGenerator(
      createGenOptions(),
      fnDef,
      "seed",
      [],
      new Leaderboard<InputAndSource>(),
      genStats,
      new Map(),
      program.src
    );

    const mockTransformerRunner = new MockTransformerRunner("dummyTransformer");

    cig.onRunStart(true, [], mockTransformerRunner, 200, 1000);

    expect(() => cig.next()).toThrowMatching(
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes(
          "CompositeInputGenerator.next() cannot be called when an input transformer is configured"
        )
    );
  });

  it("decrements chunk ticks on duplicates and rotates to next subgen after chunkSize attempts", () => {
    class ConstantGenerator extends AbstractInputGenerator {
      public constructor(specs: ArgDef[], rngSeed?: string) {
        super(specs, rngSeed);
      }
      public override nextable(): NextableStatus {
        return "now";
      }
      public override next(): InputAndSource {
        return {
          tick: 0,
          value: [{ tag: "ArgValueTypeWrapped", value: "constant_val" }],
          source: { type: "generator", generator: "RandomInputGenerator" },
        };
      }
    }

    class UniqueGenerator extends AbstractInputGenerator {
      private _seq = 0;
      public constructor(specs: ArgDef[], rngSeed?: string) {
        super(specs, rngSeed);
      }
      public override nextable(): NextableStatus {
        return "now";
      }
      public override next(): InputAndSource {
        return {
          tick: 0,
          value: [
            { tag: "ArgValueTypeWrapped", value: `unique_${this._seq++}` },
          ],
          source: {
            type: "generator",
            generator: "MutationInputGenerator",
            steps: { taken: 1, max: 10, mode: "mutate", mutators: ["num"] },
          },
        };
      }
    }

    class TestChunkCompositeInputGenerator extends CompositeInputGenerator {
      public constructor(
        fnDef: FunctionDef,
        genStats: FuzzTestStats["generators"],
        allInputs: Map<string, unknown>,
        src: string
      ) {
        super(
          createGenOptions({
            MutationInputGenerator: { enabled: true },
          }),
          fnDef,
          "test-seed",
          [],
          new Leaderboard<InputAndSource>(),
          genStats,
          allInputs,
          src
        );
        this._subgens = [
          new ConstantGenerator(this._specs, this._rngSeed),
          new UniqueGenerator(this._specs, this._rngSeed),
        ];
        this._activeSubgens = [true, true];
      }

      public get selectedSubgenIndex(): number {
        return this._selectedSubgenIndex;
      }
      public get ticksLeftInChunk(): number {
        return this._ticksLeftInChunk;
      }
    }

    Config.override("nanofuzz.generators.compositeChunkSize", 5);
    Config.override("nanofuzz.generators.scheduler.impl", "round-robin");
    try {
      const program = ProgramFactory.fromSource(
        () => `export function dummyFn(x: string) {}`,
        "typescript"
      );
      const fnDef = program.functionsExported["dummyFn"];
      const genStats = createGenStats();

      const allInputs = new Map<string, unknown>();
      const cig = new TestChunkCompositeInputGenerator(
        fnDef,
        genStats,
        allInputs,
        program.src
      );

      cig.onRunStart(true, [], undefined, 200, 100);

      // First call to next() starts Chunk 0 with ConstantGenerator (index 0).
      // It generates "constant_val" (unique, tick 1), leaving 4 ticks in chunk.
      const first = cig.next();
      expect<unknown>(first.value[0].value).toBe("constant_val");
      expect(first.tick).toBe(1);
      expect(cig.inputsGenerated).toBe(1);
      expect(cig.dupesGenerated).toBe(0);

      // Next call to next() will generate from ConstantGenerator:
      // Ticks 2, 3, 4, 5 generate "constant_val" (duplicates).
      // Each duplicate decrements ticksLeftInChunk (4 -> 3 -> 2 -> 1 -> 0).
      // When chunk is exhausted (5 attempts total for ConstantGenerator),
      // the scheduler rotates to UniqueGenerator (index 1), which generates "unique_0" (tick 6).
      const second = cig.next();
      expect<unknown>(second.value[0].value).toBe("unique_0");
      expect(second.tick).toBe(6);
      expect(cig.inputsGenerated).toBe(6);
      expect(cig.dupesGenerated).toBe(4);
      expect(genStats.RandomInputGenerator.counters.dupesGenerated).toBe(4);
      expect(genStats.RandomInputGenerator.counters.dupeTicks).toEqual([
        2, 3, 4, 5,
      ]);
    } finally {
      Config.override("nanofuzz.generators.compositeChunkSize", 20);
      Config.override("nanofuzz.generators.scheduler.impl", "mab");
    }
  });

  it("suppresses generators when sequential duplicates reach maxDupeInputs", () => {
    class ConstantGenerator extends AbstractInputGenerator {
      public constructor(specs: ArgDef[], rngSeed?: string) {
        super(specs, rngSeed);
      }
      public override nextable(): NextableStatus {
        return "now";
      }
      public override next(): InputAndSource {
        return {
          tick: 0,
          value: [{ tag: "ArgValueTypeWrapped", value: "always_same" }],
          source: { type: "generator", generator: "RandomInputGenerator" },
        };
      }
    }

    class TestMaxDupesCompositeInputGenerator extends CompositeInputGenerator {
      public constructor(
        fnDef: FunctionDef,
        genStats: FuzzTestStats["generators"],
        allInputs: Map<string, unknown>,
        src: string
      ) {
        super(
          createGenOptions(),
          fnDef,
          "test-seed",
          [],
          new Leaderboard<InputAndSource>(),
          genStats,
          allInputs,
          src
        );
        this._subgens = [new ConstantGenerator(this._specs, this._rngSeed)];
        this._activeSubgens = [true];
      }
    }

    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: string) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();

    const allInputs = new Map<string, unknown>();
    const cig = new TestMaxDupesCompositeInputGenerator(
      fnDef,
      genStats,
      allInputs,
      program.src
    );

    const maxDupes = 3;
    cig.onRunStart(true, [], undefined, 200, maxDupes);

    // First input succeeds
    const first = cig.next();
    expect<unknown>(first.value[0].value).toBe("always_same");
    expect(cig.dupesSequential).toBe(0);

    // Second call attempts to generate unique input but encounters 3 duplicates in a row.
    // It must suppress generators and throw.
    expect(() => cig.next()).toThrowMatching(
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes(
          "Injected inputs exhausted and input generators are suppressed"
        )
    );
    expect(cig.dupesSequential).toBe(maxDupes);
    expect(cig.dupesGenerated).toBe(maxDupes);
    expect(cig.nextable()).toBe(false);
  });

  it("handles injected inputs correctly and deduplicates subsequent generated inputs against them", () => {
    class MockAutonomousGen extends AbstractInputGenerator {
      private _seq = 0;
      public constructor(specs: ArgDef[], rngSeed?: string) {
        super(specs, rngSeed);
      }
      public override nextable(): NextableStatus {
        return "now";
      }
      public override next(): InputAndSource {
        const values = ["injected_val_1", "unique_gen_val"];
        const val = values[this._seq++] ?? "overflow_val";
        return {
          tick: 0,
          value: [{ tag: "ArgValueTypeWrapped", value: val }],
          source: { type: "generator", generator: "RandomInputGenerator" },
        };
      }
    }

    class TestInjectedCompositeInputGenerator extends CompositeInputGenerator {
      public constructor(
        fnDef: FunctionDef,
        genStats: FuzzTestStats["generators"],
        allInputs: Map<string, unknown>,
        src: string
      ) {
        super(
          createGenOptions(),
          fnDef,
          "test-seed",
          [],
          new Leaderboard<InputAndSource>(),
          genStats,
          allInputs,
          src
        );
        // Replace autonomous generator with MockAutonomousGen while keeping HumanInputGenerator
        const humanGen = this._subgens.find(
          (g) => g.name === "HumanInputGenerator"
        )!;
        this._subgens = [
          humanGen,
          new MockAutonomousGen(this._specs, this._rngSeed),
        ];
        this._activeSubgens = [true, true];
      }
    }

    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: string) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();

    const allInputs = new Map<string, unknown>();
    const cig = new TestInjectedCompositeInputGenerator(
      fnDef,
      genStats,
      allInputs,
      program.src
    );

    const injected: InputAndSource[] = [
      {
        tick: 0,
        value: [{ tag: "ArgValueTypeWrapped", value: "injected_val_1" }],
        source: { type: "user" },
        injected: true,
      },
      {
        tick: 0,
        value: [{ tag: "ArgValueTypeWrapped", value: "injected_val_2" }],
        source: { type: "user" },
        injected: true,
      },
    ];

    cig.onRunStart(true, injected, undefined, 200, 100);

    // 1. First two calls produce the injected inputs in order with priority
    expect(cig.nextable()).toBe("now!");
    const first = cig.next();
    expect(first.injected).toBeTrue();
    expect<unknown>(first.value[0].value).toBe("injected_val_1");
    expect(first.tick).toBe(1);

    expect(cig.nextable()).toBe("now!");
    const second = cig.next();
    expect(second.injected).toBeTrue();
    expect<unknown>(second.value[0].value).toBe("injected_val_2");
    expect(second.tick).toBe(2);

    // 2. Human inputs exhausted, status transitions to autonomous "now"
    expect(cig.nextable()).toBe("now");

    // 3. Next call to next() attempts to generate autonomously:
    //    - First candidate is "injected_val_1" (tick 3), which matches the first injected input!
    //    - CIG detects the duplicate against allInputs, records dupeTick 3 in RandomInputGenerator,
    //      and continues to candidate 2 ("unique_gen_val", tick 4).
    const third = cig.next();
    expect(third.injected).toBeUndefined();
    expect<unknown>(third.value[0].value).toBe("unique_gen_val");
    expect(third.tick).toBe(4);
    expect(cig.dupesGenerated).toBe(1);
    expect(genStats.RandomInputGenerator.counters.dupesGenerated).toBe(1);
    expect(genStats.RandomInputGenerator.counters.dupeTicks).toEqual([3]);
  });

  it("injected inputs do not populate _pretransformedInputs and do not block raw generator candidates", async () => {
    class MockMultiplierTransformer extends AbstractRunner {
      public override async run(inputs: unknown[]): Promise<RunnerResult> {
        const n = typeof inputs[0] === "number" ? inputs[0] : 0;
        return {
          result: { tag: "value", value: [n * 10], seq: 0 },
          env: {},
        };
      }
      public override killHost(): void {
        // No-op
      }
    }

    class MockRawNumberGen extends AbstractInputGenerator {
      private _seq = 0;
      public constructor(specs: ArgDef[], rngSeed?: string) {
        super(specs, rngSeed);
      }
      public override nextable(): NextableStatus {
        return "now";
      }
      public override next(): InputAndSource {
        const values = [5, 6];
        const val = values[this._seq++] ?? 99;
        return {
          tick: 0,
          value: [{ tag: "ArgValueTypeWrapped", value: val }],
          source: { type: "generator", generator: "RandomInputGenerator" },
        };
      }
    }

    class TestTransformerInjectedCompositeInputGenerator extends CompositeInputGenerator {
      public constructor(
        fnDef: FunctionDef,
        genStats: FuzzTestStats["generators"],
        allInputs: Map<string, unknown>,
        src: string
      ) {
        super(
          createGenOptions(),
          fnDef,
          "test-seed",
          [],
          new Leaderboard<InputAndSource>(),
          genStats,
          allInputs,
          src
        );
        const humanGen = this._subgens.find(
          (g) => g.name === "HumanInputGenerator"
        )!;
        this._subgens = [
          humanGen,
          new MockRawNumberGen(this._specs, this._rngSeed),
        ];
        this._activeSubgens = [true, true];
      }
    }

    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats = createGenStats();

    const allInputs = new Map<string, unknown>();
    const cig = new TestTransformerInjectedCompositeInputGenerator(
      fnDef,
      genStats,
      allInputs,
      program.src
    );

    const transformerRunner = new MockMultiplierTransformer("multiplier");

    // Injected input is 5 (final/post-transformed value)
    const injected: InputAndSource[] = [
      {
        tick: 0,
        value: [{ tag: "ArgValueTypeWrapped", value: 5 }],
        source: { type: "user" },
        injected: true,
      },
    ];

    cig.onRunStart(true, injected, transformerRunner, 200, 100);

    // 1. Drain injected input (value 5)
    const first = await cig.nextTransformed();
    expect(first.injected).toBeTrue();
    expect<unknown>(first.value[0].value).toBe(5);

    // 2. Next call generates raw 5 from MockRawNumberGen.
    // Because injected 5 is NOT in _pretransformedInputs, raw 5 is NOT discarded at Stage 1.
    // It gets transformed: 5 -> 50.
    // 50 is checked against _allInputs (which contains 5). 50 is unique, so it is accepted!
    const second = await cig.nextTransformed();
    expect(second.injected).toBeUndefined();
    expect<unknown>(second.value[0].value).toBe(50);
    expect(second.source.type).toBe("transformer");
    expect(cig.dupesGenerated).toBe(0);
  });
});
