import { MoptScheduler } from "./MoptScheduler";
import {
  MockInputGenerator,
  MockMeasure,
  MockMeasurement,
} from "./SchedulerTestUtils";
import * as Config from "../../Config";

describe("src/fuzzer/schedulers/MoptScheduler:", () => {
  it("properties: name, humanName, type, needsFeedback", () => {
    const scheduler = new MoptScheduler("seed");
    expect(scheduler.name).toBe("MoptScheduler");
    expect(scheduler.humanName).toBe("Mopt");
    expect(scheduler.type).toBe("mopt");
    expect(scheduler.needsFeedback).toBeTrue();
  });

  it("throws when no candidate subgens are 'now'", () => {
    const scheduler = new MoptScheduler("seed");
    const subgen = new MockInputGenerator("Gen1");
    subgen.status = "soon";

    expect(() => {
      scheduler.next({
        tick: 1,
        subgens: [subgen],
        activeSubgens: [true],
        measures: [],
      });
    }).toThrowMatching((err: Error) =>
      err.message.includes("no subgens are available")
    );
  });

  it("initializes swarm particles with valid probabilities summing to 1.0", () => {
    const scheduler = new MoptScheduler("mopt-seed-init");
    const genA = new MockInputGenerator("GenA");
    const genB = new MockInputGenerator("GenB");
    const genC = new MockInputGenerator("GenC");

    const subgens = [genA, genB, genC];
    const activeSubgens = [true, true, true];
    const measures = [new MockMeasure(1)];

    scheduler.next({ tick: 1, subgens, activeSubgens, measures });

    const particles = scheduler["_particles"];
    expect(particles.length).toBe(5); // default swarmSize

    for (const p of particles) {
      const sum = p.position.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 5);
      for (const prob of p.position) {
        expect(prob).toBeGreaterThanOrEqual(0.05); // minProb
      }
    }
  });

  it("converges toward higher-yield generator across evaluation periods", () => {
    const scheduler = new MoptScheduler("mopt-seed-converge");
    const genA = new MockInputGenerator("GenA");
    const genB = new MockInputGenerator("GenB");

    const subgens = [genA, genB];
    const activeSubgens = [true, true];
    const measures = [new MockMeasure(1)];

    Config.override("nanofuzz.generators.compositeScheduler.mopt.period", 10);
    scheduler.onRunStart();

    const feedbackA: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 100,
    };
    const feedbackB: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 0,
    };

    // Run for several periods (e.g. 10 periods of 10 ticks = 100 ticks)
    for (let tick = 1; tick <= 100; tick++) {
      const selected = scheduler.next({
        tick,
        subgens,
        activeSubgens,
        measures,
      });
      if (selected === 0) {
        scheduler.onInputFeedback([feedbackA], 1, measures);
      } else {
        scheduler.onInputFeedback([feedbackB], 10, measures);
      }
    }

    // After 100 ticks of feedback, global best position should heavily favor GenA (index 0)
    const globalBest = scheduler["_globalBestPos"];
    expect(globalBest[0]).toBeGreaterThan(globalBest[1]);

    // Test selection counts over subsequent ticks
    let countA = 0;
    for (let tick = 101; tick <= 150; tick++) {
      const selected = scheduler.next({
        tick,
        subgens,
        activeSubgens,
        measures,
      });
      if (selected === 0) countA++;
    }

    expect(countA).toBeGreaterThan(30);
    expect(scheduler.getSubgenMetrics(0).productivity).toBeGreaterThan(50);

    Config.override("nanofuzz.generators.compositeScheduler.mopt.period", 50);
  });

  it("handles configuration changes on onRunStart", () => {
    const scheduler = new MoptScheduler("seed");
    Config.override("nanofuzz.generators.compositeScheduler.mopt.swarmSize", 8);
    Config.override("nanofuzz.generators.compositeScheduler.mopt.period", 25);
    Config.override("nanofuzz.generators.compositeScheduler.mopt.inertia", 0.5);
    Config.override(
      "nanofuzz.generators.compositeScheduler.mopt.exploration",
      0.1
    );

    scheduler.onRunStart();
    expect(scheduler["_swarmSize"]).toBe(8);
    expect(scheduler["_period"]).toBe(25);
    expect(scheduler["_w"]).toBe(0.5);
    expect(scheduler["_minProb"]).toBe(0.1);

    Config.override("nanofuzz.generators.compositeScheduler.mopt.swarmSize", 5);
    Config.override("nanofuzz.generators.compositeScheduler.mopt.period", 50);
    Config.override("nanofuzz.generators.compositeScheduler.mopt.inertia", 0.7);
    Config.override(
      "nanofuzz.generators.compositeScheduler.mopt.exploration",
      0.05
    );
  });
});
