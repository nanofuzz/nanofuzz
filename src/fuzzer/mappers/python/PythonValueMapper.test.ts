import * as PythonValueMapper from "./PythonValueMapper";
import * as Parser from "../../adapters/ParserAdapter";

describe("fuzzer/mappers/python/PythonValueMapper: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("round-trip values", () => {
    [
      //null,
      NaN,
      //undefined, not round trippable
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
        //noValue: undefined, not round trippable
        nullValue: null,
        nanValue: NaN,
        arrayValue: [
          null,
          NaN,
          //undefined, not round trippable
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
        //undefined, not round trippable
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
          //noValue: undefined, not round trippable
          nullValue: null,
          nanValue: NaN,
        },
      ],
    ].forEach((value) => {
      const pythonStr = PythonValueMapper.toPython(value);
      const roundtripValue = PythonValueMapper.fromPython(pythonStr);
      expect(roundtripValue).toEqual(value);
    });
  });

  it("single/double quoted strings", () => {
    [
      { str: `"hello"`, val: "hello" },
      { str: `"hello 'bob'"`, val: "hello 'bob'" },
      { str: `'hello'`, val: "hello" },
      { str: `'hello "bob"'`, val: `hello "bob"` },
    ].forEach((value) => {
      expect(PythonValueMapper.fromPython(value.str)).toEqual(value.val);
    });
  });
});
