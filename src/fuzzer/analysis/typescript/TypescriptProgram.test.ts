import * as ProgramFactory from "../ProgramFactory";
import { ArgTag } from "../Types";

describe("fuzzer/analysis/typescript/ProgramDef:", () => {
  it("Explicit default export type reference", () => {
    expect(
      ProgramFactory.fromSource(
        () => `type a = "b";export default a;`,
        "typescript"
      ).defaultExport
    ).toEqual({
      isExported: true,
      optional: false,
      dims: 0,
      module: "",
      name: "default",
      typeRefName: "a",
      type: {
        dims: 0,
        type: ArgTag.LITERAL,
        children: [],
        value: "b",
        resolved: true,
      },
    });
  });

  it("Explicit default export type literal", () => {
    expect(
      ProgramFactory.fromSource(() => `export default "b";`, "typescript")
        .defaultExport
    ).toEqual({
      isExported: true,
      optional: false,
      dims: 0,
      module: "",
      name: "default",
      type: {
        type: ArgTag.LITERAL,
        dims: 0,
        children: [],
        value: "b",
        resolved: true,
      },
    });
  });

  it("Implicit default export type reference", () => {
    expect(
      ProgramFactory.fromSource(
        () => `type a = "b";export {a as default};`,
        "typescript"
      ).defaultExport
    ).toEqual({
      isExported: true,
      optional: false,
      dims: 0,
      module: "",
      name: "default",
      typeRefName: "a",
      type: {
        dims: 0,
        type: ArgTag.LITERAL,
        children: [],
        value: "b",
        resolved: true,
      },
    });
  });

  it("Implicit default export type literal (expect failure)", () => {
    expect(
      () =>
        ProgramFactory.fromSource(
          () => `export {"b" as default};`,
          "typescript"
        ).defaultExport
    ).toThrow();
  });

  it("Issue #349 parenthesized types", () => {
    const exportedFunctions = ProgramFactory.fromSource(
      () => `type NumberOrString = number | string;
      export function test1a(arr: (number | string)[]): void {};
      export function test2a(a: { b: NumberOrString }): void {};
      export function test1b(arr: NumberOrString[]): void {};
      export function test2b(a: { b:  number | string }): void {};`,
      "typescript"
    ).functionsExported;
    expect(
      exportedFunctions["test1a"].getArgDefs().map((a) => a.getTypeAnnotation())
    ).toEqual(["(number | string)[]"]);
    expect(
      exportedFunctions["test2a"].getArgDefs().map((a) => a.getTypeAnnotation())
    ).toEqual(["{ b: NumberOrString }"]);
    expect(
      exportedFunctions["test1b"].getArgDefs().map((a) => a.getTypeAnnotation())
    ).toEqual(["NumberOrString[]"]);
    expect(
      exportedFunctions["test2b"].getArgDefs().map((a) => a.getTypeAnnotation())
    ).toEqual(["{ b: number | string }"]);
  });
});
