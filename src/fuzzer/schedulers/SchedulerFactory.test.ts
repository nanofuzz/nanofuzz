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

  it("creates RandomScheduler for 'random' and 'rnd'", () => {
    const scheduler = SchedulerFactory.create("random", "seed");
    expect(scheduler instanceof RandomScheduler).toBeTrue();
    expect(scheduler.type).toBe("random");

    const aliasScheduler = SchedulerFactory.create("rnd", "seed");
    expect(aliasScheduler instanceof RandomScheduler).toBeTrue();
  });

  it("creates RoundRobinScheduler for 'round-robin' and 'rr'", () => {
    const scheduler = SchedulerFactory.create("round-robin", "seed");
    expect(scheduler instanceof RoundRobinScheduler).toBeTrue();
    expect(scheduler.type).toBe("round-robin");

    const aliasScheduler = SchedulerFactory.create("rr", "seed");
    expect(aliasScheduler instanceof RoundRobinScheduler).toBeTrue();
  });

  it("defaults to MabScheduler for unknown scheduler types", () => {
    const scheduler = SchedulerFactory.create("unknown", "seed");
    expect(scheduler instanceof MabScheduler).toBeTrue();
    expect(scheduler.type).toBe("mab");
  });
});
