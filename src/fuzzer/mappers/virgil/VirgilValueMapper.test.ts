import * as VirgilValueMapper from "./VirgilValueMapper";
import * as ValueMapper from "../ValueMapper";

describe("fuzzer/mappers/virgil/VirgilValueMapper: ", () => {
  it("round-trips primitive values", () => {
    [true, false, 0, 3, -10, 3.14, 100n, -42n, "hello", "hello 'world'"].forEach(
      (value) => {
        const virgilStr = VirgilValueMapper.toVirgil(value);
        const roundtripValue = VirgilValueMapper.fromVirgil(virgilStr);
        expect(roundtripValue).toEqual(value);
      }
    );

    expect(VirgilValueMapper.toVirgil(null)).toBe("null");
    expect(VirgilValueMapper.fromVirgil("null")).toBeNull();
    expect(VirgilValueMapper.toVirgil(undefined)).toBe("null");

    expect(
      Number.isNaN(VirgilValueMapper.fromVirgil(VirgilValueMapper.toVirgil(NaN)))
    ).toBeTrue();
    expect(
      VirgilValueMapper.fromVirgil(VirgilValueMapper.toVirgil(Infinity))
    ).toBe(Infinity);
    expect(
      VirgilValueMapper.fromVirgil(VirgilValueMapper.toVirgil(-Infinity))
    ).toBe(-Infinity);
  });

  it("round-trips compound structures (arrays, tuples, nested)", () => {
    const arr = [1, 2, [3, 4]];
    const arrStr = VirgilValueMapper.toVirgil(arr);
    expect(VirgilValueMapper.fromVirgil(arrStr)).toEqual(arr);

    const tuple = { "0": 42, "1": "hello", "2": true };
    const tupleStr = VirgilValueMapper.toVirgil(tuple);
    expect(VirgilValueMapper.fromVirgil(tupleStr)).toEqual(tuple);

    const nested = [
      { "0": 1, "1": "first" },
      { "0": 2, "1": "second" },
    ];
    const nestedStr = VirgilValueMapper.toVirgil(nested);
    expect(VirgilValueMapper.fromVirgil(nestedStr)).toEqual(nested);
  });

  it("handles Virgil integer and float literal representations", () => {
    expect(VirgilValueMapper.fromVirgil("42")).toBe(42);
    expect(VirgilValueMapper.fromVirgil("-100")).toBe(-100);
    expect(VirgilValueMapper.fromVirgil("100L")).toBe(100n);
    expect(VirgilValueMapper.fromVirgil("-42L")).toBe(-42n);
    expect(VirgilValueMapper.fromVirgil("0x7f")).toBe(127);
    expect(VirgilValueMapper.fromVirgil("0x1000L")).toBe(4096n);
    expect(VirgilValueMapper.fromVirgil("3.14")).toBe(3.14);
    expect(VirgilValueMapper.fromVirgil("-2.5")).toBe(-2.5);
    expect(VirgilValueMapper.fromVirgil("float.nan")).toBeNaN();
    expect(VirgilValueMapper.fromVirgil("float.infinity")).toBe(Infinity);
    expect(VirgilValueMapper.fromVirgil("-float.infinity")).toBe(-Infinity);
  });

  it("dispatches through ValueMapper toLang and fromLang", () => {
    expect(ValueMapper.toLang("virgil", 42)).toBe("42");
    expect(ValueMapper.toLang("virgil", 100n)).toBe("100L");
    expect(ValueMapper.toLang("virgil", true)).toBe("true");
    expect(ValueMapper.toLang("virgil", "test")).toBe('"test"');
    expect(ValueMapper.fromLang<number>("virgil", "42")).toBe(42);
    expect(ValueMapper.fromLang<bigint>("virgil", "100L")).toBe(100n);
  });
});
