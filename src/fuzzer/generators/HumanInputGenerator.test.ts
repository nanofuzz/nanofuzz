import { HumanInputGenerator } from "./HumanInputGenerator";
import { FuzzPinnedTest, InputAndSource } from "../Types";

describe("fuzzer/generators/HumanInputGenerator:", () => {
  it("initializes empty when no inputs provided", () => {
    const gen = new HumanInputGenerator([]);
    expect(gen.nextable()).toBe(false);
    expect(gen.name).toBe("HumanInputGenerator");
    expect(gen.humanName).toBe("Human");
    expect(() => gen.next()).toThrow();
  });

  it("produces injected inputs in order with status 'now!'", () => {
    const mockPinnedTests: FuzzPinnedTest[] = [
      {
        input: [
          {
            name: "a",
            offset: 0,
            value: 10,
            origin: { type: "user" },
          },
        ],
        output: [],
        pinned: true,
      },
      {
        input: [
          {
            name: "a",
            offset: 0,
            value: 20,
            origin: { type: "user" },
          },
        ],
        output: [],
        pinned: true,
      },
    ];

    const gen = new HumanInputGenerator([], undefined, mockPinnedTests);

    expect(gen.nextable()).toBe("now!");

    const first = gen.next();
    expect(first.tick).toBe(1);
    expect(first.injected).toBeTrue();
    expect<unknown>(first.value).toEqual([
      { tag: "ArgValueTypeWrapped", value: 10 },
    ]);
    expect(first.source).toEqual({ type: "user" });

    expect(gen.nextable()).toBe("now!");

    const second = gen.next();
    expect(second.tick).toBe(2);
    expect(second.injected).toBeTrue();
    expect<unknown>(second.value).toEqual([
      { tag: "ArgValueTypeWrapped", value: 20 },
    ]);

    expect(gen.nextable()).toBe(false);
    expect(() => gen.next()).toThrow();
  });

  it("onRunStart() appends inputs to queue", () => {
    const gen = new HumanInputGenerator([]);
    expect(gen.nextable()).toBe(false);

    const inputs1: Omit<InputAndSource, "tick">[] = [
      {
        value: [{ tag: "ArgValueTypeWrapped", value: "first" }],
        source: { type: "user" },
        injected: true,
      },
    ];

    gen.onRunStart(true, inputs1);
    expect(gen.nextable()).toBe("now!");

    const inputs2: Omit<InputAndSource, "tick">[] = [
      {
        value: [{ tag: "ArgValueTypeWrapped", value: "second" }],
        source: { type: "user" },
        injected: true,
      },
    ];

    gen.onRunStart(true, inputs2);
    expect(gen.nextable()).toBe("now!");

    const item1 = gen.next();
    expect<unknown>(item1.value).toEqual([
      { tag: "ArgValueTypeWrapped", value: "first" },
    ]);
    expect(gen.nextable()).toBe("now!");

    const item2 = gen.next();
    expect<unknown>(item2.value).toEqual([
      { tag: "ArgValueTypeWrapped", value: "second" },
    ]);
    expect(gen.nextable()).toBe(false);
  });
});
