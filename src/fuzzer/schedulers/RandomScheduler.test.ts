import { RandomScheduler } from "./RandomScheduler";
import { MockInputGenerator } from "./SchedulerTestUtils";

describe("src/fuzzer/schedulers/RandomScheduler:", () => {
  it("properties: name, humanName, type, needsFeedback", () => {
    const scheduler = new RandomScheduler("seed");
    expect(scheduler.name).toBe("RandomScheduler");
    expect(scheduler.humanName).toBe("Random");
    expect(scheduler.type).toBe("random");
    expect(scheduler.needsFeedback).toBeFalse();
    expect(scheduler.getSubgenMetrics(0)).toEqual({ productivity: 0, cost: 0 });
  });

  it("throws when no candidate subgens are 'now'", () => {
    const scheduler = new RandomScheduler("seed");
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

  it("selects uniformly across active 'now' candidates only", () => {
    const scheduler = new RandomScheduler("random-seed-123");
    const genA = new MockInputGenerator("GenA");
    const genB = new MockInputGenerator("GenB");
    const genC = new MockInputGenerator("GenC"); // inactive
    const genD = new MockInputGenerator("GenD"); // soon

    genA.status = "now";
    genB.status = "now";
    genC.status = "now";
    genD.status = "soon";

    const subgens = [genA, genB, genC, genD];
    const activeSubgens = [true, true, false, true];

    const counts: Record<number, number> = { 0: 0, 1: 0 };
    for (let i = 0; i < 200; i++) {
      const selected = scheduler.next({
        tick: i + 1,
        subgens,
        activeSubgens,
        measures: [],
      });
      expect(selected === 0 || selected === 1).toBeTrue();
      counts[selected]++;
    }

    // Both candidate 0 and candidate 1 should be selected
    expect(counts[0]).toBeGreaterThan(30);
    expect(counts[1]).toBeGreaterThan(30);
  });
});
