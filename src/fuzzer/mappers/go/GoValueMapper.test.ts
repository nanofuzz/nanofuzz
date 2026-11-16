import * as GoValueMapper from "./GoValueMapper";
import * as ValueMapper from "../ValueMapper";
import * as Parser from "../../adapters/ParserAdapter";

describe("fuzzer/mappers/go/GoValueMapper: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("round-trips primitive values", () => {
    [true, false, 3, -10, 3.14, 100n, -42n, "hello", "hello 'bob'"].forEach(
      (value) => {
        const goStr = GoValueMapper.toGo(value);
        const roundtripValue = GoValueMapper.fromGo(goStr);
        expect(roundtripValue).toEqual(value);
      }
    );

    expect(GoValueMapper.toGo(null)).toBe("nil");
    expect(GoValueMapper.fromGo("nil")).toBeNull();
    expect(GoValueMapper.toGo(undefined)).toBe("nil");

    expect(
      Number.isNaN(GoValueMapper.fromGo(GoValueMapper.toGo(NaN)))
    ).toBeTrue();
    expect(GoValueMapper.fromGo(GoValueMapper.toGo(Infinity))).toBe(Infinity);
    expect(GoValueMapper.fromGo(GoValueMapper.toGo(-Infinity))).toBe(-Infinity);
  });

  it("round-trips compound structures (slices, structs, maps)", () => {
    const complex = {
      name: "alice",
      age: 30,
      active: true,
      scores: [10, 20, 30],
      meta: {
        id: 999n,
      },
    };
    const goStr = GoValueMapper.toGo(complex);
    const roundtrip = GoValueMapper.fromGo<typeof complex>(goStr);
    expect(roundtrip).toEqual(complex);

    const arr = [1, 2, [3, 4]];
    const arrStr = GoValueMapper.toGo(arr);
    expect(GoValueMapper.fromGo(arrStr)).toEqual(arr);

    const bytes = new Uint8Array([1, 2, 3, 255]);
    const bytesStr = GoValueMapper.toGo(bytes);
    expect(bytesStr).toBe("[]byte{1, 2, 3, 255}");
  });

  it("handles Go type conversions and numeric casts", () => {
    expect(GoValueMapper.fromGo("int8(-12)")).toBe(-12);
    expect(GoValueMapper.fromGo("int16(-1000)")).toBe(-1000);
    expect(GoValueMapper.fromGo("uint16(60000)")).toBe(60000);
    expect(GoValueMapper.fromGo("uint32(4000000000)")).toBe(4000000000);
    expect(GoValueMapper.fromGo("uint64(999999999999999)")).toBe(999999999999999n);
    expect(GoValueMapper.fromGo("int64(42)")).toBe(42n);
    expect(GoValueMapper.fromGo("uint8(255)")).toBe(255);
    expect(GoValueMapper.fromGo("int32(1000)")).toBe(1000);
    expect(GoValueMapper.fromGo("float32(1.5)")).toBe(1.5);
    expect(GoValueMapper.fromGo("float64(3.14)")).toBe(3.14);
    expect(GoValueMapper.fromGo("1_000_000")).toBe(1000000);
    expect(GoValueMapper.fromGo('&Person{Name: "bob", Age: 25}')).toEqual({
      Name: "bob",
      Age: 25,
    });
    expect(GoValueMapper.fromGo("[]int{10, 20, 30}")).toEqual([10, 20, 30]);
    expect(GoValueMapper.fromGo('map[string]int{"a": 1, "b": 2}')).toEqual({
      a: 1,
      b: 2,
    });
  });

  it("delegates through ValueMapper toLang and fromLang", () => {
    const str = ValueMapper.toLang("go", 42);
    expect(str).toBe("42");
    expect(ValueMapper.fromLang<number>("go", str)).toBe(42);

    const mapVal = { hello: "world" };
    const mapStr = ValueMapper.toLang("go", mapVal);
    expect(ValueMapper.fromLang<typeof mapVal>("go", mapStr)).toEqual(mapVal);
  });
});
