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
});
