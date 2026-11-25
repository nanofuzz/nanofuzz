import { CpuSampler, isError, getIoKey, resolveFullProvenance } from "./Util";
import { FuzzValueOrigin } from "./Types";

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

describe("fuzzer/Util: resolveFullProvenance", () => {
  it("formats user seed inputs as SeedInput", () => {
    const origin: FuzzValueOrigin = { type: "user" };
    expect(resolveFullProvenance(origin)).toBe("SeedInput");
  });

  it("formats custom generator inputs", () => {
    const origin: FuzzValueOrigin = {
      type: "generator",
      generator: "UserInputGenerator",
      fnName: "myCustomGen",
    };
    expect(resolveFullProvenance(origin)).toBe("CustomGen[myCustomGen]");
  });

  it("formats AI generator inputs with model name", () => {
    const origin: FuzzValueOrigin = {
      type: "generator",
      generator: "AiInputGenerator",
      model: "gpt-4o",
    };
    expect(resolveFullProvenance(origin)).toBe("AI[gpt-4o]");
  });

  it("formats mutation inputs and mutator steps", () => {
    const origin: FuzzValueOrigin = {
      type: "generator",
      generator: "MutationInputGenerator",
      steps: {
        taken: 1,
        max: 5,
        mode: "mutate",
        mutators: ["string-replaceOneChar", "string-insertOneChar"],
      },
    };
    expect(resolveFullProvenance(origin)).toBe(
      "Mutation[string-replaceOneChar,string-insertOneChar]"
    );
  });

  it("unwinds mutation lineage linked through leaderboard parent tick", () => {
    const leaderboardProvenance = new Map<number, string>();
    leaderboardProvenance.set(10, "SeedInput");

    const origin: FuzzValueOrigin = {
      type: "generator",
      generator: "MutationInputGenerator",
      tick: 10,
      steps: {
        taken: 1,
        max: 5,
        mode: "mutate",
        mutators: ["number-boundaryValue"],
      },
    };

    expect(resolveFullProvenance(origin, leaderboardProvenance)).toBe(
      "SeedInput->Mutation[number-boundaryValue]"
    );
  });

  it("recursively unwinds transformer lineage to the underlying generator", () => {
    const origin: FuzzValueOrigin = {
      type: "transformer",
      transformer: "myInputTransformer",
      basis: {
        value: [{ value: 42, tag: "ArgValueTypeWrapped" }],
        source: {
          type: "generator",
          generator: "RandomInputGenerator",
        },
      },
    };

    expect(resolveFullProvenance(origin)).toBe(
      "RandomInputGenerator->Transformer[myInputTransformer]"
    );
  });
});
