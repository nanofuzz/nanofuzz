import * as JavaValueMapper from "./JavaValueMapper";
import * as ValueMapper from "../ValueMapper";
import * as Parser from "../../adapters/ParserAdapter";
import { ArgDef } from "../../analysis/ArgDef";
import { ArgOptions, ArgTag } from "../../analysis/Types";

describe("fuzzer/mappers/java/JavaValueMapper: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("round-trips primitive values", () => {
    [true, false, 3, -10, 3.14, 100n, -42n, "hello", "hello 'bob'"].forEach(
      (value) => {
        const javaStr = JavaValueMapper.toJava(value);
        const roundtripValue = JavaValueMapper.fromJava(javaStr);
        expect(roundtripValue).toEqual(value);
      }
    );

    expect(JavaValueMapper.toJava(null)).toBe("null");
    expect(JavaValueMapper.fromJava("null")).toBeNull();
    expect(JavaValueMapper.toJava(undefined)).toBe("null");

    expect(
      Number.isNaN(JavaValueMapper.fromJava(JavaValueMapper.toJava(NaN)))
    ).toBeTrue();
    expect(JavaValueMapper.fromJava(JavaValueMapper.toJava(Infinity))).toBe(
      Infinity
    );
    expect(JavaValueMapper.fromJava(JavaValueMapper.toJava(-Infinity))).toBe(
      -Infinity
    );
  });

  it("round-trips compound structures (arrays, objects, nested)", () => {
    const complex = {
      name: "alice",
      age: 30,
      active: true,
      scores: [10, 20, 30],
      meta: {
        id: 999n,
      },
    };
    const javaStr = JavaValueMapper.toJava(complex);
    const roundtrip = JavaValueMapper.fromJava<typeof complex>(javaStr);
    expect(roundtrip).toEqual(complex);

    const arr = [1, 2, [3, 4], { key: "val" }];
    const arrStr = JavaValueMapper.toJava(arr);
    expect(JavaValueMapper.fromJava(arrStr)).toEqual(arr);
  });

  it("handles Java integer and float literal suffixes and casts", () => {
    expect(JavaValueMapper.fromJava("(byte) 42")).toBe(42);
    expect(JavaValueMapper.fromJava("(byte) -128")).toBe(-128);
    expect(JavaValueMapper.fromJava("(short) 1000")).toBe(1000);
    expect(JavaValueMapper.fromJava("(short) -10")).toBe(-10);
    expect(JavaValueMapper.fromJava("50000")).toBe(50000);
    expect(JavaValueMapper.fromJava("-50000")).toBe(-50000);
    expect(JavaValueMapper.fromJava("1_000_000")).toBe(1000000);

    expect(JavaValueMapper.fromJava("100L")).toBe(100n);
    expect(JavaValueMapper.fromJava("100l")).toBe(100n);
    expect(JavaValueMapper.fromJava("-42L")).toBe(-42n);
    expect(JavaValueMapper.fromJava("1_000_000L")).toBe(1000000n);

    expect(JavaValueMapper.fromJava("3.14f")).toBe(3.14);
    expect(JavaValueMapper.fromJava("1.0f")).toBe(1.0);
    expect(JavaValueMapper.fromJava("3.14d")).toBe(3.14);
    expect(JavaValueMapper.fromJava("0x1A")).toBe(26);
    expect(JavaValueMapper.fromJava("0b1010")).toBe(10);
  });

  it("handles Java string constructors and character literals", () => {
    expect(JavaValueMapper.fromJava('new String("hello")')).toBe("hello");
    expect(JavaValueMapper.fromJava('"hello".toString()')).toBe("hello");
    expect(JavaValueMapper.fromJava("String.valueOf(42)")).toBe("42");
    expect(JavaValueMapper.fromJava('"hello"')).toBe("hello");
    expect(JavaValueMapper.fromJava("'a'")).toBe("a");
    expect(JavaValueMapper.fromJava("'\\n'")).toBe("\n");
    expect(JavaValueMapper.fromJava("'\\''")).toBe("'");
  });

  it("handles Uint8Array and byte array literals", () => {
    const bytes = new Uint8Array([187, 123, 1, 237, 243, 43]);
    const javaLiteral = JavaValueMapper.toJava(bytes);
    expect(javaLiteral).toContain("new byte[]{");

    const parsed = JavaValueMapper.fromJava<Uint8Array>(javaLiteral);
    expect(parsed).toEqual(bytes);

    expect(JavaValueMapper.fromJava("new byte[]{}")).toEqual(
      new Uint8Array([])
    );
    expect(
      JavaValueMapper.fromJava("new byte[]{ (byte) 1, (byte) 2 }")
    ).toEqual(new Uint8Array([1, 2]));
  });

  it("handles Set, List, and Map expressions", () => {
    const setVal = new Set([1, 2, 3]);
    const setJava = JavaValueMapper.toJava(setVal);
    expect(setJava).toBe("java.util.Set.of(1, 2, 3)");
    expect(JavaValueMapper.fromJava(setJava)).toEqual(setVal);

    expect(JavaValueMapper.toJava(new Set())).toBe("java.util.Set.of()");
    expect(JavaValueMapper.fromJava("Set.of()")).toEqual(new Set());
    expect(JavaValueMapper.fromJava("java.util.Set.of()")).toEqual(new Set());
    expect(JavaValueMapper.fromJava("new HashSet<>()")).toEqual(new Set());
    expect(
      JavaValueMapper.fromJava("new HashSet<>(Arrays.asList(1, 2))")
    ).toEqual(new Set([1, 2]));

    const mapVal = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const mapJava = JavaValueMapper.toJava(mapVal);
    expect(mapJava).toBe('java.util.Map.of("a", 1, "b", 2)');
    expect(JavaValueMapper.fromJava(mapJava)).toEqual(mapVal);

    expect(JavaValueMapper.toJava(new Map())).toBe("java.util.Map.of()");
    expect(JavaValueMapper.fromJava("Map.of()")).toEqual(new Map());
    expect(JavaValueMapper.fromJava("java.util.Map.of()")).toEqual(new Map());
    expect(JavaValueMapper.fromJava("new HashMap<>()")).toEqual(new Map());

    const largeMap = new Map<string, number>();
    for (let i = 0; i < 12; i++) {
      largeMap.set(`key${i}`, i);
    }
    const largeMapJava = JavaValueMapper.toJava(largeMap);
    expect(largeMapJava).toContain("java.util.Map.ofEntries(");
    expect(JavaValueMapper.fromJava(largeMapJava)).toEqual(largeMap);

    expect(
      JavaValueMapper.fromJava(
        'Map.ofEntries(Map.entry("k1", 10), Map.entry("k2", 20))'
      )
    ).toEqual(
      new Map([
        ["k1", 10],
        ["k2", 20],
      ])
    );

    expect(JavaValueMapper.fromJava('List.of("x", "y")')).toEqual(["x", "y"]);
    expect(JavaValueMapper.fromJava("Arrays.asList(1, 2)")).toEqual([1, 2]);
  });

  it("handles Java standard library constants and BigInteger / BigDecimal", () => {
    expect(JavaValueMapper.fromJava("Integer.MAX_VALUE")).toBe(2147483647);
    expect(JavaValueMapper.fromJava("Integer.MIN_VALUE")).toBe(-2147483648);
    expect(JavaValueMapper.fromJava("Long.MAX_VALUE")).toBe(
      9223372036854775807n
    );
    expect(JavaValueMapper.fromJava("Long.MIN_VALUE")).toBe(
      -9223372036854775808n
    );
    expect(JavaValueMapper.fromJava("Byte.MAX_VALUE")).toBe(127);
    expect(JavaValueMapper.fromJava("Byte.MIN_VALUE")).toBe(-128);
    expect(JavaValueMapper.fromJava("Short.MAX_VALUE")).toBe(32767);
    expect(JavaValueMapper.fromJava("Short.MIN_VALUE")).toBe(-32768);

    expect(
      JavaValueMapper.fromJava(
        'new BigInteger("123456789012345678901234567890")'
      )
    ).toBe(123456789012345678901234567890n);
    expect(JavaValueMapper.fromJava("BigInteger.valueOf(100L)")).toBe(100n);
    expect(JavaValueMapper.fromJava('new BigDecimal("3.14159")')).toBe(3.14159);
  });

  it("handles multi-dimensional arrays and object constructors", () => {
    expect(
      JavaValueMapper.fromJava("new int[][]{ { 1, 2 }, { 3, 4 } }")
    ).toEqual([
      [1, 2],
      [3, 4],
    ]);

    expect(JavaValueMapper.fromJava("new Point(10, 20)")).toEqual({
      constructor: "Point",
      args: [10, 20],
    });
  });

  it("handles Java Optional expressions", () => {
    expect(JavaValueMapper.fromJava("Optional.of(42)")).toBe(42);
    expect(JavaValueMapper.fromJava('Optional.of("hello")')).toBe("hello");
    expect(JavaValueMapper.fromJava("Optional.empty()")).toBeNull();
    expect(JavaValueMapper.fromJava("Optional.ofNullable(null)")).toBeNull();
  });

  it("integrates with ValueMapper dispatch", () => {
    expect(ValueMapper.toLang("java", 42)).toBe("42");
    expect(ValueMapper.toLang("java", true)).toBe("true");
    expect(ValueMapper.toLang("java", "hi")).toBe('"hi"');
    expect(ValueMapper.fromLang("java", "42L")).toBe(42n);
    expect(ValueMapper.fromLang("java", "new int[]{ 1, 2, 3 }")).toEqual([
      1, 2, 3,
    ]);
  });

  it("formats type-directed Java values for Optional, floats, char, and collections", () => {
    const baseOpt: ArgOptions = {
      strCharset: "abc",
      strLength: { min: 0, max: 3 },
      byteLength: { min: 0, max: 3 },
      dictLength: { min: 0, max: 3 },
      setLength: { min: 0, max: 3 },
      strRegex: undefined,
      numInteger: true,
      anyType: ArgTag.NUMBER,
      anyDims: 0,
      dftDimLength: { min: 0, max: 1 },
      dimLength: [],
      dimsUnique: false,
    };

    const optInt = new ArgDef(
      "x",
      0,
      ArgTag.NUMBER,
      baseOpt,
      0,
      true,
      undefined,
      [],
      "int"
    );
    expect(JavaValueMapper.toJava(42, optInt)).toBe("Optional.of(42)");
    expect(JavaValueMapper.toJava(null, optInt)).toBe("Optional.empty()");
    expect(JavaValueMapper.toJava(undefined, optInt)).toBe("Optional.empty()");

    const charDef = new ArgDef(
      "c",
      0,
      ArgTag.STRING,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "char"
    );
    expect(JavaValueMapper.toJava("a", charDef)).toBe("'a'");
    expect(JavaValueMapper.toJava("\n", charDef)).toBe("'\\n'");
    expect(JavaValueMapper.toJava("'", charDef)).toBe("'\\''");

    const floatOpt: ArgOptions = { ...baseOpt, numInteger: false };
    const floatDef = new ArgDef(
      "f",
      0,
      ArgTag.NUMBER,
      floatOpt,
      0,
      false,
      undefined,
      [],
      "float"
    );
    expect(JavaValueMapper.toJava(3.14, floatDef)).toBe("3.14f");
    expect(JavaValueMapper.toJava(5, floatDef)).toBe("5.0f");
    expect(JavaValueMapper.toJava(NaN, floatDef)).toBe("Float.NaN");
    expect(JavaValueMapper.toJava(Infinity, floatDef)).toBe(
      "Float.POSITIVE_INFINITY"
    );

    const listDef = new ArgDef(
      "items",
      0,
      ArgTag.NUMBER,
      baseOpt,
      1,
      false,
      undefined,
      [],
      "List"
    );
    expect(JavaValueMapper.toJava([1, 2, 3], listDef)).toBe(
      "java.util.List.of(1, 2, 3)"
    );
  });
});
