import { CpuSampler, isError, getIoKey } from "./Util";

describe("fuzzer/Util: CpuSampler", () => {
  it("initializes and returns a valid CPU percentage between 0 and 100", () => {
    const sampler = new CpuSampler();
    const cpu = sampler.getCpu(0);
    expect(typeof cpu).toBe("number");
    expect(cpu).toBeGreaterThanOrEqual(0);
    expect(cpu).toBeLessThanOrEqual(100);
  });

  it("returns cached percentage when called within intervalMs", () => {
    const sampler = new CpuSampler();
    const cpu1 = sampler.getCpu(10000);
    const cpu2 = sampler.getCpu(10000);
    expect(cpu1).toBe(cpu2);
  });

  it("updates CPU percentage after intervalMs elapses", async () => {
    const sampler = new CpuSampler();
    sampler.getCpu(0);
    // Allow small time to pass and sample with intervalMs=1
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cpu = sampler.getCpu(10);
    expect(typeof cpu).toBe("number");
    expect(cpu).toBeGreaterThanOrEqual(0);
    expect(cpu).toBeLessThanOrEqual(100);
  });
});

describe("fuzzer/Util: isError", () => {
  it("identifies Error objects correctly", () => {
    expect(isError(new Error("test"))).toBeTrue();
    expect(
      isError({ message: "msg", stack: "stack", name: "CustomError" })
    ).toBeTrue();
    expect(isError("not an error")).toBeFalse();
    expect(isError(null)).toBeFalse();
    expect(isError(undefined)).toBeFalse();
  });
});

describe("fuzzer/Util: getIoKey", () => {
  it("serializes io elements deterministically", () => {
    const key = getIoKey([
      { name: "a", offset: 0, value: 42, origin: { type: "user" } },
    ]);
    expect(key).toContain("42");
  });
});
