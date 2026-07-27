import * as PythonValueMapper from "./PythonValueMapper";

describe("fuzzer/mappers/python/PythonValueMapper: ", () => {
  it("round-trip values", () => {
    [
      //null,
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
        arrayValue: [
          //null,
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
      { python: `"hello"`, js: "hello" },
      { python: `"hello 'bob'"`, js: "hello 'bob'" },
      { python: `'hello'`, js: "hello" },
      { python: `'hello "bob"'`, js: `hello "bob"` },
    ].forEach((value) => {
      expect(PythonValueMapper.fromPython(value.python)).toEqual(value.js);
    });
  });
});
