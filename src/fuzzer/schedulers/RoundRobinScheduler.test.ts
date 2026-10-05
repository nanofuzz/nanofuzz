import { RoundRobinScheduler } from "./RoundRobinScheduler";
import { MockInputGenerator } from "./SchedulerTestUtils";

describe("src/fuzzer/schedulers/RoundRobinScheduler:", () => {
  it("properties: name, humanName, type, needsFeedback", () => {
    const scheduler = new RoundRobinScheduler("seed");
    expect(scheduler.name).toBe("RoundRobinScheduler");
    expect(scheduler.humanName).toBe("RoundRobin");
    expect(scheduler.type).toBe("round-robin");
    expect(scheduler.needsFeedback).toBeFalse();
    expect(scheduler.getSubgenMetrics(0)).toEqual({ productivity: 0, cost: 0 });
  });

  it("throws when no candidate subgens are 'now'", () => {
    const scheduler = new RoundRobinScheduler("seed");
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

  it("selects sequentially in cyclic order among ready candidates", () => {
    const scheduler = new RoundRobinScheduler("seed");
    const genA = new MockInputGenerator("GenA");
    const genB = new MockInputGenerator("GenB");
    const genC = new MockInputGenerator("GenC"); // inactive
    const genD = new MockInputGenerator("GenD");

    genA.status = "now";
    genB.status = "now";
    genC.status = "now";
    genD.status = "now";

    const subgens = [genA, genB, genC, genD];
    const activeSubgens = [true, true, false, true]; // candidates: indices 0, 1, 3

    const sequence: number[] = [];
    for (let i = 0; i < 7; i++) {
      sequence.push(
        scheduler.next({
          tick: i + 1,
          subgens,
          activeSubgens,
          measures: [],
        })
      );
    }

    expect(sequence).toEqual([0, 1, 3, 0, 1, 3, 0]);
  });

  it("adapts seamlessly when a candidate becomes unavailable mid-cycle", () => {
    const scheduler = new RoundRobinScheduler("seed");
    const genA = new MockInputGenerator("GenA");
    const genB = new MockInputGenerator("GenB");
    const genC = new MockInputGenerator("GenC");

    const subgens = [genA, genB, genC];
    const activeSubgens = [true, true, true];

    // Pick index 0
    expect(
      scheduler.next({ tick: 1, subgens, activeSubgens, measures: [] })
    ).toBe(0);
    // Pick index 1
    expect(
      scheduler.next({ tick: 2, subgens, activeSubgens, measures: [] })
    ).toBe(1);

    // Now genC (index 2) becomes unavailable ("soon")
    genC.status = "soon";

    // Next selection wraps around to 0
    expect(
      scheduler.next({ tick: 3, subgens, activeSubgens, measures: [] })
    ).toBe(0);
  });
});
