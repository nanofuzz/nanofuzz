import { ThompsonScheduler } from "./ThompsonScheduler";
import {
  MockInputGenerator,
  MockMeasure,
  MockMeasurement,
} from "./SchedulerTestUtils";
import * as Config from "../../Config";

describe("src/fuzzer/schedulers/ThompsonScheduler:", () => {
  it("properties: name, humanName, type, needsFeedback", () => {
    const scheduler = new ThompsonScheduler("seed");
    expect(scheduler.name).toBe("ThompsonScheduler");
    expect(scheduler.humanName).toBe("Thompson");
    expect(scheduler.type).toBe("thompson");
    expect(scheduler.needsFeedback).toBeTrue();
  });

  it("throw when no candidate subgens are 'now'", () => {
    const scheduler = new ThompsonScheduler("seed");
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

  it("sample and explore candidates under initial prior variance", () => {
    const scheduler = new ThompsonScheduler("thompson-seed-explore");
    const genA = new MockInputGenerator("GenA");
    const genB = new MockInputGenerator("GenB");

    const subgens = [genA, genB];
    const activeSubgens = [true, true];
    const measures = [new MockMeasure(1)];

    const counts: Record<number, number> = { 0: 0, 1: 0 };
    for (let i = 0; i < 50; i++) {
      const selected = scheduler.next({
        tick: i + 1,
        subgens,
        activeSubgens,
        measures,
      });
      counts[selected]++;
    }

    // Both should be sampled due to initial prior variance
    expect(counts[0]).toBeGreaterThan(10);
    expect(counts[1]).toBeGreaterThan(10);
  });

  it("converge toward higher-yield generator based on posterior updates", () => {
    const scheduler = new ThompsonScheduler("thompson-seed-converge");
    const genA = new MockInputGenerator("GenA");
    const genB = new MockInputGenerator("GenB");

    const subgens = [genA, genB];
    const activeSubgens = [true, true];
    const measures = [new MockMeasure(1)];

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

    // Train GenA with high rewards and GenB with zero rewards
    for (let i = 0; i < 50; i++) {
      const selected = scheduler.next({
        tick: i + 1,
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

    // Subsequent selections should overwhelmingly favor GenA
    let countA = 0;
    for (let i = 0; i < 50; i++) {
      const selected = scheduler.next({
        tick: i + 51,
        subgens,
        activeSubgens,
        measures,
      });
      if (selected === 0) countA++;
    }

    expect(countA).toBeGreaterThan(40);
    expect(scheduler.getSubgenMetrics(0).productivity).toBeGreaterThan(50);
  });

  it("handle prior variance configuration changes on onRunStart", () => {
    const scheduler = new ThompsonScheduler("seed");
    Config.override(
      "nanofuzz.generators.scheduler.thompson.priorVariance",
      2.5
    );
    scheduler.onRunStart();
    expect(scheduler["_priorVariance"]).toBe(2.5);
    Config.override(
      "nanofuzz.generators.scheduler.thompson.priorVariance",
      1.0
    );
  });
});
