import { FunctionDef } from "./FunctionDef";
import { ArgTag, FunctionRef } from "./Types";
import { ArgDef } from "./ArgDef";

const argOptions = ArgDef.getDefaultOptions();
const dummyModule = new URL("file:///dummy.ts");
const dummyRef: FunctionRef = {
  src: "",
  module: dummyModule,
  name: "test",
  startOffset: 0,
  endOffset: 999,
};

/**
 * Test that the TypeScript analyzer retrieves function parameters correctly in
 * the circumstances we expect to encounter.
 *
 * TODO: Add 'skip' tests for the situations we do not support yet.
 */
describe("fuzzer/analysis/typescript/FunctionDef", () => {
  test("arrowFunction", () => {
    expect(
      new FunctionDef(
        {
          ...dummyRef,
          src: `const $_f = (name: string, offset: number, happy: boolean, nums: number[][], obj: {num: number, numA: number[], str:string, strA: string[], bool: boolean, boolA: boolean[]}):void => {
        const whatever:string = name + offset + happy + JSON.stringify(nums);}`,
        },
        argOptions
      ).getArgDefs()
    ).toStrictEqual([
      new ArgDef("name", 0, ArgTag.STRING, argOptions, 0),
      new ArgDef("offset", 1, ArgTag.NUMBER, argOptions, 0),
      new ArgDef("happy", 2, ArgTag.BOOLEAN, argOptions, 0),
      new ArgDef("nums", 3, ArgTag.NUMBER, argOptions, 2),
      new ArgDef("obj", 4, ArgTag.OBJECT, argOptions, 0, undefined, undefined, [
        new ArgDef("num", 0, ArgTag.NUMBER, argOptions, 0),
        new ArgDef("numA", 1, ArgTag.NUMBER, argOptions, 1),
        new ArgDef("str", 2, ArgTag.STRING, argOptions, 0),
        new ArgDef("strA", 3, ArgTag.STRING, argOptions, 1),
        new ArgDef("bool", 4, ArgTag.BOOLEAN, argOptions, 0),
        new ArgDef("boolA", 5, ArgTag.BOOLEAN, argOptions, 1),
      ]),
    ]);
  });

  test("standardFunction", () => {
    expect(
      new FunctionDef(
        {
          ...dummyRef,
          src: `function $_f(name: string, offset: number, happy: boolean, nums: number[][], obj: {num: number, numA: number[], str:string, strA: string[], bool: boolean, boolA: boolean[]}):void {
            const whatever:string = name + offset + happy + JSON.stringify(nums);}`,
        },
        argOptions
      ).getArgDefs()
    ).toStrictEqual([
      new ArgDef("name", 0, ArgTag.STRING, argOptions, 0),
      new ArgDef("offset", 1, ArgTag.NUMBER, argOptions, 0),
      new ArgDef("happy", 2, ArgTag.BOOLEAN, argOptions, 0),
      new ArgDef("nums", 3, ArgTag.NUMBER, argOptions, 2),
      new ArgDef("obj", 4, ArgTag.OBJECT, argOptions, 0, undefined, undefined, [
        new ArgDef("num", 0, ArgTag.NUMBER, argOptions, 0),
        new ArgDef("numA", 1, ArgTag.NUMBER, argOptions, 1),
        new ArgDef("str", 2, ArgTag.STRING, argOptions, 0),
        new ArgDef("strA", 3, ArgTag.STRING, argOptions, 1),
        new ArgDef("bool", 4, ArgTag.BOOLEAN, argOptions, 0),
        new ArgDef("boolA", 5, ArgTag.BOOLEAN, argOptions, 1),
      ]),
    ]);
  });

  test("optionalParameter", () => {
    expect(
      new FunctionDef(
        {
          ...dummyRef,
          src: `function totalDinnerExpenses( total?: number ): number {
            items.forEach((item) => (total += item.dinner));
            return total;}`,
        },
        argOptions
      ).getArgDefs()
    ).toStrictEqual([
      new ArgDef("total", 0, ArgTag.NUMBER, argOptions, 0, true),
    ]);
  });

  const src = `export function test(array: string[]): string {return "";}
  const result = Math.sqrt(2);
  export function test2() {const test = (array:string[]):string => {return "";}};
  const test3 = 0;`;

  test("findFnInSource: All", () => {
    expect(
      FunctionDef.find(src, { module: dummyModule }).map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "test",
        module: dummyModule,
        src: 'function test(array: string[]): string {return "";}',
        startOffset: 7,
        endOffset: 58,
      },
      {
        name: "test2",
        module: dummyModule,
        src: 'function test2() {const test = (array:string[]):string => {return "";}}',
        startOffset: 99,
        endOffset: 170,
      },
      {
        name: "test",
        module: dummyModule,
        src: 'const test = (array:string[]):string => {return "";}',
        startOffset: 123,
        endOffset: 169,
      },
    ]);
  });

  test("findFnInSource: By Name", () => {
    expect(
      FunctionDef.find(src, {
        module: dummyModule,
        name: "test",
      }).map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "test",
        module: dummyModule,
        src: 'function test(array: string[]): string {return "";}',
        startOffset: 7,
        endOffset: 58,
      },
      {
        name: "test",
        module: dummyModule,
        src: 'const test = (array:string[]):string => {return "";}',
        startOffset: 123,
        endOffset: 169,
      },
    ]);
  });

  test("findFnInSource: By Offset", () => {
    expect(
      FunctionDef.find(src, {
        module: dummyModule,
        startOffset: 130,
      }).map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "test",
        module: dummyModule,
        src: 'const test = (array:string[]):string => {return "";}',
        startOffset: 123,
        endOffset: 169,
      },
    ]);
  });

  test("findFnInSource: By Name and Offset", () => {
    expect(
      FunctionDef.find(src, {
        module: dummyModule,
        name: "test",
        startOffset: 130,
      }).map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "test",
        module: dummyModule,
        src: 'const test = (array:string[]):string => {return "";}',
        startOffset: 123,
        endOffset: 169,
      },
    ]);
  });
});
