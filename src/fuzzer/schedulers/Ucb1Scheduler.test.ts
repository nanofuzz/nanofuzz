import { Ucb1Scheduler } from "./Ucb1Scheduler";
import {
  MockInputGenerator,
  MockMeasure,
  MockMeasurement,
} from "./SchedulerTestUtils";
import * as Config from "../../Config";

describe("src/fuzzer/schedulers/Ucb1Scheduler:", () => {
  it("properties: name, humanName, type, needsFeedback", () => {
    const scheduler = new Ucb1Scheduler("seed");
    expect(scheduler.name).toBe("Ucb1Scheduler");
    expect(scheduler.humanName).toBe("Ucb1");
    expect(scheduler.type).toBe("ucb1");
    expect(scheduler.needsFeedback).toBeTrue();
  });

  it("throws when no candidate subgens are 'now'", () => {
    const scheduler = new Ucb1Scheduler("seed");
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

  it("cold-start: selects all unvisited candidates before repeating", () => {
    const scheduler = new Ucb1Scheduler("seed-ucb-cold");
    const genA = new MockInputGenerator("GenA");
    const genB = new MockInputGenerator("GenB");
    const genC = new MockInputGenerator("GenC");

    const subgens = [genA, genB, genC];
    const activeSubgens = [true, true, true];
    const measures = [new MockMeasure(1)];

    const first = scheduler.next({
      tick: 1,
      subgens,
      activeSubgens,
      measures,
    });
    const feedback: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 10,
    };
    scheduler.onInputFeedback([feedback], 1, measures);

    const second = scheduler.next({
      tick: 2,
      subgens,
      activeSubgens,
      measures,
    });
    expect(second).not.toBe(first);
    scheduler.onInputFeedback([feedback], 1, measures);

    const third = scheduler.next({
      tick: 3,
      subgens,
      activeSubgens,
      measures,
    });
    expect([first, second]).not.toContain(third);
  });

  it("biases selection toward higher productivity arm after initial sampling", () => {
    const scheduler = new Ucb1Scheduler("seed-ucb-bias");
    const genA = new MockInputGenerator("GenA");
    const genB = new MockInputGenerator("GenB");

    const subgens = [genA, genB];
    const activeSubgens = [true, true];
    const measures = [new MockMeasure(1)];

    // Sample genA (index 0) with high reward
    scheduler.next({ tick: 1, subgens, activeSubgens, measures });
    scheduler["_lastSelectedSubgenIndex"] = 0;
    const feedbackA: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 100,
    };
    scheduler.onInputFeedback([feedbackA], 1, measures);

    // Sample genB (index 1) with low reward
    scheduler.next({ tick: 2, subgens, activeSubgens, measures });
    scheduler["_lastSelectedSubgenIndex"] = 1;
    const feedbackB: MockMeasurement = {
      type: "measure",
      name: "MockMeasure",
      deltaVal: 1,
    };
    scheduler.onInputFeedback([feedbackB], 100, measures);

    let countA = 0;
    for (let i = 0; i < 50; i++) {
      const selected = scheduler.next({
        tick: i + 3,
        subgens,
        activeSubgens,
        measures,
      });
      if (selected === 0) {
        countA++;
        scheduler.onInputFeedback([feedbackA], 1, measures);
      } else {
        scheduler.onInputFeedback([feedbackB], 100, measures);
      }
    }

    // High reward generator GenA should be selected the majority of times
    expect(countA).toBeGreaterThan(35);

    // Verify getSubgenMetrics calculation
    expect(scheduler.getSubgenMetrics(0).productivity).toBeGreaterThan(50);
    expect(scheduler.getSubgenMetrics(1).productivity).toBeLessThan(1);
  });

  it("handles exploration constant configuration changes on onRunStart", () => {
    const scheduler = new Ucb1Scheduler("seed");
    Config.override("nanofuzz.generators.scheduler.ucb1.exploration", 0.5);
    scheduler.onRunStart();
    expect(scheduler["_c"]).toBe(0.5);
    Config.override("nanofuzz.generators.scheduler.ucb1.exploration", 1.414);
  });
});
