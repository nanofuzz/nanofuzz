import { ArgDef } from "./ArgDef";
import { ArgDefValidator } from "./ArgDefValidator";
import { makeArgDef, makeTypeRef } from "./TestUtils";
import { ArgTag } from "./Types";

const argOptions = ArgDef.getDefaultOptions();
const dummyModule = "dummy.ts";

const tupleDef = makeArgDef(
  dummyModule,
  "test",
  0,
  ArgTag.TUPLE,
  argOptions,
  0,
  false,
  [
    makeTypeRef(dummyModule, "number", ArgTag.NUMBER, 1),
    makeTypeRef(dummyModule, "str", ArgTag.STRING, 0),
  ]
);

describe("fuzzer/analysis/typescript/ArgDefValidator:", () => {
  it("Validates valid tuple", () => {
    expect(ArgDefValidator.validate([[1], "test"], tupleDef)).toBe(true);
  });

  it("Fails when tuple field doesn't match spec", () => {
    expect(ArgDefValidator.validate([1, "test"], tupleDef)).toBe(false);
  });

  it("Fails when tuple size doesn't match spec", () => {
    expect(ArgDefValidator.validate([[1]], tupleDef)).toBe(false);
  });

  it("Validates valid tuple array", () => {
    expect(
      ArgDefValidator.validate(
        [[[1], "test"]],
        makeArgDef(dummyModule, "test", 0, ArgTag.TUPLE, argOptions, 1, false, [
          makeTypeRef(dummyModule, "number", ArgTag.NUMBER, 1),
          makeTypeRef(dummyModule, "str", ArgTag.STRING, 0),
        ])
      )
    ).toBe(true);
  });

  it("Validates valid arbitrary dimensional array", () => {
    let arr: any = 1;
    for (let dim = 1; dim < 5; dim++) {
      arr = [arr];
      const arrayDef = makeArgDef(
        dummyModule,
        "test",
        0,
        ArgTag.NUMBER,
        argOptions,
        dim
      );
      expect(ArgDefValidator.validate(arr, arrayDef)).toBe(true);
    }
  });

  it("Validates outer dimension uniqueness when dimsUnique===true", () => {
    const uniqueArrayDef = makeArgDef(
      dummyModule,
      "test",
      0,
      ArgTag.NUMBER,
      { ...argOptions, dimsUnique: true },
      1
    );

    expect(ArgDefValidator.validate([1, 2], uniqueArrayDef)).toBe(true);
    expect(ArgDefValidator.validate([1, 1], uniqueArrayDef)).toBe(false);
  });

  it("Does not validate inner dimension uniqueness when dimsUnique===true", () => {
    const uniqueMatrixDef = makeArgDef(
      dummyModule,
      "test",
      0,
      ArgTag.NUMBER,
      { ...argOptions, dimsUnique: true },
      2
    );

    expect(
      ArgDefValidator.validate(
        [
          [1, 1],
          [2, 2],
        ],
        uniqueMatrixDef
      )
    ).toBe(true);
    expect(ArgDefValidator.validate([[1], [1]], uniqueMatrixDef)).toBe(false);
  });

  it("rejects duplicate object array elements when dimsUnique is enabled", () => {
    const uniqueObjects = makeArgDef(
      dummyModule,
      "objects",
      0,
      ArgTag.OBJECT,
      {
        ...argOptions,
        dimsUnique: true,
        dimLength: [{ min: 2, max: 2 }],
      },
      1,
      false,
      [makeTypeRef(dummyModule, "a", ArgTag.LITERAL, 0, true, [], undefined, 1)]
    );

    expect(ArgDefValidator.validate([{ a: 1 }, { a: 1 }], uniqueObjects)).toBe(
      false
    );
  });

  it("rejects present but undefined optional object members", () => {
    const uniqueObjects = makeArgDef(
      dummyModule,
      "objects",
      0,
      ArgTag.OBJECT,
      {
        ...argOptions,
        dimsUnique: true,
        dimLength: [{ min: 2, max: 2 }],
      },
      1,
      false,
      [makeTypeRef(dummyModule, "a", ArgTag.LITERAL, 0, true, [], undefined, 1)]
    );

    expect(
      ArgDefValidator.validate([{ a: undefined }, {}], uniqueObjects)
    ).toBe(false);
  });
});
