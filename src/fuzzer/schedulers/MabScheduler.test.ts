import { MabScheduler } from "./MabScheduler";
import {
  MockInputGenerator,
  MockMeasure,
  MockMeasurement,
} from "./SchedulerTestUtils";
import * as Config from "../../Config";

describe("src/fuzzer/schedulers/MabScheduler:", () => {
  it("properties: name, humanName, type, needsFeedback", () => {
    const scheduler = new MabScheduler("seed");
    expect(scheduler.name).toBe("MabScheduler");
    expect(scheduler.humanName).toBe("Mab");
    expect(scheduler.type).toBe("mab");
    expect(scheduler.needsFeedback).toBeTrue();
  });

  it("throws when no candidate subgens are 'now'", () => {
    const scheduler = new MabScheduler("seed");
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

  it("selects among available candidates and biases selection toward higher productivity", () => {
    Config.override("nanofuzz.generators.compositeExplorationChance", 0.0);
    const scheduler = new MabScheduler("mab-seed-123");
    const genA = new MockInputGenerator("GenA");
    genA.status = "now";
    const genB = new MockInputGenerator("GenB");
    genB.status = "now";

    const measure = new MockMeasure(1);
    const subgens = [genA, genB];
    const activeSubgens = [true, true];
    const measures = [measure];

    // Select GenA first, give it high reward
    const firstSelected = scheduler.next({
      tick: 1,
      subgens,
      activeSubgens,
      measures,
    });
    expect(firstSelected).toBeGreaterThanOrEqual(0);

    // Provide high reward for GenA (index 0) and zero for GenB (index 1)
    // First simulate selection of index 0
    scheduler["_lastSelectedSubgenIndex"] = 0;
    const feedbackA: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 100,
    };
    scheduler.onInputFeedback([feedbackA], 1, measures);

    // Simulate selection of index 1 with high cost and no delta
    scheduler["_lastSelectedSubgenIndex"] = 1;
    const feedbackB: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 0,
    };
    scheduler.onInputFeedback([feedbackB], 100, measures);

    // GenA has productivity 100/1 = 100. GenB has productivity 0/100 = 0.
    // Next selection should heavily favor GenA (index 0)
    let countA = 0;
    for (let i = 0; i < 50; i++) {
      const selected = scheduler.next({
        tick: i + 2,
        subgens,
        activeSubgens,
        measures,
      });
      if (selected === 0) countA++;
    }
    expect(countA).toBe(50);

    // Verify getSubgenMetrics returns calculated metrics
    expect(scheduler.getSubgenMetrics(0).productivity).toBe(100);
    expect(scheduler.getSubgenMetrics(0).cost).toBe(1);
    expect(scheduler.getSubgenMetrics(1).productivity).toBe(0);
    expect(scheduler.getSubgenMetrics(1).cost).toBe(100);
  });

  it("handles lookback window configuration changes on onRunStart", () => {
    const scheduler = new MabScheduler("seed");
    Config.override("nanofuzz.generators.compositeLookbackWindow", 200);
    scheduler.onRunStart();
    expect(scheduler["_L"]).toBe(200);
  });
});
