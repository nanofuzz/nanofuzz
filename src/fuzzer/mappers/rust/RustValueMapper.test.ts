import * as RustValueMapper from "./RustValueMapper";
import * as ValueMapper from "../ValueMapper";
import * as Parser from "../../adapters/ParserAdapter";
import { ArgDef } from "../../analysis/ArgDef";
import { ArgOptions, ArgTag } from "../../analysis/Types";

describe("fuzzer/mappers/rust/RustValueMapper: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("round-trips primitive values", () => {
    [true, false, 3, -10, 3.14, 100n, -42n, "hello", "hello 'bob'"].forEach(
      (value) => {
        const rustStr = RustValueMapper.toRust(value);
        const roundtripValue = RustValueMapper.fromRust(rustStr);
        expect(roundtripValue).toEqual(value);
      }
    );

    expect(RustValueMapper.toRust(null)).toBe("None");
    expect(RustValueMapper.fromRust("None")).toBeNull();
    expect(RustValueMapper.toRust(undefined)).toBe("None");

    expect(
      Number.isNaN(RustValueMapper.fromRust(RustValueMapper.toRust(NaN)))
    ).toBeTrue();
    expect(RustValueMapper.fromRust(RustValueMapper.toRust(Infinity))).toBe(
      Infinity
    );
    expect(RustValueMapper.fromRust(RustValueMapper.toRust(-Infinity))).toBe(
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
    const rustStr = RustValueMapper.toRust(complex);
    const roundtrip = RustValueMapper.fromRust<typeof complex>(rustStr);
    expect(roundtrip).toEqual(complex);

    const arr = [1, 2, [3, 4], { key: "val" }];
    const arrStr = RustValueMapper.toRust(arr);
    expect(RustValueMapper.fromRust(arrStr)).toEqual(arr);
  });

  it("handles Rust integer and float literal suffixes", () => {
    expect(RustValueMapper.fromRust("42i32")).toBe(42);
    expect(RustValueMapper.fromRust("255u8")).toBe(255);
    expect(RustValueMapper.fromRust("1000u16")).toBe(1000);
    expect(RustValueMapper.fromRust("-10i16")).toBe(-10);
    expect(RustValueMapper.fromRust("50000u32")).toBe(50000);
    expect(RustValueMapper.fromRust("-50000i32")).toBe(-50000);
    expect(RustValueMapper.fromRust("100isize")).toBe(100);
    expect(RustValueMapper.fromRust("100usize")).toBe(100);
    expect(RustValueMapper.fromRust("1_000_000")).toBe(1000000);

    expect(RustValueMapper.fromRust("100i64")).toBe(100n);
    expect(RustValueMapper.fromRust("100u64")).toBe(100n);
    expect(RustValueMapper.fromRust("-42i64")).toBe(-42n);

    expect(RustValueMapper.fromRust("3.14f64")).toBe(3.14);
    expect(RustValueMapper.fromRust("1.0f32")).toBe(1.0);
  });

  it("handles Rust string constructor variants and raw strings", () => {
    expect(RustValueMapper.fromRust('String::from("hello")')).toBe("hello");
    expect(RustValueMapper.fromRust('"hello".to_string()')).toBe("hello");
    expect(RustValueMapper.fromRust('"hello".to_owned()')).toBe("hello");
    expect(RustValueMapper.fromRust('&"hello"')).toBe("hello");
    expect(RustValueMapper.fromRust('"hello"')).toBe("hello");
    expect(RustValueMapper.fromRust('r#"raw "string" with quotes"#')).toBe(
      'raw "string" with quotes'
    );
    expect(RustValueMapper.fromRust("'a'")).toBe("a");
  });

  it("handles Uint8Array and byte string literals", () => {
    const bytes = new Uint8Array([187, 123, 1, 237, 243, 43]);
    const rustLiteral = RustValueMapper.toRust(bytes);
    expect(rustLiteral).toContain(".to_vec()");

    const parsed = RustValueMapper.fromRust<Uint8Array>(rustLiteral);
    expect(parsed).toEqual(bytes);

    expect(RustValueMapper.fromRust('b"hello"')).toEqual(
      new Uint8Array([104, 101, 108, 108, 111])
    );
    expect(RustValueMapper.fromRust('b"hello".to_vec()')).toEqual(
      new Uint8Array([104, 101, 108, 108, 111])
    );
  });

  it("handles Set and Map expressions", () => {
    const setVal = new Set([1, 2, 3]);
    const setRust = RustValueMapper.toRust(setVal);
    expect(setRust).toBe("std::collections::HashSet::from([1, 2, 3])");
    expect(RustValueMapper.fromRust(setRust)).toEqual(setVal);

    expect(RustValueMapper.toRust(new Set())).toBe(
      "std::collections::HashSet::new()"
    );
    expect(RustValueMapper.fromRust("HashSet::new()")).toEqual(new Set());
    expect(
      RustValueMapper.fromRust("std::collections::HashSet::new()")
    ).toEqual(new Set());

    const mapVal = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const mapRust = RustValueMapper.toRust(mapVal);
    expect(RustValueMapper.fromRust(mapRust)).toEqual(mapVal);

    expect(RustValueMapper.toRust(new Map())).toBe(
      "std::collections::HashMap::new()"
    );
    expect(RustValueMapper.fromRust("HashMap::new()")).toEqual(new Map());
    expect(
      RustValueMapper.fromRust("std::collections::HashMap::new()")
    ).toEqual(new Map());
  });

  it("handles Rust Option and tuple expressions", () => {
    expect(RustValueMapper.fromRust("Some(42)")).toBe(42);
    expect(RustValueMapper.fromRust('Some("hello")')).toBe("hello");
    expect(RustValueMapper.fromRust("None")).toBeNull();

    expect(RustValueMapper.fromRust("(1, 2)")).toEqual([1, 2]);
    expect(RustValueMapper.fromRust('(1, "two", true)')).toEqual([
      1,
      "two",
      true,
    ]);
    expect(RustValueMapper.fromRust("(42,)")).toEqual([42]);
    expect(RustValueMapper.fromRust("()")).toBeNull();
  });

  it("handles Box and VecDeque expressions with round-trip support", () => {
    expect(RustValueMapper.fromRust("Box::new(42)")).toBe(42);
    expect(RustValueMapper.fromRust("std::boxed::Box::new(42)")).toBe(42);
    expect(RustValueMapper.fromRust('Box::new("hello")')).toBe("hello");
    expect(RustValueMapper.fromRust("Box::new(vec![1, 2, 3])")).toEqual([
      1, 2, 3,
    ]);

    expect(RustValueMapper.fromRust("VecDeque::new()")).toEqual([]);
    expect(
      RustValueMapper.fromRust("std::collections::VecDeque::new()")
    ).toEqual([]);
    expect(RustValueMapper.fromRust("VecDeque::from([1, 2, 3])")).toEqual([
      1, 2, 3,
    ]);
    expect(
      RustValueMapper.fromRust("std::collections::VecDeque::from([1, 2, 3])")
    ).toEqual([1, 2, 3]);
  });

  it("handles Rust struct expressions", () => {
    expect(RustValueMapper.fromRust("Point { x: 10, y: 20 }")).toEqual({
      x: 10,
      y: 20,
    });
  });

  it("integrates with ValueMapper dispatch", () => {
    expect(ValueMapper.toLang("rust", 42)).toBe("42");
    expect(ValueMapper.toLang("rust", true)).toBe("true");
    expect(ValueMapper.toLang("rust", "hi")).toBe('String::from("hi")');
    expect(ValueMapper.fromLang("rust", "42i32")).toBe(42);
    expect(ValueMapper.fromLang("rust", "vec![1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("formats type-directed Rust values for Option, floats, char, collections, and integer widths", () => {
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

    const optI32 = new ArgDef(
      "x",
      0,
      ArgTag.NUMBER,
      baseOpt,
      0,
      true,
      undefined,
      [],
      "i32"
    );
    expect(RustValueMapper.toRust(42, optI32)).toBe("Some(42i32)");
    expect(RustValueMapper.toRust(null, optI32)).toBe("None");
    expect(RustValueMapper.toRust(undefined, optI32)).toBe("None");

    const optStr = new ArgDef(
      "s",
      0,
      ArgTag.STRING,
      baseOpt,
      0,
      true,
      undefined,
      [],
      "String"
    );
    expect(RustValueMapper.toRust("hello", optStr)).toBe(
      'Some(String::from("hello"))'
    );
    expect(RustValueMapper.toRust(null, optStr)).toBe("None");

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
    expect(RustValueMapper.toRust("a", charDef)).toBe("'a'");
    expect(RustValueMapper.toRust("\n", charDef)).toBe("'\\n'");
    expect(RustValueMapper.toRust("\\", charDef)).toBe("'\\\\'");
    expect(RustValueMapper.toRust("'", charDef)).toBe("'\\''");

    const f32Def = new ArgDef(
      "f",
      0,
      ArgTag.NUMBER,
      { ...baseOpt, numInteger: false },
      0,
      false,
      undefined,
      [],
      "f32"
    );
    expect(RustValueMapper.toRust(3, f32Def)).toBe("3.0f32");
    expect(RustValueMapper.toRust(3.5, f32Def)).toBe("3.5f32");
    expect(RustValueMapper.toRust(Infinity, f32Def)).toBe("f32::INFINITY");
    expect(RustValueMapper.toRust(-Infinity, f32Def)).toBe("-f32::INFINITY");
    expect(RustValueMapper.toRust(NaN, f32Def)).toBe("f32::NAN");

    const f64Def = new ArgDef(
      "f",
      0,
      ArgTag.NUMBER,
      { ...baseOpt, numInteger: false },
      0,
      false,
      undefined,
      [],
      "f64"
    );
    expect(RustValueMapper.toRust(3, f64Def)).toBe("3.0f64");
    expect(RustValueMapper.toRust(3.5, f64Def)).toBe("3.5f64");
    expect(RustValueMapper.toRust(Infinity, f64Def)).toBe("f64::INFINITY");
    expect(RustValueMapper.toRust(-Infinity, f64Def)).toBe("-f64::INFINITY");
    expect(RustValueMapper.toRust(NaN, f64Def)).toBe("f64::NAN");

    const u64Def = new ArgDef(
      "u",
      0,
      ArgTag.NUMBER,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "u64"
    );
    expect(RustValueMapper.toRust(42, u64Def)).toBe("42u64");
    expect(RustValueMapper.toRust(42n, u64Def)).toBe("42u64");

    const usizeDef = new ArgDef(
      "u",
      0,
      ArgTag.NUMBER,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "usize"
    );
    expect(RustValueMapper.toRust(10, usizeDef)).toBe("10usize");

    const vecF64Def = new ArgDef(
      "v",
      0,
      ArgTag.NUMBER,
      { ...baseOpt, numInteger: false },
      1,
      false,
      undefined,
      [],
      "f64"
    );
    expect(RustValueMapper.toRust([1, 2.5], vecF64Def)).toBe(
      "vec![1.0f64, 2.5f64]"
    );

    const btreeSetDef = new ArgDef(
      "s",
      0,
      ArgTag.SET,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "BTreeSet"
    );
    expect(RustValueMapper.toRust(new Set([1, 2]), btreeSetDef)).toBe(
      "std::collections::BTreeSet::from([1, 2])"
    );
    expect(RustValueMapper.toRust(new Set(), btreeSetDef)).toBe(
      "std::collections::BTreeSet::new()"
    );

    const btreeMapDef = new ArgDef(
      "m",
      0,
      ArgTag.DICTIONARY,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "BTreeMap"
    );
    btreeMapDef.setBaseTypeRef("Map");
    expect(RustValueMapper.toRust(new Map([["a", 1]]), btreeMapDef)).toBe(
      'std::collections::BTreeMap::from([(String::from("a"), 1)])'
    );
    expect(RustValueMapper.toRust(new Map(), btreeMapDef)).toBe(
      "std::collections::BTreeMap::new()"
    );

    const boxI32Def = new ArgDef(
      "b",
      0,
      ArgTag.NUMBER,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "i32"
    );
    boxI32Def.setBaseTypeRef("Box");
    expect(RustValueMapper.toRust(42, boxI32Def)).toBe("Box::new(42i32)");
    expect(
      RustValueMapper.fromRust(RustValueMapper.toRust(42, boxI32Def))
    ).toBe(42);

    const boxVecDef = new ArgDef(
      "b",
      0,
      ArgTag.NUMBER,
      baseOpt,
      1,
      false,
      undefined,
      [],
      "i32"
    );
    boxVecDef.setBaseTypeRef("Box");
    expect(RustValueMapper.toRust([1, 2, 3], boxVecDef)).toBe(
      "Box::new(vec![1i32, 2i32, 3i32])"
    );
    expect(
      RustValueMapper.fromRust(RustValueMapper.toRust([1, 2, 3], boxVecDef))
    ).toEqual([1, 2, 3]);

    const vecDequeDef = new ArgDef(
      "q",
      0,
      ArgTag.NUMBER,
      baseOpt,
      1,
      false,
      undefined,
      [],
      "i32"
    );
    vecDequeDef.setBaseTypeRef("VecDeque");
    expect(RustValueMapper.toRust([1, 2], vecDequeDef)).toBe(
      "std::collections::VecDeque::from([1i32, 2i32])"
    );
    expect(RustValueMapper.toRust([], vecDequeDef)).toBe(
      "std::collections::VecDeque::new()"
    );
    expect(
      RustValueMapper.fromRust(RustValueMapper.toRust([1, 2], vecDequeDef))
    ).toEqual([1, 2]);
    expect(
      RustValueMapper.fromRust(RustValueMapper.toRust([], vecDequeDef))
    ).toEqual([]);
  });
});
