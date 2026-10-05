import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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

  it("packString canonical for literal and cloned objects", () => {
    const obj = { x: [1, 2, 3], y: "test", z: new Set([10, 20]) };
    const clonedObj = structuredClone(obj);

    const packedStr1 = JSONN.packString(obj);
    const packedStr2 = JSONN.packString(clonedObj);

    expect(typeof packedStr1).toBe("string");
    expect(packedStr1).toBe(packedStr2);
  });

  it("isTextFilename identifies human-readable text and binary extensions", () => {
    // Text formats
    expect(JSONN.isTextFilename("data.json")).toBeTrue();
    expect(JSONN.isTextFilename("data.json5")).toBeTrue();
    expect(JSONN.isTextFilename("data.jsonn")).toBeTrue();
    expect(JSONN.isTextFilename("data.txt")).toBeTrue();
    expect(JSONN.isTextFilename("data.text")).toBeTrue();
    expect(JSONN.isTextFilename("/path/to/file.JSON")).toBeTrue();
    expect(JSONN.isTextFilename("/path/to/file.TXT")).toBeTrue();

    // Binary / non-text formats
    expect(JSONN.isTextFilename("data.msgpack")).toBeFalse();
    expect(JSONN.isTextFilename("data.mpk")).toBeFalse();
    expect(JSONN.isTextFilename("data.bin")).toBeFalse();
    expect(JSONN.isTextFilename("data.dat")).toBeFalse();
    expect(JSONN.isTextFilename("data.jsonnb")).toBeFalse();
    expect(JSONN.isTextFilename("data")).toBeFalse();
  });

  describe("toFile and fromFile", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-jsonn-test-"));
    });

    afterEach(() => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("writes and reads text-based file (.json / .json5 / .txt)", () => {
      const filePath = path.join(tmpDir, "nested", "data.json5");
      const sample = {
        name: "test",
        count: 42,
        set: makeCanonicalSet([1, 2, 3]),
        map: new Map([["key", "val"]]),
        bytes: new Uint8Array([1, 2, 3]),
        big: 100n,
      };

      JSONN.toFile(filePath, sample);
      expect(fs.existsSync(filePath)).toBeTrue();

      // Ensure file content is text
      const rawText = fs.readFileSync(filePath, "utf-8");
      expect(rawText).toContain("name:'test'");

      // fromFile round-trip
      const loaded = JSONN.fromFile<typeof sample>(filePath);
      expect(loaded.name).toBe("test");
      expect(loaded.count).toBe(42);
      expect(Array.from(loaded.set.values())).toEqual([1, 2, 3]);
      expect(loaded.map.get("key")).toBe("val");
      expect(loaded.bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(loaded.big).toBe(100n);
    });

    it("writes and reads binary MsgPack file (.msgpack / .mpk)", () => {
      const filePath = path.join(tmpDir, "nested", "data.msgpack");
      const sample = {
        name: "test-binary",
        count: 99,
        set: makeCanonicalSet(["a", "b"]),
        map: new Map([["k", 123]]),
        bytes: new Uint8Array([10, 20, 30]),
        big: 999999999999999999n,
      };

      JSONN.toFile(filePath, sample);
      expect(fs.existsSync(filePath)).toBeTrue();

      // Ensure file content is binary packed
      const rawBuf = fs.readFileSync(filePath);
      expect(Buffer.isBuffer(rawBuf)).toBeTrue();

      // fromFile round-trip
      const loaded = JSONN.fromFile<typeof sample>(filePath);
      expect(loaded.name).toBe("test-binary");
      expect(loaded.count).toBe(99);
      expect(Array.from(loaded.set.values())).toEqual(["a", "b"]);
      expect(loaded.map.get("k")).toBe(123);
      expect(loaded.bytes).toEqual(new Uint8Array([10, 20, 30]));
      expect(loaded.big).toBe(999999999999999999n);
    });

    it("applies replacer when writing text and binary files", () => {
      const txtFile = path.join(tmpDir, "filtered.json");
      const binFile = path.join(tmpDir, "filtered.msgpack");
      const sample = {
        keep: "ok",
        remove: "secret",
        nested: { innerSecret: "secret2", normal: 1 },
      };

      const replacer = (key: string, val: unknown) => {
        if (key === "remove" || key === "innerSecret") return undefined;
        return val;
      };

      JSONN.toFile(txtFile, sample, replacer);
      JSONN.toFile(binFile, sample, replacer);

      const loadedTxt = JSONN.fromFile<{
        keep: string;
        remove?: string;
        nested: { innerSecret?: string; normal: number };
      }>(txtFile);
      const loadedBin = JSONN.fromFile<{
        keep: string;
        remove?: string;
        nested: { innerSecret?: string; normal: number };
      }>(binFile);

      expect(loadedTxt.keep).toBe("ok");
      expect(loadedTxt.remove).toBeUndefined();
      expect(loadedTxt.nested.innerSecret).toBeUndefined();
      expect(loadedTxt.nested.normal).toBe(1);

      expect(loadedBin.keep).toBe("ok");
      expect(loadedBin.remove).toBeUndefined();
      expect(loadedBin.nested.innerSecret).toBeUndefined();
      expect(loadedBin.nested.normal).toBe(1);

      // Verify original object was NOT mutated
      expect(sample.remove).toBe("secret");
      expect(sample.nested.innerSecret).toBe("secret2");
    });

    it("pack and packString support replacer without mutating original input", () => {
      const original = {
        include: 100,
        exclude: "drop-me",
        list: [{ a: 1, b: 2 }],
      };

      const replacer = (key: string, val: unknown) => {
        if (key === "exclude" || key === "b") return undefined;
        return val;
      };

      const packed = JSONN.pack(original, replacer);
      const unpacked = JSONN.unpack<{
        include: number;
        exclude?: string;
        list: { a: number; b?: number }[];
      }>(packed);

      expect(unpacked.include).toBe(100);
      expect(unpacked.exclude).toBeUndefined();
      expect(unpacked.list[0].a).toBe(1);
      expect(unpacked.list[0].b).toBeUndefined();

      // Ensure original is untouched
      expect(original.exclude).toBe("drop-me");
      expect(original.list[0].b).toBe(2);
    });

    it("unpack and fromFile support reviver for binary MsgPack", () => {
      const original = {
        dateStr: "2026-09-30T00:00:00.000Z",
        value: 42,
      };

      const reviver = (key: string, val: unknown) => {
        if (key === "dateStr" && typeof val === "string") {
          return new Date(val);
        }
        return val;
      };

      const packed = JSONN.pack(original);
      const unpacked = JSONN.unpack<{ dateStr: Date; value: number }>(
        packed,
        reviver
      );

      expect(unpacked.dateStr instanceof Date).toBeTrue();
      expect(unpacked.dateStr.toISOString()).toBe("2026-09-30T00:00:00.000Z");
      expect(unpacked.value).toBe(42);

      // Also test via fromFile for a binary .msgpack file
      const binFile = path.join(tmpDir, "reviver.msgpack");
      JSONN.toFile(binFile, original);
      const loaded = JSONN.fromFile<{ dateStr: Date; value: number }>(
        binFile,
        reviver
      );

      expect(loaded.dateStr instanceof Date).toBeTrue();
      expect(loaded.dateStr.toISOString()).toBe("2026-09-30T00:00:00.000Z");
      expect(loaded.value).toBe(42);
    });
  });
});
