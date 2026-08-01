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
      BigInt(100),
      100n,
      {
        trueValue: true,
        noValue: undefined,
        nullValue: null,
        nanValue: NaN,
        bigintValue1: BigInt(100),
        bigintValue2: 100n,
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
          BigInt(100),
          100n,
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
        BigInt(100),
        100n,
        {
          trueValue: true,
          noValue: undefined,
          nanValue: NaN,
          nullValue: null,
          bigintValue1: BigInt(100),
          bigintValue2: 100n,
        },
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
});
