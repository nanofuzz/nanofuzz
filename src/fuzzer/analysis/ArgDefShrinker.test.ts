import seedrandom from "seedrandom";
import { ArgDef } from "./ArgDef";
import { ArgDefShrinker } from "./ArgDefShrinker";
import { ArgTag, ArgOptions, ArgValueTypeWrapped } from "./Types";
import { initParser } from "../FuzzerTestHelper";
import * as JSONN from "../../Jsonn";

const dummyModule = "/tmp/dummy.ts";
const argOptions: ArgOptions = ArgDef.getDefaultOptions();

function makeTypeRef(
  moduleName: string,
  name: string,
  type: ArgTag,
  dim: number
): ArgDef {
  return new ArgDef(name, 0, type, { ...argOptions }, dim, false);
}

function makeArgDef(
  moduleName: string,
  name: string,
  offset: number,
  type: ArgTag,
  options: ArgOptions,
  dim: number,
  isOptional: boolean,
  children: ArgDef[] = []
): ArgDef {
  return new ArgDef(
    name,
    offset,
    type,
    options,
    dim,
    isOptional,
    [{ min: 0, max: 100 }],
    children
  );
}

describe("ArgDefShrinker", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("filters for mutators with simplifies: true", () => {
    const spec = makeArgDef(
      dummyModule,
      "arrArg",
      0,
      ArgTag.NUMBER,
      {
        ...argOptions,
        dimLength: [{ min: 0, max: 5 }],
      },
      1,
      false
    );
    const input: ArgValueTypeWrapped[] = [
      {
        tag: "ArgValueTypeWrapped",
        value: [10, 20, 30],
      },
    ];
    const prng = seedrandom("shrinkerArray");
    const shrinkers = ArgDefShrinker.getShrinkers([spec], input, prng);

    expect(shrinkers.length).toBeGreaterThan(0);
    expect(shrinkers.every((s) => s.simplifies === true)).toBeTrue();
    const names = shrinkers.map((s) => s.name);
    expect(names).toContain("array-clear");
    expect(names.some((n) => n.startsWith("array-deleteElement"))).toBeTrue();
    expect(names).not.toContain("array-jumble");
    expect(names).not.toContain("array-reverse");
    expect(names).not.toContain("array-appendNewElement");
  });

  it("shrink numbers towards zero", () => {
    const spec = makeArgDef(
      dummyModule,
      "numArg",
      0,
      ArgTag.NUMBER,
      {
        ...argOptions,
        numInteger: true,
      },
      0,
      false
    );
    const input: ArgValueTypeWrapped[] = [
      {
        tag: "ArgValueTypeWrapped",
        value: 100,
      },
    ];
    const prng = seedrandom("shrinkerNumber");
    const shrinkers = ArgDefShrinker.getShrinkers([spec], input, prng);

    expect(shrinkers.every((s) => s.simplifies === true)).toBeTrue();
    const names = shrinkers.map((s) => s.name);
    expect(names).toContain("number-setToZero");
    expect(names).toContain("number-divTwo");
    expect(names).not.toContain("number-timesTwo");
    expect(names).not.toContain("number-plusOne");
  });

  it("shrinks strings to shorter strings", () => {
    const spec = makeArgDef(
      dummyModule,
      "strArg",
      0,
      ArgTag.STRING,
      {
        ...argOptions,
        strLength: { min: 0, max: 20 },
      },
      0,
      false
    );
    const input: ArgValueTypeWrapped[] = [
      {
        tag: "ArgValueTypeWrapped",
        value: "hello",
      },
    ];
    const prng = seedrandom("shrinkerString");
    const shrinkers = ArgDefShrinker.getShrinkers([spec], input, prng);

    expect(shrinkers.every((s) => s.simplifies === true)).toBeTrue();
    const names = shrinkers.map((s) => s.name);
    expect(names).toContain("string-clear");
    expect(names).toContain("string-deleteOneChar");
    expect(names).not.toContain("string-insertOneChar");
    expect(names).not.toContain("string-replaceOneChar");
  });

  it("shrinks objects", () => {
    const child1 = makeArgDef(
      dummyModule,
      "requiredProp",
      0,
      ArgTag.NUMBER,
      argOptions,
      0,
      false
    );
    const child2 = makeArgDef(
      dummyModule,
      "optionalProp",
      0,
      ArgTag.STRING,
      argOptions,
      0,
      true
    );
    const spec = makeArgDef(
      dummyModule,
      "objArg",
      0,
      ArgTag.OBJECT,
      argOptions,
      0,
      false,
      [child1, child2]
    );
    const input: ArgValueTypeWrapped[] = [
      {
        tag: "ArgValueTypeWrapped",
        value: { requiredProp: 42, optionalProp: "removeMe" },
      },
    ];
    const prng = seedrandom("shrinkerObject");
    const shrinkers = ArgDefShrinker.getShrinkers([spec], input, prng);

    expect(shrinkers.every((s) => s.simplifies === true)).toBeTrue();
    const names = shrinkers.map((s) => s.name);
    expect(names).toContain("optional-delete");
    expect(names).not.toContain("optional-genMember");
  });

  it("shrinks dictionaries", () => {
    const spec = makeArgDef(
      dummyModule,
      "dictArg",
      0,
      ArgTag.DICTIONARY,
      {
        ...argOptions,
        dictLength: { min: 0, max: 10 },
      },
      0,
      false,
      [
        makeTypeRef(dummyModule, "keys", ArgTag.STRING, 0),
        makeTypeRef(dummyModule, "values", ArgTag.NUMBER, 0),
      ]
    );
    const input: ArgValueTypeWrapped[] = [
      {
        tag: "ArgValueTypeWrapped",
        value: { a: 10, b: 20 },
      },
    ];
    const prng = seedrandom("shrinkerDict");
    const shrinkers = ArgDefShrinker.getShrinkers([spec], input, prng);

    expect(shrinkers.every((s) => s.simplifies === true)).toBeTrue();
    const names = shrinkers.map((s) => s.name);
    expect(names).toContain("dictionary-clear");
    expect(names).toContain("dictionary-deleteEntry0");
    expect(names).toContain("dictionary-deleteEntry1");
    expect(names).not.toContain("dictionary-addEntry");
    expect(names).not.toContain("dictionary-renameKey0");
  });

  it("shrinks sets", () => {
    const spec = makeArgDef(
      dummyModule,
      "setArg",
      0,
      ArgTag.SET,
      {
        ...argOptions,
        setLength: { min: 0, max: 10 },
      },
      0,
      false,
      [makeTypeRef(dummyModule, "values", ArgTag.NUMBER, 0)]
    );
    const input: ArgValueTypeWrapped[] = [
      {
        tag: "ArgValueTypeWrapped",
        value: new Set([10, 20]),
      },
    ];
    const prng = seedrandom("shrinkerSet");
    const shrinkers = ArgDefShrinker.getShrinkers([spec], input, prng);

    expect(shrinkers.every((s) => s.simplifies === true)).toBeTrue();
    const names = shrinkers.map((s) => s.name);
    expect(names).toContain("set-clear");
    expect(names).toContain("set-deleteElement0");
    expect(names).not.toContain("set-addUniqueElement");
  });

  it("shrinks bytes", () => {
    const spec = makeArgDef(
      dummyModule,
      "bytesArg",
      0,
      ArgTag.BYTES,
      {
        ...argOptions,
        byteLength: { min: 0, max: 10 },
      },
      0,
      false
    );
    const input: ArgValueTypeWrapped[] = [
      {
        tag: "ArgValueTypeWrapped",
        value: new Uint8Array([0xff]), // 0b11111111 - all bits set
      },
    ];
    const prng = seedrandom("shrinkerBytes");
    const shrinkers = ArgDefShrinker.getShrinkers([spec], input, prng);

    expect(shrinkers.every((s) => s.simplifies === true)).toBeTrue();
    const names = shrinkers.map((s) => s.name);
    expect(names).toContain("bytes-clear");
    expect(names).toContain("bytes-deleteOneByte");
    expect(names).toContain("bytes-flipBit"); // bit is 1, so flipping to 0 simplifies
    expect(names).not.toContain("bytes-insertOneByte");
  });

  it("shrinker produce simplified input", () => {
    const spec = makeArgDef(
      dummyModule,
      "arrArg",
      0,
      ArgTag.NUMBER,
      {
        ...argOptions,
        dimLength: [{ min: 0, max: 5 }],
      },
      1,
      false
    );
    const input: ArgValueTypeWrapped[] = [
      {
        tag: "ArgValueTypeWrapped",
        value: [10, 20, 30],
      },
    ];
    const prng = seedrandom("execShrinker");
    const shrinkers = ArgDefShrinker.getShrinkers([spec], input, prng);
    const clearShrinker = shrinkers.find((s) => s.name === "array-clear");

    expect(clearShrinker).toBeDefined();
    clearShrinker?.fn();
    expect(JSONN.stringify(input[0].value)).toEqual("[]");
  });
});
