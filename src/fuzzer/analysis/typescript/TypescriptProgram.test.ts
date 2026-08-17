import * as ProgramFactory from "../ProgramFactory";
import { ArgTag } from "../Types";
import { TypescriptProgram } from "./TypescriptProgram";

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
      exportedFunctions["test1a"]
        .getArgDefs()
        .map((a) => TypescriptProgram.getTypeAnnotation(a))
    ).toEqual(["(number | string)[]"]);
    expect(
      exportedFunctions["test2a"]
        .getArgDefs()
        .map((a) => TypescriptProgram.getTypeAnnotation(a))
    ).toEqual(["{ b: NumberOrString }"]);
    expect(
      exportedFunctions["test1b"]
        .getArgDefs()
        .map((a) => TypescriptProgram.getTypeAnnotation(a))
    ).toEqual(["NumberOrString[]"]);
    expect(
      exportedFunctions["test2b"]
        .getArgDefs()
        .map((a) => TypescriptProgram.getTypeAnnotation(a))
    ).toEqual(["{ b: number | string }"]);
  });

  it("Issue 387: unsupport types do not affect other types", () => {
    const exportedTypes = ProgramFactory.fromSource(
      () => 'export type a = "a";export type b = bigint;',
      "typescript"
    ).typesExported;
    expect(exportedTypes["a"]).toEqual({
      isExported: true,
      optional: false,
      dims: 0,
      module: "",
      name: "a",
      type: {
        dims: 0,
        type: ArgTag.LITERAL,
        children: [],
        value: "a",
        resolved: true,
      },
    });
    expect(exportedTypes).not.toContain("b");
  });

  it("isVoid===true for functions lacking return", () => {
    const fns = ProgramFactory.fromSource(
      () => `
export function noReturnDecl() {
  const x = 1;
}

export const noReturnArrow = () => {
  const y = 2;
};
`,
      "typescript"
    ).functionsExported;

    expect(fns["noReturnDecl"].isVoid()).toBeTrue();
    expect(fns["noReturnArrow"].isVoid()).toBeTrue();
  });

  it("isVoid===true for functions with only bare returns", () => {
    const fns = ProgramFactory.fromSource(
      () => `
export function bareReturnDecl() {
  return;
}

export const bareReturnArrow = () => {
  return;
};
`,
      "typescript"
    ).functionsExported;

    expect(fns["bareReturnDecl"].isVoid()).toBeTrue();
    expect(fns["bareReturnArrow"].isVoid()).toBeTrue();
  });

  it("isVoid===true for functions only returning undefined", () => {
    const fns = ProgramFactory.fromSource(
      () => `
export function returnUndefinedDecl() {
  return undefined;
}

export const returnUndefinedArrow = () => {
  return undefined;
};
`,
      "typescript"
    ).functionsExported;

    expect(fns["returnUndefinedArrow"].isVoid()).toBeTrue();
    expect(fns["returnUndefinedDecl"].isVoid()).toBeTrue();
  });

  it("isVoid===true for functions where all branches return void or undefined", () => {
    const fns = ProgramFactory.fromSource(
      () => `
export function multiBranchVoid(cond: boolean) {
  if (cond) {
    return;
  } else {
    return undefined;
  }
}
`,
      "typescript"
    ).functionsExported;

    expect(fns["multiBranchVoid"].isVoid()).toBeTrue();
  });

  it("isVoid===false for functions returning non-void values", () => {
    const fns = ProgramFactory.fromSource(
      () => `
export function returnsValue() {
  return 42;
}

export function multiBranchNonVoid(n: number) {
  if (n===1) {
    return;
  } else if(n===2) {
    return undefined;
  } else {
    return 42;
  }
}

export const returnsValueArrow = () => "hello";
`,
      "typescript"
    ).functionsExported;

    expect(fns["returnsValue"].isVoid()).toBeFalse();
    expect(fns["multiBranchNonVoid"].isVoid()).toBeFalse();
    expect(fns["returnsValueArrow"].isVoid()).toBeFalse();
  });

  it("rest parameters (...args) are marked as unsupported", () => {
    const prog = ProgramFactory.fromSource(
      () => `function levenshtein(a: string, b: string): number { return 0; }
      export function levenshteinTransformer(...args: Parameters<typeof levenshtein>): Parameters<typeof levenshtein> | null {
        return args;
      }`,
      "typescript"
    );
    expect(prog.functionsExported["levenshteinTransformer"]).toBeUndefined();
    expect(prog.functions["levenshteinTransformer"]).toBeUndefined();
  });
});
