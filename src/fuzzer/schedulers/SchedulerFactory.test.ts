import { SchedulerFactory } from "./SchedulerFactory";
import { MabScheduler } from "./MabScheduler";
import { RandomScheduler } from "./RandomScheduler";
import { RoundRobinScheduler } from "./RoundRobinScheduler";
import { Ucb1Scheduler } from "./Ucb1Scheduler";
import { ThompsonScheduler } from "./ThompsonScheduler";

describe("src/fuzzer/schedulers/SchedulerFactory:", () => {
  it("creates MabScheduler for 'mab'", () => {
    const scheduler = SchedulerFactory.create("mab", "seed");
    expect(scheduler instanceof MabScheduler).toBeTrue();
    expect(scheduler.type).toBe("mab");
  });

  it("creates RandomScheduler for 'random'", () => {
    const scheduler = SchedulerFactory.create("random", "seed");
    expect(scheduler instanceof RandomScheduler).toBeTrue();
    expect(scheduler.type).toBe("random");
  });

  it("creates RoundRobinScheduler for 'round-robin'", () => {
    const scheduler = SchedulerFactory.create("round-robin", "seed");
    expect(scheduler instanceof RoundRobinScheduler).toBeTrue();
    expect(scheduler.type).toBe("round-robin");
  });

  it("creates Ucb1Scheduler for 'ucb1'", () => {
    const scheduler = SchedulerFactory.create("ucb1", "seed");
    expect(scheduler instanceof Ucb1Scheduler).toBeTrue();
    expect(scheduler.type).toBe("ucb1");
  });

  it("creates ThompsonScheduler for 'thompson'", () => {
    const scheduler = SchedulerFactory.create("thompson", "seed");
    expect(scheduler instanceof ThompsonScheduler).toBeTrue();
    expect(scheduler.type).toBe("thompson");
  });

  it("defaults to MabScheduler for unknown scheduler types", () => {
    const scheduler = SchedulerFactory.create("unknown", "seed");
    expect(scheduler instanceof MabScheduler).toBeTrue();
    expect(scheduler.type).toBe("mab");
  });
});
