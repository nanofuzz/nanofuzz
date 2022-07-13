import { getTsFnArgs, findFnInSource, ArgDef, ArgType } from "./Typescript";

// !!!
describe("tsAnalysis", () => {
  test("arrowFunction", () => {
    expect(
      getTsFnArgs(`const $_f = (name: string, offset: number, happy: boolean, nums: number[][]):void => {
      const whatever:string = name + offset + happy + JSON.stringify(nums);}`)
    ).toStrictEqual([
      new ArgDef("name", 0, ArgType.STRING, 0),
      new ArgDef("offset", 1, ArgType.NUMBER, 0),
      new ArgDef("happy", 2, ArgType.BOOLEAN, 0),
      new ArgDef("nums", 3, ArgType.NUMBER, 2),
    ]);
  });

  test("standardFunction", () => {
    expect(
      getTsFnArgs(`function $_f(name: string, offset: number, happy: boolean, nums: number[][]):void {
      const whatever:string = name + offset + happy + JSON.stringify(nums);}`)
    ).toStrictEqual([
      new ArgDef("name", 0, ArgType.STRING, 0),
      new ArgDef("offset", 1, ArgType.NUMBER, 0),
      new ArgDef("happy", 2, ArgType.BOOLEAN, 0),
      new ArgDef("nums", 3, ArgType.NUMBER, 2),
    ]);
  });

  test("optionalParameter", () => {
    expect(
      getTsFnArgs(`function totalDinnerExpenses( total?: number ): number {
        items.forEach((item) => (total += item.dinner));
        return total;}`)
    ).toStrictEqual([new ArgDef("total", 0, ArgType.NUMBER, 0, true)]);
  });

  const src = `export function test(array: string[]): string {return "";}
  const result = Math.sqrt(2);
  export function test2() {const test = (array:string[]):string => {return "";}};
  const test3 = 0;`;

  test("findFnIsSource: All", () => {
    expect(findFnInSource(src)).toStrictEqual([
      'function test(array: string[]): string {return "";}',
      'function test2() {const test = (array:string[]):string => {return "";}}',
      'const test = (array:string[]):string => {return "";}',
    ]);
  });

  test("findFnIsSource: By Name", () => {
    expect(findFnInSource(src, "test")).toStrictEqual([
      'function test(array: string[]): string {return "";}',
      'const test = (array:string[]):string => {return "";}',
    ]);
  });

  test("findFnIsSource: By Offset", () => {
    expect(findFnInSource(src, undefined, 130)).toStrictEqual([
      'function test2() {const test = (array:string[]):string => {return "";}}',
      'const test = (array:string[]):string => {return "";}',
    ]);
  });

  test("findFnIsSource: By Name and Offset", () => {
    expect(findFnInSource(src, "test", 130)).toStrictEqual([
      'const test = (array:string[]):string => {return "";}',
    ]);
  });

  // !!! Test what we don't support yet
});
