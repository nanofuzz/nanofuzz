import {
  getTsFnArgs,
  findFnInSource,
  ArgDef,
  ArgType,
  ArgTag,
} from "./Typescript";

const argOptions = ArgDef.getDefaultOptions();

// !!!
describe("tsAnalysis", () => {
  test("arrowFunction", () => {
    expect(
      getTsFnArgs(
        `const $_f = (name: string, offset: number, happy: boolean, nums: number[][]):void => {
        const whatever:string = name + offset + happy + JSON.stringify(nums);}`,
        argOptions
      )
    ).toStrictEqual([
      new ArgDef("name", 0, ArgTag.STRING, 0, undefined, undefined, argOptions),
      new ArgDef(
        "offset",
        1,
        ArgTag.NUMBER,
        0,
        undefined,
        undefined,
        argOptions
      ),
      new ArgDef(
        "happy",
        2,
        ArgTag.BOOLEAN,
        0,
        undefined,
        undefined,
        argOptions
      ),
      new ArgDef("nums", 3, ArgTag.NUMBER, 2, undefined, undefined, argOptions),
    ]);
  });

  test("standardFunction", () => {
    expect(
      getTsFnArgs(
        `function $_f(name: string, offset: number, happy: boolean, nums: number[][]):void {
        const whatever:string = name + offset + happy + JSON.stringify(nums);}`,
        argOptions
      )
    ).toStrictEqual([
      new ArgDef("name", 0, ArgTag.STRING, 0, undefined, undefined, argOptions),
      new ArgDef(
        "offset",
        1,
        ArgTag.NUMBER,
        0,
        undefined,
        undefined,
        argOptions
      ),
      new ArgDef(
        "happy",
        2,
        ArgTag.BOOLEAN,
        0,
        undefined,
        undefined,
        argOptions
      ),
      new ArgDef("nums", 3, ArgTag.NUMBER, 2, undefined, undefined, argOptions),
    ]);
  });

  test("optionalParameter", () => {
    expect(
      getTsFnArgs(
        `function totalDinnerExpenses( total?: number ): number {
        items.forEach((item) => (total += item.dinner));
        return total;}`,
        argOptions
      )
    ).toStrictEqual([new ArgDef("total", 0, ArgTag.NUMBER, 0, true)]);
  });

  const src = `export function test(array: string[]): string {return "";}
  const result = Math.sqrt(2);
  export function test2() {const test = (array:string[]):string => {return "";}};
  const test3 = 0;`;

  test("findFnIsSource: All", () => {
    expect(findFnInSource(src)).toStrictEqual([
      ["test", 'function test(array: string[]): string {return "";}'],
      [
        "test2",
        'function test2() {const test = (array:string[]):string => {return "";}}',
      ],
      ["test", 'const test = (array:string[]):string => {return "";}'],
    ]);
  });

  test("findFnIsSource: By Name", () => {
    expect(findFnInSource(src, "test")).toStrictEqual([
      ["test", 'function test(array: string[]): string {return "";}'],
      ["test", 'const test = (array:string[]):string => {return "";}'],
    ]);
  });

  test("findFnIsSource: By Offset", () => {
    expect(findFnInSource(src, undefined, 130)).toStrictEqual([
      [
        "test2",
        'function test2() {const test = (array:string[]):string => {return "";}}',
      ],
      ["test", 'const test = (array:string[]):string => {return "";}'],
    ]);
  });

  test("findFnIsSource: By Name and Offset", () => {
    expect(findFnInSource(src, "test", 130)).toStrictEqual([
      ["test", 'const test = (array:string[]):string => {return "";}'],
    ]);
  });

  // !!! Test what we don't support yet
});
