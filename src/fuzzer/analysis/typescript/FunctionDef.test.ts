import { FunctionDef, FunctionRef } from "./FunctionDef";
import { ArgDef, ArgTag } from "./ArgDef";
import { ProgramDef } from "./ProgramDef";

const argOptions = ArgDef.getDefaultOptions();
const dummyModule = "dummy.ts";
const dummyRef: FunctionRef = {
  src: "",
  module: dummyModule,
  name: "test",
  startOffset: 0,
  endOffset: 999,
  export: true,
};
const dummyProgram: ProgramDef = ProgramDef.fromSource(
  "",
  argOptions
).setModule(dummyModule);

/**
 * Test that the TypeScript analyzer retrieves function parameters correctly in
 * the circumstances we expect to encounter.
 *
 * TODO: Add 'skip' tests for the situations we do not support yet.
 */
describe("fuzzer/analysis/typescript/FunctionDef", () => {
  test("arrowFunction", () => {
    const src = `const $_f = (name: string, offset: number, happy: boolean, nums: number[][], obj: {num: number, numA: number[], str:string, strA: string[], bool: boolean, boolA: boolean[]}):void => {
      const whatever:string = name + offset + happy + JSON5.stringify(nums);}`;
    const thisProgram = dummyProgram.setSrc(src);

    expect(
      new FunctionDef(
        thisProgram,
        {
          ...dummyRef,
          src: src,
        },
        argOptions
      ).getArgDefs()
    ).toStrictEqual([
      new ArgDef(thisProgram, "name", 0, ArgTag.STRING, argOptions, 0),
      new ArgDef(thisProgram, "offset", 1, ArgTag.NUMBER, argOptions, 0),
      new ArgDef(thisProgram, "happy", 2, ArgTag.BOOLEAN, argOptions, 0),
      new ArgDef(thisProgram, "nums", 3, ArgTag.NUMBER, argOptions, 2),
      new ArgDef(
        thisProgram,
        "obj",
        4,
        ArgTag.OBJECT,
        argOptions,
        0,
        undefined,
        undefined,
        [
          new ArgDef(thisProgram, "num", 0, ArgTag.NUMBER, argOptions, 0),
          new ArgDef(thisProgram, "numA", 1, ArgTag.NUMBER, argOptions, 1),
          new ArgDef(thisProgram, "str", 2, ArgTag.STRING, argOptions, 0),
          new ArgDef(thisProgram, "strA", 3, ArgTag.STRING, argOptions, 1),
          new ArgDef(thisProgram, "bool", 4, ArgTag.BOOLEAN, argOptions, 0),
          new ArgDef(thisProgram, "boolA", 5, ArgTag.BOOLEAN, argOptions, 1),
        ]
      ),
    ]);
  });

  test("standardFunction", () => {
    const src = `function $_f(name: string, offset: number, happy: boolean, nums: number[][], obj: {num: number, numA: number[], str:string, strA: string[], bool: boolean, boolA: boolean[]}):void {
      const whatever:string = name + offset + happy + JSON5.stringify(nums);}`;
    const thisProgram = dummyProgram.setSrc(src);

    expect(
      new FunctionDef(
        thisProgram,
        {
          ...dummyRef,
          src: src,
        },
        argOptions
      ).getArgDefs()
    ).toStrictEqual([
      new ArgDef(thisProgram, "name", 0, ArgTag.STRING, argOptions, 0),
      new ArgDef(thisProgram, "offset", 1, ArgTag.NUMBER, argOptions, 0),
      new ArgDef(thisProgram, "happy", 2, ArgTag.BOOLEAN, argOptions, 0),
      new ArgDef(thisProgram, "nums", 3, ArgTag.NUMBER, argOptions, 2),
      new ArgDef(
        thisProgram,
        "obj",
        4,
        ArgTag.OBJECT,
        argOptions,
        0,
        undefined,
        undefined,
        [
          new ArgDef(thisProgram, "num", 0, ArgTag.NUMBER, argOptions, 0),
          new ArgDef(thisProgram, "numA", 1, ArgTag.NUMBER, argOptions, 1),
          new ArgDef(thisProgram, "str", 2, ArgTag.STRING, argOptions, 0),
          new ArgDef(thisProgram, "strA", 3, ArgTag.STRING, argOptions, 1),
          new ArgDef(thisProgram, "bool", 4, ArgTag.BOOLEAN, argOptions, 0),
          new ArgDef(thisProgram, "boolA", 5, ArgTag.BOOLEAN, argOptions, 1),
        ]
      ),
    ]);
  });

  test("optionalParameter", () => {
    const src = `function totalDinnerExpenses( total?: number ): number {
      items.forEach((item) => (total += item.dinner));
      return total;}`;
    const thisProgram = dummyProgram.setSrc(src);

    expect(
      new FunctionDef(
        thisProgram,
        {
          ...dummyRef,
          src: src,
        },
        argOptions
      ).getArgDefs()
    ).toStrictEqual([
      new ArgDef(thisProgram, "total", 0, ArgTag.NUMBER, argOptions, 0, true),
    ]);
  });

  const src = `export function test(array: string[]): string {return "";}
  const result = Math.sqrt(2);
  export function test2() {const test = (array:string[]):string => {return "";}};
  const test3 = 0;`;
  const thisProgram = dummyProgram.setSrc(src);

  test("findFnInSource: All", () => {
    expect(FunctionDef.find(thisProgram).map((e) => e.getRef())).toStrictEqual([
      {
        name: "test",
        module: "dummy.ts",
        src: 'function test(array: string[]): string {return "";}',
        startOffset: 7,
        endOffset: 58,
        export: true,
      },
      {
        name: "test2",
        module: "dummy.ts",
        src: 'function test2() {const test = (array:string[]):string => {return "";}}',
        startOffset: 99,
        endOffset: 170,
        export: true,
      },
      {
        name: "test",
        module: "dummy.ts",
        src: 'const test = (array:string[]):string => {return "";}',
        startOffset: 123,
        endOffset: 169,
        export: false,
      },
    ]);
  });

  test("findFnInSource: By Name", () => {
    expect(
      FunctionDef.find(thisProgram, "test").map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "test",
        module: "dummy.ts",
        src: 'function test(array: string[]): string {return "";}',
        startOffset: 7,
        endOffset: 58,
        export: true,
      },
      {
        name: "test",
        module: "dummy.ts",
        src: 'const test = (array:string[]):string => {return "";}',
        startOffset: 123,
        endOffset: 169,
        export: false,
      },
    ]);
  });

  test("findFnInSource: By Offset", () => {
    expect(
      FunctionDef.find(thisProgram, undefined, 130).map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "test",
        module: "dummy.ts",
        src: 'const test = (array:string[]):string => {return "";}',
        startOffset: 123,
        endOffset: 169,
        export: false,
      },
    ]);
  });

  test("findFnInSource: By Name and Offset", () => {
    expect(
      FunctionDef.find(thisProgram, "test", 130).map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "test",
        module: "dummy.ts",
        src: 'const test = (array:string[]):string => {return "";}',
        startOffset: 123,
        endOffset: 169,
        export: false,
      },
    ]);
  });
});
