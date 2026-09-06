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

  it("rest parameters: (...args: Parameters<typeof fn>", () => {
    const prog = ProgramFactory.fromSource(
      () => `function levenshtein(a: string, b: string): number { return 0; }
      export function levenshteinTransformer(...args: Parameters<typeof levenshtein>): Parameters<typeof levenshtein> | null {
        return args;
      }`,
      "typescript"
    );
    const transformer = prog.functionsExported["levenshteinTransformer"];
    expect(transformer).toBeDefined();
    expect(
      transformer
        .getArgDefs()
        .map((arg) => [arg.getName(), TypescriptProgram.getTypeAnnotation(arg)])
    ).toEqual([
      ["a", "string"],
      ["b", "string"],
    ]);
  });

  it("rest parameters: explicit tuple types", () => {
    const prog = ProgramFactory.fromSource(
      () => `export function myTransformer(...args: [str: string, num: number]): [string, number] {
        return args;
      }`,
      "typescript"
    );
    const transformer = prog.functionsExported["myTransformer"];
    expect(transformer).toBeDefined();
    expect(
      transformer
        .getArgDefs()
        .map((arg) => [arg.getName(), TypescriptProgram.getTypeAnnotation(arg)])
    ).toEqual([
      ["str", "string"],
      ["num", "number"],
    ]);
  });

  it("rest parameters: array types", () => {
    const prog = ProgramFactory.fromSource(
      () => `export function arrayTransformer(...items: number[]): number[] {
        return items;
      }`,
      "typescript"
    );
    const transformer = prog.functionsExported["arrayTransformer"];
    expect(transformer).toBeDefined();
    expect(
      transformer
        .getArgDefs()
        .map((arg) => [arg.getName(), TypescriptProgram.getTypeAnnotation(arg)])
    ).toEqual([["items", "number[]"]]);
  });

  it("ReturnType<typeof fn>", () => {
    const prog = ProgramFactory.fromSource(
      () => `function getVal(): number { return 10; }
      export function fn(x: ReturnType<typeof getVal>): void {}`,
      "typescript"
    );
    const fn = prog.functionsExported["fn"];
    expect(fn).toBeDefined();
    expect(
      fn
        .getArgDefs()
        .map((arg) => [arg.getName(), TypescriptProgram.getTypeAnnotation(arg)])
    ).toEqual([["x", "number"]]);
  });

  it("rest parameters: type-aliased tuple types", () => {
    const prog = ProgramFactory.fromSource(
      () => `type MyTuple = [a: string, b: number];
      export function aliasedTransformer(...args: MyTuple): void {}`,
      "typescript"
    );
    const fn = prog.functionsExported["aliasedTransformer"];
    expect(fn).toBeDefined();
    expect(
      fn
        .getArgDefs()
        .map((arg) => [arg.getName(), TypescriptProgram.getTypeAnnotation(arg)])
    ).toEqual([
      ["a", "string"],
      ["b", "number"],
    ]);
  });

  it("rest parameters: union of tuple types (inline and type-aliased)", () => {
    const prog = ProgramFactory.fromSource(
      () => `type MyTupleUnion = [str: string] | [num: number, flag: boolean];
      export function inlineUnion(...args: [string] | [number, boolean]): void {}
      export function aliasedUnion(...args: MyTupleUnion): void {}`,
      "typescript"
    );

    const inlineFn = prog.functionsExported["inlineUnion"];
    expect(inlineFn).toBeDefined();
    expect(
      inlineFn
        .getArgDefs()
        .map((arg) => [
          arg.getName(),
          TypescriptProgram.getTypeAnnotation(arg),
          arg.isOptional(),
        ])
    ).toEqual([
      ["args_0", "string | number", false],
      ["args_1", "boolean | undefined", true],
    ]);

    const aliasedFn = prog.functionsExported["aliasedUnion"];
    expect(aliasedFn).toBeDefined();
    expect(
      aliasedFn
        .getArgDefs()
        .map((arg) => [
          arg.getName(),
          TypescriptProgram.getTypeAnnotation(arg),
          arg.isOptional(),
        ])
    ).toEqual([
      ["str", "string | number", false],
      ["flag", "boolean | undefined", true],
    ]);
  });

  it("null literals and keywords in parameter types (inline)", () => {
    const prog = ProgramFactory.fromSource(
      () =>
        `export function nulls(x: null | number, o: {k: null | number}, u: (null | number)[], t: [null, null]): void {}`,
      "typescript"
    );
    const fn = prog.functionsExported["nulls"];
    expect(fn).toBeDefined();

    expect(
      fn
        .getArgDefs()
        .map((arg) => [arg.getName(), TypescriptProgram.getTypeAnnotation(arg)])
    ).toEqual([
      ["x", "null | number"],
      ["o", "{ k: null | number }"],
      ["u", "(null | number)[]"],
      ["t", "[null, null]"],
    ]);
  });

  it("null literals and keywords in parameter types (type references)", () => {
    const prog = ProgramFactory.fromSource(
      () => `type NullableNumber = null | number;
      type MyObj = { k: NullableNumber };
      type MyArray = NullableNumber[];
      type MyTuple = [null, null];
      export function nullsAliased(x: NullableNumber, o: MyObj, u: MyArray, t: MyTuple): void {}`,
      "typescript"
    );
    const fn = prog.functionsExported["nullsAliased"];
    expect(fn).toBeDefined();

    expect(
      fn
        .getArgDefs()
        .map((arg) => [arg.getName(), TypescriptProgram.getTypeAnnotation(arg)])
    ).toEqual([
      ["x", "NullableNumber"],
      ["o", "MyObj"],
      ["u", "MyArray"],
      ["t", "MyTuple"],
    ]);

    // Also verify base type expansion without using type refs
    expect(
      fn
        .getArgDefs()
        .map((arg) => [
          arg.getName(),
          TypescriptProgram.getTypeAnnotation(arg, {}),
        ])
    ).toEqual([
      ["x", "null | number"],
      ["o", "{ k: null | number }"],
      ["u", "(null | number)[]"],
      ["t", "[null, null]"],
    ]);
  });

  it("Record and index signature dictionary support", () => {
    const prog = ProgramFactory.fromSource(
      () => `
      type ScoreMap = Record<string, number>;
      export function testDicts(
        rec: Record<string, number>,
        idxSig: { [key: string]: boolean },
        aliased: ScoreMap,
        myMap: Map<string, number>
      ): void {}
      `,
      "typescript"
    );

    const fn = prog.functionsExported["testDicts"];
    expect(fn).toBeDefined();

    const args = fn.getArgDefs();
    expect(args.length).toBe(4);

    expect(args[0].getType()).toEqual(ArgTag.DICTIONARY);
    expect(
      args[0].getChildren().map((c) => [c.getName(), c.getType()])
    ).toEqual([
      ["key", ArgTag.STRING],
      ["value", ArgTag.NUMBER],
    ]);

    expect(args[1].getType()).toEqual(ArgTag.DICTIONARY);
    expect(
      args[1].getChildren().map((c) => [c.getName(), c.getType()])
    ).toEqual([
      ["key", ArgTag.STRING],
      ["value", ArgTag.BOOLEAN],
    ]);

    expect(args[2].getType()).toEqual(ArgTag.DICTIONARY);
    expect(
      args[2].getChildren().map((c) => [c.getName(), c.getType()])
    ).toEqual([
      ["key", ArgTag.STRING],
      ["value", ArgTag.NUMBER],
    ]);

    expect(args[3].getType()).toEqual(ArgTag.DICTIONARY);
    expect(args[3].getTypeRef()).toEqual("Map");
    expect(
      args[3].getChildren().map((c) => [c.getName(), c.getType()])
    ).toEqual([
      ["key", ArgTag.STRING],
      ["value", ArgTag.NUMBER],
    ]);

    expect(
      args.map((arg) => TypescriptProgram.getTypeAnnotation(arg, {}))
    ).toEqual([
      "Record<string, number>",
      "Record<string, boolean>",
      "Record<string, number>",
      "Map<string, number>",
    ]);
  });

  it("mixed property & index signatures in object literal not yet supported", () => {
    // Eventually we would like to support this, but we don't right now
    // and need to ensure that we do not silently ingest such types.
    const prog = ProgramFactory.fromSource(
      () => `
      export function testMixed(obj: { id: string; [key: string]: number }): void {}
      `,
      "typescript"
    );
    expect(prog.functionsExported["testMixed"]).toBeUndefined();
  });
});
