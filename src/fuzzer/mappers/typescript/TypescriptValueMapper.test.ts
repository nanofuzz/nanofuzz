import * as TypescriptValueMapper from "./TypescriptValueMapper";
import * as Parser from "../../adapters/ParserAdapter";

describe("fuzzer/mappers/typescript/TypescriptValueMapper: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("round-trip values", () => {
    [
      null,
      NaN,
      undefined,
      true,
      false,
      Infinity,
      -Infinity,
      3,
      "hello",
      true,
      false,
      {
        trueValue: true,
        noValue: undefined,
        nullValue: null,
        nanValue: NaN,
        arrayValue: [
          null,
          NaN,
          undefined,
          true,
          false,
          Infinity,
          -Infinity,
          3,
          "hello",
          true,
          false,
        ],
      },
      [
        null,
        NaN,
        undefined,
        true,
        false,
        Infinity,
        -Infinity,
        3,
        "hello",
        true,
        false,
        {
          trueValue: true,
          noValue: undefined,
          nullValue: null,
          nanValue: NaN,
        },
      ],
    ].forEach((value) => {
      const tsStr = TypescriptValueMapper.toTypescript(value);
      const roundtripValue = TypescriptValueMapper.fromTypescript(tsStr);
      expect(roundtripValue).toEqual(value);
    });
  });

  it("single/double quoted strings", () => {
    [
      { str: `"hello"`, val: `hello` },
      { str: `"hello 'bob'"`, val: `hello 'bob'` },
      { str: `'hello'`, val: `hello` },
      { str: `'hello "bob"'`, val: `hello "bob"` },
    ].forEach((value) => {
      expect(TypescriptValueMapper.fromTypescript(value.str)).toEqual(
        value.val
      );
    });
  });

  it("Uint8Arrays", () => {
    const bytesVal = new Uint8Array([187, 123, 1, 237, 243, 43]);

    // toTypescript converts Uint8Array to 'new Uint8Array([...])' constructor syntax
    const tsCode = TypescriptValueMapper.toTypescript(bytesVal);
    expect(tsCode).toEqual("new Uint8Array([187, 123, 1, 237, 243, 43])");

    // fromTypescript parses TypeScript 'new Uint8Array([...])' back to Uint8Array
    const parsedFromTs =
      TypescriptValueMapper.fromTypescript<Uint8Array>(tsCode);
    expect(parsedFromTs).toEqual(bytesVal);

    // fromTypescript also parses Uint8Array.fromHex("...")
    const parsedFromHex = TypescriptValueMapper.fromTypescript<Uint8Array>(
      'Uint8Array.fromHex("000f7fff")'
    );
    expect(parsedFromHex).toEqual(new Uint8Array([0, 15, 127, 255]));

    // fromTypescript parses Buffer.from("...", "hex")
    const parsedBufferHex = TypescriptValueMapper.fromTypescript<Uint8Array>(
      'Buffer.from("000f7fff", "hex")'
    );
    expect(parsedBufferHex).toEqual(new Uint8Array([0, 15, 127, 255]));

    // Round-trip nested Uint8Array inside object
    const nestedObj = { payload: bytesVal, id: 100 };
    const tsObjStr = TypescriptValueMapper.toTypescript(nestedObj);
    expect(TypescriptValueMapper.fromTypescript(tsObjStr)).toEqual(nestedObj);
  });

  it("Maps", () => {
    const mapVal = new Map<unknown, unknown>([
      ["a", 1],
      ["b", true],
    ]);

    const tsCode = TypescriptValueMapper.toTypescript(mapVal);
    expect(tsCode).toEqual('new Map([["a", 1], ["b", true]])');

    const parsedMap =
      TypescriptValueMapper.fromTypescript<Map<unknown, unknown>>(tsCode);
    expect(parsedMap instanceof Map).toBeTrue();
    expect(parsedMap).toEqual(mapVal);
  });
});
