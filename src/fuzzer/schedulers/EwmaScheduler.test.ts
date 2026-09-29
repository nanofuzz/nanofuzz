import { EwmaScheduler } from "./EwmaScheduler";
import {
  MockInputGenerator,
  MockMeasure,
  MockMeasurement,
} from "./SchedulerTestUtils";
import * as Config from "../../Config";

describe("src/fuzzer/schedulers/EwmaScheduler:", () => {
  it("properties: name, humanName, type, needsFeedback", () => {
    const scheduler = new EwmaScheduler("seed");
    expect(scheduler.name).toBe("EwmaScheduler");
    expect(scheduler.humanName).toBe("Ewma");
    expect(scheduler.type).toBe("ewma");
    expect(scheduler.needsFeedback).toBeTrue();
  });

  it("throws when no candidate subgens are 'now'", () => {
    const scheduler = new EwmaScheduler("seed");
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

  it("converges toward higher-yield generator based on rolling EWMA updates", () => {
    const scheduler = new EwmaScheduler("ewma-seed-converge");
    const genA = new MockInputGenerator("GenA");
    const genB = new MockInputGenerator("GenB");

    const subgens = [genA, genB];
    const activeSubgens = [true, true];
    const measures = [new MockMeasure(1)];

    // Force zero random exploration to test pure convergence
    Config.override(
      "nanofuzz.generators.compositeScheduler.ewma.exploration",
      0.0
    );
    scheduler.onRunStart();

    // Initial picks & feedback
    scheduler.next({ tick: 1, subgens, activeSubgens, measures });
    scheduler["_lastSelectedSubgenIndex"] = 0;
    const feedbackA: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 100,
    };
    scheduler.onInputFeedback([feedbackA], 1, measures);

    scheduler.next({ tick: 2, subgens, activeSubgens, measures });
    scheduler["_lastSelectedSubgenIndex"] = 1;
    const feedbackB: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 0,
    };
    scheduler.onInputFeedback([feedbackB], 10, measures);

    // GenA has smoothed productivity = 100, GenB has smoothed productivity = 0
    let countA = 0;
    for (let i = 0; i < 50; i++) {
      const selected = scheduler.next({
        tick: i + 3,
        subgens,
        activeSubgens,
        measures,
      });
      if (selected === 0) countA++;
    }

    expect(countA).toBe(50);
    expect(scheduler.getSubgenMetrics(0).productivity).toBe(100);
    expect(scheduler.getSubgenMetrics(1).productivity).toBe(0);

    Config.override(
      "nanofuzz.generators.compositeScheduler.ewma.exploration",
      0.1
    );
  });

  it("adapts smoothly when productivity shifts between generators", () => {
    const scheduler = new EwmaScheduler("ewma-seed-shift");
    const genA = new MockInputGenerator("GenA");
    const genB = new MockInputGenerator("GenB");

    const subgens = [genA, genB];
    const activeSubgens = [true, true];
    const measures = [new MockMeasure(1)];

    Config.override("nanofuzz.generators.compositeScheduler.ewma.alpha", 0.5);
    Config.override(
      "nanofuzz.generators.compositeScheduler.ewma.exploration",
      0.0
    );
    scheduler.onRunStart();

    const feedbackHigh: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 100,
    };
    const feedbackLow: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 1,
    };
    const feedbackZero: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 0,
    };

    // Initially GenA is high reward
    scheduler["_lastSelectedSubgenIndex"] = 0;
    scheduler.onInputFeedback([feedbackHigh], 1, measures);

    // GenB is low reward
    scheduler["_lastSelectedSubgenIndex"] = 1;
    scheduler.onInputFeedback([feedbackLow], 1, measures);

    expect(scheduler.getSubgenMetrics(0).productivity).toBe(100);

    // Now GenA produces 0 reward for several steps
    for (let i = 0; i < 10; i++) {
      scheduler["_lastSelectedSubgenIndex"] = 0;
      scheduler.onInputFeedback([feedbackZero], 1, measures);
    }

    // Now GenB produces 100 reward
    for (let i = 0; i < 5; i++) {
      scheduler["_lastSelectedSubgenIndex"] = 1;
      scheduler.onInputFeedback([feedbackHigh], 1, measures);
    }

    // GenB should now have much higher productivity than decayed GenA
    expect(scheduler.getSubgenMetrics(1).productivity).toBeGreaterThan(
      scheduler.getSubgenMetrics(0).productivity
    );

    const selected = scheduler.next({
      tick: 100,
      subgens,
      activeSubgens,
      measures,
    });
    expect(selected).toBe(1);

    Config.override("nanofuzz.generators.compositeScheduler.ewma.alpha", 0.2);
    Config.override(
      "nanofuzz.generators.compositeScheduler.ewma.exploration",
      0.1
    );
  });

  it("handles alpha and exploration configuration changes on onRunStart", () => {
    const scheduler = new EwmaScheduler("seed");
    Config.override("nanofuzz.generators.compositeScheduler.ewma.alpha", 0.4);
    Config.override(
      "nanofuzz.generators.compositeScheduler.ewma.exploration",
      0.3
    );
    scheduler.onRunStart();
    expect(scheduler["_alpha"]).toBe(0.4);
    expect(scheduler["_exploration"]).toBe(0.3);

    Config.override("nanofuzz.generators.compositeScheduler.ewma.alpha", 0.2);
    Config.override(
      "nanofuzz.generators.compositeScheduler.ewma.exploration",
      0.1
    );
  });
});
