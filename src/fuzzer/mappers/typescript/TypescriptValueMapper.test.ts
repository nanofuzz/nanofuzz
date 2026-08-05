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
});
