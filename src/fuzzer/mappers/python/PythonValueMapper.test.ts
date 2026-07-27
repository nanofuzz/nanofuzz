import * as PythonValueMapper from "./PythonValueMapper";

describe("fuzzer/mappers/python/PythonValueMapper: ", () => {
  it("round-trip values", () => {
    [
      //null,
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
        //nullValue: null,
        nanValue: NaN,
        arrayValue: [
          //null,
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
        //null,
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
          //nullValue: null
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
