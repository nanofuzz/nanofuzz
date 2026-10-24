import * as OxcamlValueMapper from "./OxcamlValueMapper";
import * as ValueMapper from "../ValueMapper";
import * as Parser from "../../adapters/ParserAdapter";
import { ArgDef } from "../../analysis/ArgDef";
import { ArgOptions, ArgTag } from "../../analysis/Types";

describe("fuzzer/mappers/oxcaml/OxcamlValueMapper: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("round-trips primitive values", () => {
    [true, false, 3, -10, 3.14, 100n, -42n, "hello", "hello 'bob'"].forEach(
      (value) => {
        const oxcamlStr = OxcamlValueMapper.toOxcaml(value);
        const roundtripValue = OxcamlValueMapper.fromOxcaml(oxcamlStr);
        expect(roundtripValue).toEqual(value);
      }
    );

    expect(OxcamlValueMapper.toOxcaml(null)).toBe("None");
    expect(OxcamlValueMapper.fromOxcaml("None")).toBeNull();
    expect(OxcamlValueMapper.toOxcaml(undefined)).toBe("None");

    expect(
      Number.isNaN(
        OxcamlValueMapper.fromOxcaml(OxcamlValueMapper.toOxcaml(NaN))
      )
    ).toBeTrue();
    expect(
      OxcamlValueMapper.fromOxcaml(OxcamlValueMapper.toOxcaml(Infinity))
    ).toBe(Infinity);
    expect(
      OxcamlValueMapper.fromOxcaml(OxcamlValueMapper.toOxcaml(-Infinity))
    ).toBe(-Infinity);
  });

  it("round-trips compound structures (lists, records, nested)", () => {
    const complex = {
      name: "alice",
      age: 30,
      active: true,
      scores: [10, 20, 30],
      meta: {
        id: 999n,
      },
    };
    const oxcamlStr = OxcamlValueMapper.toOxcaml(complex);
    const roundtrip = OxcamlValueMapper.fromOxcaml<typeof complex>(oxcamlStr);
    expect(roundtrip).toEqual(complex);

    const arr = [1, 2, [3, 4]];
    const arrStr = OxcamlValueMapper.toOxcaml(arr);
    expect(OxcamlValueMapper.fromOxcaml(arrStr)).toEqual(arr);
  });

  it("handles OCaml integer literal suffixes", () => {
    expect(OxcamlValueMapper.fromOxcaml("42l")).toBe(42);
    expect(OxcamlValueMapper.fromOxcaml("-42l")).toBe(-42);
    expect(OxcamlValueMapper.fromOxcaml("100n")).toBe(100);
    expect(OxcamlValueMapper.fromOxcaml("-10n")).toBe(-10);
    expect(OxcamlValueMapper.fromOxcaml("100L")).toBe(100n);
    expect(OxcamlValueMapper.fromOxcaml("-42L")).toBe(-42n);
    expect(OxcamlValueMapper.fromOxcaml("1_000_000")).toBe(1000000);
  });

  it("handles float literals and special floats", () => {
    expect(OxcamlValueMapper.fromOxcaml("3.14")).toBe(3.14);
    expect(OxcamlValueMapper.fromOxcaml("-3.14")).toBe(-3.14);
    expect(OxcamlValueMapper.fromOxcaml("42.0")).toBe(42.0);
    expect(OxcamlValueMapper.fromOxcaml("nan")).toBeNaN();
    expect(OxcamlValueMapper.fromOxcaml("infinity")).toBe(Infinity);
    expect(OxcamlValueMapper.fromOxcaml("neg_infinity")).toBe(-Infinity);
  });

  it("handles char and string literals", () => {
    expect(OxcamlValueMapper.fromOxcaml('"hello"')).toBe("hello");
    expect(OxcamlValueMapper.fromOxcaml("'a'")).toBe("a");
    expect(OxcamlValueMapper.fromOxcaml("'\\n'")).toBe("\n");
    expect(OxcamlValueMapper.fromOxcaml("'\\t'")).toBe("\t");
  });

  it("handles Uint8Array and Bytes literals", () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]);
    const oxcamlLiteral = OxcamlValueMapper.toOxcaml(bytes);
    expect(oxcamlLiteral).toContain("Bytes.of_string");

    const parsed = OxcamlValueMapper.fromOxcaml<Uint8Array>(oxcamlLiteral);
    expect(parsed).toEqual(bytes);

    expect(OxcamlValueMapper.fromOxcaml('Bytes.of_string "hello"')).toEqual(
      new Uint8Array([104, 101, 108, 108, 111])
    );
  });

  it("handles OCaml Option and tuple expressions", () => {
    expect(OxcamlValueMapper.fromOxcaml("Some 42")).toBe(42);
    expect(OxcamlValueMapper.fromOxcaml("Some (42)")).toBe(42);
    expect(OxcamlValueMapper.fromOxcaml('Some "hello"')).toBe("hello");
    expect(OxcamlValueMapper.fromOxcaml("None")).toBeNull();

    expect(OxcamlValueMapper.fromOxcaml("(1, 2)")).toEqual([1, 2]);
    expect(OxcamlValueMapper.fromOxcaml('(1, "two", true)')).toEqual([
      1,
      "two",
      true,
    ]);
    expect(OxcamlValueMapper.fromOxcaml("()")).toBeNull();
  });

  it("handles OCaml list and array expressions", () => {
    expect(OxcamlValueMapper.fromOxcaml("[1; 2; 3]")).toEqual([1, 2, 3]);
    expect(OxcamlValueMapper.fromOxcaml("[]")).toEqual([]);
    expect(OxcamlValueMapper.fromOxcaml("[| 1; 2; 3 |]")).toEqual([1, 2, 3]);
    expect(OxcamlValueMapper.fromOxcaml("[| |]")).toEqual([]);
  });

  it("handles OCaml record expressions", () => {
    expect(OxcamlValueMapper.fromOxcaml("{ x = 10; y = 20 }")).toEqual({
      x: 10,
      y: 20,
    });
  });

  it("integrates with ValueMapper dispatch", () => {
    expect(ValueMapper.toLang("oxcaml", 42)).toBe("42");
    expect(ValueMapper.toLang("oxcaml", true)).toBe("true");
    expect(ValueMapper.toLang("oxcaml", "hi")).toBe('"hi"');
    expect(ValueMapper.fromLang("oxcaml", "42l")).toBe(42);
    expect(ValueMapper.fromLang("oxcaml", "[1; 2; 3]")).toEqual([1, 2, 3]);
  });

  it("formats type-directed OCaml values for Option, floats, char, and integer widths", () => {
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
    expect(OxcamlValueMapper.toOxcaml(42, optInt)).toBe("Some (42)");
    expect(OxcamlValueMapper.toOxcaml(null, optInt)).toBe("None");
    expect(OxcamlValueMapper.toOxcaml(undefined, optInt)).toBe("None");

    const int32Def = new ArgDef(
      "a",
      0,
      ArgTag.NUMBER,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "int32"
    );
    expect(OxcamlValueMapper.toOxcaml(42, int32Def)).toBe("42l");

    const nativeintDef = new ArgDef(
      "b",
      0,
      ArgTag.NUMBER,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "nativeint"
    );
    expect(OxcamlValueMapper.toOxcaml(42, nativeintDef)).toBe("42n");

    const floatOpt: ArgOptions = { ...baseOpt, numInteger: false };
    const floatDef = new ArgDef(
      "c",
      0,
      ArgTag.NUMBER,
      floatOpt,
      0,
      false,
      undefined,
      [],
      "float"
    );
    expect(OxcamlValueMapper.toOxcaml(42, floatDef)).toBe("42.0");
    expect(OxcamlValueMapper.toOxcaml(3.14, floatDef)).toBe("3.14");

    const charOpt: ArgOptions = {
      ...baseOpt,
      strLength: { min: 1, max: 1 },
    };
    const charDef = new ArgDef(
      "d",
      0,
      ArgTag.STRING,
      charOpt,
      0,
      false,
      undefined,
      [],
      "char"
    );
    expect(OxcamlValueMapper.toOxcaml("c", charDef)).toBe("'c'");
    expect(OxcamlValueMapper.toOxcaml("\n", charDef)).toBe("'\\n'");

    const unitDef = new ArgDef(
      "u",
      0,
      ArgTag.OBJECT,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "unit"
    );
    expect(OxcamlValueMapper.toOxcaml(null, unitDef)).toBe("()");

    const arrayDef = new ArgDef(
      "arr",
      0,
      ArgTag.NUMBER,
      baseOpt,
      1,
      false,
      undefined,
      [],
      "int array"
    );
    expect(OxcamlValueMapper.toOxcaml([1, 2, 3], arrayDef)).toBe(
      "[| 1; 2; 3 |]"
    );
    expect(OxcamlValueMapper.toOxcaml([], arrayDef)).toBe("[| |]");
  });

  it("formats and parses Set, Map, Hashtbl, and Record types with round-tripping", () => {
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

    // 1. Set round-trip
    const setDef = new ArgDef(
      "s",
      0,
      ArgTag.SET,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "IntSet.t"
    );
    const originalSet = new Set([10, 20, 30]);
    const setFormatted = OxcamlValueMapper.toOxcaml(originalSet, setDef);
    expect(setFormatted).toBe("IntSet.of_list [10; 20; 30]");
    const setParsed = OxcamlValueMapper.fromOxcaml<Set<number>>(setFormatted);
    expect(setParsed).toEqual(originalSet);

    // Empty Set
    const emptySetFormatted = OxcamlValueMapper.toOxcaml(new Set(), setDef);
    expect(emptySetFormatted).toBe("IntSet.empty");
    expect(
      OxcamlValueMapper.fromOxcaml<Set<number>>(emptySetFormatted)
    ).toEqual(new Set());

    // 2. Hashtbl round-trip
    const hashtblDef = new ArgDef(
      "tbl",
      0,
      ArgTag.DICTIONARY,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "(string, int) Hashtbl.t"
    );
    const originalMap = new Map([
      ["apple", 5],
      ["banana", 8],
    ]);
    const hashtblFormatted = OxcamlValueMapper.toOxcaml(
      originalMap,
      hashtblDef
    );
    expect(hashtblFormatted).toContain("Hashtbl.of_seq");
    const hashtblParsed =
      OxcamlValueMapper.fromOxcaml<Map<string, number>>(hashtblFormatted);
    expect(hashtblParsed).toEqual(originalMap);

    // 3. Functor Map round-trip
    const mapDef = new ArgDef(
      "m",
      0,
      ArgTag.DICTIONARY,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "int StringMap.t"
    );
    const mapFormatted = OxcamlValueMapper.toOxcaml(originalMap, mapDef);
    expect(mapFormatted).toBe(
      '(StringMap.of_seq (List.to_seq [("apple", 5); ("banana", 8)]))'
    );
    const mapParsed =
      OxcamlValueMapper.fromOxcaml<Map<string, number>>(mapFormatted);
    expect(mapParsed).toEqual(originalMap);

    // 4. Record round-trip
    const userObj = { name: "Carol", age: 32 };
    const userFormatted = OxcamlValueMapper.toOxcaml(userObj);
    expect(userFormatted).toBe('{ name = "Carol"; age = 32 }');
    const userParsed = OxcamlValueMapper.fromOxcaml(userFormatted);
    expect(userParsed).toEqual(userObj);

    // 5. Association list round-trip
    const tupleDef = new ArgDef(
      "item",
      0,
      ArgTag.TUPLE,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "string * int"
    );
    const assocDef = new ArgDef(
      "l",
      0,
      ArgTag.OBJECT,
      baseOpt,
      1,
      false,
      undefined,
      [tupleDef],
      "(string * int) list"
    );
    const assocPairs = [
      ["k1", 100],
      ["k2", 200],
    ];
    const assocFormatted = OxcamlValueMapper.toOxcaml(assocPairs, assocDef);
    expect(assocFormatted).toBe('[("k1", 100); ("k2", 200)]');
    expect(OxcamlValueMapper.fromOxcaml(assocFormatted)).toEqual(assocPairs);
  });

  it("round-trips list, array, tuples, option, bytes, and record with ArgDef context", () => {
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

    // 1. Lists (including nested)
    const intElem = new ArgDef(
      "elem",
      0,
      ArgTag.NUMBER,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "int"
    );
    const intListDef = new ArgDef(
      "l",
      0,
      ArgTag.NUMBER,
      baseOpt,
      1,
      false,
      undefined,
      [intElem],
      "int list"
    );
    const listVal = [10, 20, 30];
    const listStr = OxcamlValueMapper.toOxcaml(listVal, intListDef);
    expect(listStr).toBe("[10; 20; 30]");
    expect(OxcamlValueMapper.fromOxcaml(listStr)).toEqual(listVal);

    const emptyListStr = OxcamlValueMapper.toOxcaml([], intListDef);
    expect(emptyListStr).toBe("[]");
    expect(OxcamlValueMapper.fromOxcaml(emptyListStr)).toEqual([]);

    // 2. Arrays (including empty)
    const intArrayDef = new ArgDef(
      "arr",
      0,
      ArgTag.NUMBER,
      baseOpt,
      1,
      false,
      undefined,
      [intElem],
      "int array"
    );
    const arrVal = [100, 200];
    const arrStr = OxcamlValueMapper.toOxcaml(arrVal, intArrayDef);
    expect(arrStr).toBe("[| 100; 200 |]");
    expect(OxcamlValueMapper.fromOxcaml(arrStr)).toEqual(arrVal);

    const emptyArrStr = OxcamlValueMapper.toOxcaml([], intArrayDef);
    expect(emptyArrStr).toBe("[| |]");
    expect(OxcamlValueMapper.fromOxcaml(emptyArrStr)).toEqual([]);

    // 3. Tuples (2-tuple and 3-tuple)
    const strElem = new ArgDef(
      "s",
      0,
      ArgTag.STRING,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "string"
    );
    const boolElem = new ArgDef(
      "b",
      0,
      ArgTag.BOOLEAN,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "bool"
    );
    const tuple2Def = new ArgDef(
      "p",
      0,
      ArgTag.TUPLE,
      baseOpt,
      0,
      false,
      undefined,
      [intElem, strElem],
      "int * string"
    );
    const tuple2Val = [42, "hello"];
    const tuple2Str = OxcamlValueMapper.toOxcaml(tuple2Val, tuple2Def);
    expect(tuple2Str).toBe('(42, "hello")');
    expect(OxcamlValueMapper.fromOxcaml(tuple2Str)).toEqual(tuple2Val);

    const tuple3Def = new ArgDef(
      "t",
      0,
      ArgTag.TUPLE,
      baseOpt,
      0,
      false,
      undefined,
      [boolElem, intElem, strElem],
      "bool * int * string"
    );
    const tuple3Val = [true, 7, "world"];
    const tuple3Str = OxcamlValueMapper.toOxcaml(tuple3Val, tuple3Def);
    expect(tuple3Str).toBe('(true, 7, "world")');
    expect(OxcamlValueMapper.fromOxcaml(tuple3Str)).toEqual(tuple3Val);

    // 4. Option (Some and None)
    const optDef = new ArgDef(
      "opt",
      0,
      ArgTag.NUMBER,
      baseOpt,
      0,
      true,
      undefined,
      [],
      "int"
    );
    const someStr = OxcamlValueMapper.toOxcaml(99, optDef);
    expect(someStr).toBe("Some (99)");
    expect(OxcamlValueMapper.fromOxcaml(someStr)).toBe(99);

    const noneStr = OxcamlValueMapper.toOxcaml(null, optDef);
    expect(noneStr).toBe("None");
    expect(OxcamlValueMapper.fromOxcaml(noneStr)).toBeNull();

    // 5. Bytes
    const bytesDef = new ArgDef(
      "b",
      0,
      ArgTag.BYTES,
      baseOpt,
      0,
      false,
      undefined,
      [],
      "bytes"
    );
    const bytesVal = new Uint8Array([0, 10, 255]);
    const bytesStr = OxcamlValueMapper.toOxcaml(bytesVal, bytesDef);
    expect(bytesStr).toContain("Bytes.of_string");
    expect(OxcamlValueMapper.fromOxcaml<Uint8Array>(bytesStr)).toEqual(
      bytesVal
    );

    // 6. Record (flat and nested)
    const nestedObj = {
      header: { id: 1, title: "Doc" },
      active: true,
    };
    const nestedStr = OxcamlValueMapper.toOxcaml(nestedObj);
    expect(nestedStr).toBe(
      '{ header = { id = 1; title = "Doc" }; active = true }'
    );
    expect(OxcamlValueMapper.fromOxcaml(nestedStr)).toEqual(nestedObj);
  });
});
