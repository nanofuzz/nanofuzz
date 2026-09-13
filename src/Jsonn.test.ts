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
      makeCanonicalSet([1, 2, 3]),
      new Map<string, unknown>([
        ["a", 1],
        ["b", "test"],
      ]),
      {
        trueValue: true,
        noValue: undefined,
        nullValue: null,
        nanValue: NaN,
        bigintValue1: BigInt(100),
        bigintValue2: 100n,
        bytesValue: new Uint8Array([187, 123, 1, 237, 243, 43]),
        setValue: makeCanonicalSet([1, 2, 3]),
        mapValue: new Map<string, unknown>([
          ["a", 1],
          ["b", "test"],
        ]),
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
          makeCanonicalSet([1, 2, 3]),
          new Map<string, unknown>([
            ["a", 1],
            ["b", "test"],
          ]),
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
        makeCanonicalSet([1, 2, 3]),
        new Map<string, unknown>([
          ["a", 1],
          ["b", "test"],
        ]),
        {
          trueValue: true,
          noValue: undefined,
          nanValue: NaN,
          nullValue: null,
          bigintValue1: BigInt(100),
          bigintValue2: 100n,
          bytesValue: new Uint8Array([187, 123, 1, 237, 243, 43]),
          setValue: makeCanonicalSet([1, 2, 3]),
          mapValue: new Map<string, unknown>([
            ["a", 1],
            ["b", "test"],
          ]),
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

  it("serializes and parses Map", () => {
    const mapVal = new Map<string, unknown>([
      ["a", 1],
      ["b", "test"],
    ]);
    const jsonnStr = JSONN.stringify(mapVal);
    expect(jsonnStr).toEqual(
      "{____JSONN____61581952310____MAP____:[['a',1],['b','test']]}"
    );

    const parsedVal = JSONN.parse<Map<string, unknown>>(jsonnStr);
    expect(parsedVal instanceof Map).toBeTrue();
    expect(parsedVal).toEqual(mapVal);
  });

  it("pack/unpack values", () => {
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
      makeCanonicalSet([1, 2, 3]),
      new Map<string, unknown>([
        ["a", 1],
        ["b", "test"],
      ]),
      {
        trueValue: true,
        noValue: undefined,
        nullValue: null,
        nanValue: NaN,
        bigintValue1: BigInt(100),
        bigintValue2: 100n,
        bytesValue: new Uint8Array([187, 123, 1, 237, 243, 43]),
        setValue: makeCanonicalSet([1, 2, 3]),
        mapValue: new Map<string, unknown>([
          ["a", 1],
          ["b", "test"],
        ]),
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
          makeCanonicalSet([1, 2, 3]),
          new Map<string, unknown>([
            ["a", 1],
            ["b", "test"],
          ]),
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
        makeCanonicalSet([1, 2, 3]),
        new Map<string, unknown>([
          ["a", 1],
          ["b", "test"],
        ]),
        {
          trueValue: true,
          noValue: undefined,
          nanValue: NaN,
          nullValue: null,
          bigintValue1: BigInt(100),
          bigintValue2: 100n,
          bytesValue: new Uint8Array([187, 123, 1, 237, 243, 43]),
          setValue: makeCanonicalSet([1, 2, 3]),
          mapValue: new Map<string, unknown>([
            ["a", 1],
            ["b", "test"],
          ]),
        },
      ],
    ].forEach((value) => {
      const packed = JSONN.pack(value);
      const roundtripValue = JSONN.unpack<typeof value>(packed);
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

  it("pack/unpack Uint8Array", () => {
    const bytesVal = new Uint8Array([187, 123, 1, 237, 243, 43]);
    const packed = JSONN.pack(bytesVal);
    const unpacked = JSONN.unpack<Uint8Array>(packed);

    expect(unpacked instanceof Uint8Array).toBeTrue();
    expect(unpacked).toEqual(bytesVal);
  });

  it("pack/unpack Set and Map", () => {
    const setVal = makeCanonicalSet([3, 1, 2]);
    const mapVal = new Map<string, unknown>([
      ["a", 1],
      ["b", "test"],
    ]);

    const packedSet = JSONN.pack(setVal);
    const unpackedSet = JSONN.unpack<Set<number>>(packedSet);
    expect(unpackedSet instanceof Set).toBeTrue();
    expect(Array.from(unpackedSet.values())).toEqual([1, 2, 3]);

    const packedMap = JSONN.pack(mapVal);
    const unpackedMap = JSONN.unpack<Map<string, unknown>>(packedMap);
    expect(unpackedMap instanceof Map).toBeTrue();
    expect(unpackedMap).toEqual(mapVal);
  });
});
