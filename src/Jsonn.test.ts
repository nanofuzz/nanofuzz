import * as JSONN from "./Jsonn";
import { isKeyedObject, makeCanonicalSet } from "./Util";

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
      new Uint8Array([187, 123, 1, 237, 243, 43]),
      {
        trueValue: true,
        noValue: undefined,
        nullValue: null,
        nanValue: NaN,
        bigintValue1: BigInt(100),
        bigintValue2: 100n,
        bytesValue: new Uint8Array([187, 123, 1, 237, 243, 43]),
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
          new Uint8Array([187, 123, 1, 237, 243, 43]),
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
        new Uint8Array([187, 123, 1, 237, 243, 43]),
        {
          trueValue: true,
          noValue: undefined,
          nanValue: NaN,
          nullValue: null,
          bigintValue1: BigInt(100),
          bigintValue2: 100n,
          bytesValue: new Uint8Array([187, 123, 1, 237, 243, 43]),
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

  it("serializes and parses Uint8Array", () => {
    const bytesVal = new Uint8Array([187, 123, 1, 237, 243, 43]);
    const jsonnStr = JSONN.stringify(bytesVal);
    expect(jsonnStr).toEqual(
      "{____JSONN____61581952310____UINT8ARRAY____:[187,123,1,237,243,43]}"
    );

    const parsedVal = JSONN.parse<Uint8Array>(jsonnStr);
    expect(parsedVal instanceof Uint8Array).toBeTrue();
    expect(parsedVal).toEqual(bytesVal);
  });

  it("canonicalizes Set iteration order during serialization and revival", () => {
    const set1 = makeCanonicalSet([3, 1, 2]);
    const set2 = makeCanonicalSet([1, 2, 3]);

    const jsonn1 = JSONN.stringify(set1);
    const jsonn2 = JSONN.stringify(set2);

    expect(jsonn1).toEqual(jsonn2);
    expect(jsonn1).toEqual("{____JSONN____61581952310____SET____:[1,2,3]}");

    const revived = JSONN.parse<Set<number>>(jsonn1);
    expect(revived instanceof Set).toBeTrue();
    expect(Array.from(revived.values())).toEqual([1, 2, 3]);
  });
});
