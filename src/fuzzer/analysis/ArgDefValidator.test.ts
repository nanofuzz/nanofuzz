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
});
