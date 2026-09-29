import { SchedulerFactory } from "./SchedulerFactory";
import { MabScheduler } from "./MabScheduler";
import { RandomScheduler } from "./RandomScheduler";
import { RoundRobinScheduler } from "./RoundRobinScheduler";

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

  it("defaults to MabScheduler for unknown scheduler types", () => {
    const scheduler = SchedulerFactory.create("unknown", "seed");
    expect(scheduler instanceof MabScheduler).toBeTrue();
    expect(scheduler.type).toBe("mab");
  });
});
