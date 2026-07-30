import * as JSONN from "./Jsonn";
import { isKeyedObject } from "./Util";

describe("JSONN: ", () => {
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
        { trueValue: true, noValue: undefined, nanValue: NaN, nullValue: null },
      ],
    ].forEach((value) => {
      const roundtripValue = JSONN.parse<typeof value>(JSONN.stringify(value));
      expect(roundtripValue).toEqual(value);

      // Jasmine ignores keys with an unknown value, so we need an extra check here
      // to ensure those are preserved by JSONN.
      if (isKeyedObject(value)) {
        let key: keyof typeof value;
        for (key in value) {
          if (value[key] === undefined && isKeyedObject(roundtripValue)) {
            expect(key in roundtripValue).toBeTrue();
            expect(roundtripValue[key]).toBeUndefined();
          }
        }
      }
    });
  });

  /* !!!!!!!!!!
  it("Issue #301", () => {
    const input = { a: undefined };
    const serializedInput = JSONN.stringify(input);
    const roundtripValue = JSONN.parse<object>(serializedInput);
    expect(serializedInput).toEqual("{a: undefined}");
    expect("a" in roundtripValue).toBeTrue();
    expect(isKeyedObject(roundtripValue)).toBeTrue();
    if (isKeyedObject(roundtripValue)) {
      expect(roundtripValue["a"]).toBeUndefined();
    }
  });
  */
});
