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

  it("Uint8Array to/from Python bytes literal expressions", () => {
    const bytesVal = new Uint8Array([187, 123, 1, 237, 243, 43]);

    // toPython converts Uint8Array to Python b'...' literal syntax
    const pythonCode = PythonValueMapper.toPython(bytesVal);
    expect(pythonCode).toEqual("b'\\xbb{\\x01\\xed\\xf3+'");

    // fromPython parses Python bytes literal back to Uint8Array
    const parsedFromLiteral =
      PythonValueMapper.fromPython<Uint8Array>(pythonCode);
    expect(parsedFromLiteral).toEqual(bytesVal);

    // fromPython also parses simple b"hello" bytes literal
    expect(PythonValueMapper.fromPython('b"hello"')).toEqual(
      new Uint8Array([104, 101, 108, 108, 111])
    );

    // fromPython also parses bytes([...]) constructor calls
    expect(
      PythonValueMapper.fromPython("bytes([187, 123, 1, 237, 243, 43])")
    ).toEqual(bytesVal);

    // Round-trip nested bytes in object
    const nestedObj = { payload: bytesVal, count: 42 };
    const pyDictStr = PythonValueMapper.toPython(nestedObj);
    expect(pyDictStr).toEqual(
      '{"payload": b\'\\xbb{\\x01\\xed\\xf3+\', "count": 42}'
    );
    expect(PythonValueMapper.fromPython(pyDictStr)).toEqual(nestedObj);
  });
});
