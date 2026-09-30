import { CompositeInputGenerator } from "./CompositeInputGenerator";
import { Leaderboard } from "./Leaderboard";
import { FuzzStopReason, FuzzTestResults, FuzzTestStats } from "../Fuzzer";
import * as ProgramFactory from "../analysis/ProgramFactory";
import { ArgDef } from "../analysis/ArgDef";
import { FuzzOptions, InputAndSource } from "../Types";
import { NextableStatus } from "./Types";
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
      allInputs,
      program.src
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

      const genStats: FuzzTestStats["generators"] = {
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
        allInputs,
        program.src
      );

      cig.onRunStart(true);

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
        () => `export function dummyFn(x: number) {}`,
        "typescript"
      );
      const fnDef = program.functionsExported["dummyFn"];

      const genStats: FuzzTestStats["generators"] = {
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
        allInputs,
        program.src
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

    const genStats: FuzzTestStats["generators"] = {
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
    };

    const options = {
      RandomInputGenerator: { enabled: true },
      MutationInputGenerator: { enabled: true },
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
      allInputs,
      program.src
    );

    try {
      // Run 1: mab (default)
      Config.override("nanofuzz.generators.scheduler.impl", "mab");
      cig.onRunStart(true);
      expect(cig.scheduler.type).toBe("mab");
      expect(cig.nextable()).toBeTruthy();
      const inputRun1 = cig.next();
      expect(inputRun1).toBeDefined();

      // Run 2: switch to random
      Config.override("nanofuzz.generators.scheduler.impl", "random");
      cig.onRunStart(true);
      expect(cig.scheduler.type).toBe("random");
      expect(cig.nextable()).toBeTruthy();
      const inputRun2 = cig.next();
      expect(inputRun2).toBeDefined();

      // Run 3: switch to round-robin
      Config.override("nanofuzz.generators.scheduler.impl", "round-robin");
      cig.onRunStart(true);
      expect(cig.scheduler.type).toBe("round-robin");
      expect(cig.nextable()).toBeTruthy();
      const inputRun3 = cig.next();
      expect(inputRun3).toBeDefined();

      // Run 4: switch to ucb1
      Config.override("nanofuzz.generators.scheduler.impl", "ucb1");
      cig.onRunStart(true);
      expect(cig.scheduler.type).toBe("ucb1");
      expect(cig.nextable()).toBeTruthy();
      const inputRun4 = cig.next();
      expect(inputRun4).toBeDefined();

      // Run 5: switch to thompson
      Config.override("nanofuzz.generators.scheduler.impl", "thompson");
      cig.onRunStart(true);
      expect(cig.scheduler.type).toBe("thompson");
      expect(cig.nextable()).toBeTruthy();
      const inputRun5 = cig.next();
      expect(inputRun5).toBeDefined();

      // Run 6: switch to ewma
      Config.override("nanofuzz.generators.scheduler.impl", "ewma");
      cig.onRunStart(true);
      expect(cig.scheduler.type).toBe("ewma");
      expect(cig.nextable()).toBeTruthy();
      const inputRun6 = cig.next();
      expect(inputRun6).toBeDefined();

      // Run 7: switch to mopt
      Config.override("nanofuzz.generators.scheduler.impl", "mopt");
      cig.onRunStart(true);
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

      const genStats: FuzzTestStats["generators"] = {
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
      };

      const options = {
        RandomInputGenerator: { enabled: true },
        MutationInputGenerator: { enabled: true },
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
        allInputs,
        program.src
      );

      // Run 1 with MAB
      Config.override("nanofuzz.generators.scheduler.impl", "mab");
      cig.onRunStart(true);
      cig.next();

      // Run 2 with Round-Robin
      Config.override("nanofuzz.generators.scheduler.impl", "round-robin");
      cig.onRunStart(true);
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
    const genStats: FuzzTestStats["generators"] = {
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
    };

    const options = {
      RandomInputGenerator: { enabled: true },
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: false },
    };

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

    cig.onRunStart(true);
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
    const genStats: FuzzTestStats["generators"] = {
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
    };

    // Disable Random and Mutation; Enable AI
    const options = {
      RandomInputGenerator: { enabled: false },
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: true },
    };

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

    cig.onRunStart(true);
    cig.setSubgenSoon("AiInputGenerator"); // Set AI generator to 'soon'
    expect(cig.nextable()).toBe("soon");
  });

  it("nextable: `false` when all active subgens are exhausted or disabled", () => {
    const program = ProgramFactory.fromSource(
      () => `export function dummyFn(x: number) {}`,
      "typescript"
    );
    const fnDef = program.functionsExported["dummyFn"];
    const genStats: FuzzTestStats["generators"] = {
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
    };

    // All subgens disabled
    const options = {
      RandomInputGenerator: { enabled: false },
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: false },
    };

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

    cig.onRunStart(true);
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
    const genStats: FuzzTestStats["generators"] = {
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
    };

    const options = {
      RandomInputGenerator: { enabled: false },
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: true },
    };

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

    cig.onRunStart(true);
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
    const genStats: FuzzTestStats["generators"] = {
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
    };

    const options = {
      RandomInputGenerator: { enabled: false },
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: true },
    };

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

    cig.onRunStart(true);
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
    const genStats: FuzzTestStats["generators"] = {
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
    };

    const options = {
      RandomInputGenerator: { enabled: false },
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: true },
    };

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

    cig.onRunStart(true);
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
    const genStats: FuzzTestStats["generators"] = {
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
    };

    const options = {
      RandomInputGenerator: { enabled: true },
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: true },
    };

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

    cig.onRunStart(true);
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
    const genStats: FuzzTestStats["generators"] = {
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
    };

    const options = {
      RandomInputGenerator: { enabled: true },
      MutationInputGenerator: { enabled: false },
      AiInputGenerator: { enabled: false },
    };

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

    cig.onRunStart(true, [
      {
        value: [{ tag: "ArgValueTypeWrapped", value: 999 }],
        source: { type: "user" },
        injected: true,
      },
    ]);

    expect(cig.nextable()).toBe("now!");

    const first = cig.next();
    expect(first.injected).toBeTrue();
    expect<unknown>(first.value).toEqual([
      { tag: "ArgValueTypeWrapped", value: 999 },
    ]);

    // After human input is drained, status returns to "now" from RandomInputGenerator
    expect(cig.nextable()).toBe("now");
  });
});
