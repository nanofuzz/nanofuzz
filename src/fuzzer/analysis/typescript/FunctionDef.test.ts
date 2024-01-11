import { FunctionRef, ArgTag, TypeRef, ArgType } from "./Types";
import { ArgDef } from "./ArgDef";
import { ProgramDef } from "./ProgramDef";

const argOptions = ArgDef.getDefaultOptions();
const dummyModule = "dummy.ts";
const dummyRef: FunctionRef = {
  src: "",
  module: dummyModule,
  name: "test",
  startOffset: 0,
  endOffset: 999,
  isExported: true,
  isVoid: false,
};
const dummyProgram: ProgramDef = ProgramDef.fromSource(
  () => "",
  argOptions
).setModule(dummyModule);

/**
 * Helped functions for generating TypeRefs and ArgDefs
 */
function makeArgDef(
  module: string,
  name: string,
  offset: number,
  type: ArgTag,
  argOptions = ArgDef.getDefaultOptions(),
  dims: number,
  optional: boolean = false,
  children: TypeRef[] = []
): ArgDef<ArgType> {
  return ArgDef.fromTypeRef(
    makeTypeRef(
      module,
      name,
      offset,
      type,
      argOptions,
      dims,
      optional,
      children
    ),
    argOptions,
    offset
  );
}
function makeTypeRef(
  module: string,
  name: string,
  offset: number,
  type: ArgTag,
  argOptions = ArgDef.getDefaultOptions(),
  dims: number,
  optional: boolean = false,
  children: TypeRef[] = []
): TypeRef {
  return {
    name: name,
    module: module,
    optional: optional ?? false,
    dims: dims,
    type: {
      type: type,
      children: children,
    },
    isExported: true,
  };
}

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
    const thisProgram = dummyProgram.setSrc(() => src);

    expect(thisProgram.getFunctions()["$_f"].getArgDefs()).toStrictEqual([
      makeArgDef(dummyRef.module, "name", 0, ArgTag.STRING, argOptions, 0),
      makeArgDef(dummyRef.module, "offset", 1, ArgTag.NUMBER, argOptions, 0),
      makeArgDef(dummyRef.module, "happy", 2, ArgTag.BOOLEAN, argOptions, 0),
      makeArgDef(dummyRef.module, "nums", 3, ArgTag.NUMBER, argOptions, 2),
      makeArgDef(
        dummyRef.module,
        "obj",
        4,
        ArgTag.OBJECT,
        argOptions,
        0,
        undefined,
        [
          makeTypeRef(dummyRef.module, "num", 0, ArgTag.NUMBER, argOptions, 0),
          makeTypeRef(dummyRef.module, "numA", 1, ArgTag.NUMBER, argOptions, 1),
          makeTypeRef(dummyRef.module, "str", 2, ArgTag.STRING, argOptions, 0),
          makeTypeRef(dummyRef.module, "strA", 3, ArgTag.STRING, argOptions, 1),
          makeTypeRef(
            dummyRef.module,
            "bool",
            4,
            ArgTag.BOOLEAN,
            argOptions,
            0
          ),
          makeTypeRef(
            dummyRef.module,
            "boolA",
            5,
            ArgTag.BOOLEAN,
            argOptions,
            1
          ),
        ]
      ),
    ]);
  });

  test("standardFunction", () => {
    const src = `function $_f(name: string, offset: number, happy: boolean, nums: number[][], obj: {num: number, numA: number[], str:string, strA: string[], bool: boolean, boolA: boolean[]}):void {
      const whatever:string = name + offset + happy + JSON5.stringify(nums);}`;
    const thisProgram = dummyProgram.setSrc(() => src);

    expect(thisProgram.getFunctions()["$_f"].getArgDefs()).toStrictEqual([
      makeArgDef(dummyRef.module, "name", 0, ArgTag.STRING, argOptions, 0),
      makeArgDef(dummyRef.module, "offset", 1, ArgTag.NUMBER, argOptions, 0),
      makeArgDef(dummyRef.module, "happy", 2, ArgTag.BOOLEAN, argOptions, 0),
      makeArgDef(dummyRef.module, "nums", 3, ArgTag.NUMBER, argOptions, 2),
      makeArgDef(
        dummyRef.module,
        "obj",
        4,
        ArgTag.OBJECT,
        argOptions,
        0,
        undefined,
        [
          makeTypeRef(dummyRef.module, "num", 0, ArgTag.NUMBER, argOptions, 0),
          makeTypeRef(dummyRef.module, "numA", 1, ArgTag.NUMBER, argOptions, 1),
          makeTypeRef(dummyRef.module, "str", 2, ArgTag.STRING, argOptions, 0),
          makeTypeRef(dummyRef.module, "strA", 3, ArgTag.STRING, argOptions, 1),
          makeTypeRef(
            dummyRef.module,
            "bool",
            4,
            ArgTag.BOOLEAN,
            argOptions,
            0
          ),
          makeTypeRef(
            dummyRef.module,
            "boolA",
            5,
            ArgTag.BOOLEAN,
            argOptions,
            1
          ),
        ]
      ),
    ]);
  });

  test("optionalParameter", () => {
    const src = `function totalDinnerExpenses( total?: number ): number {
      items.forEach((item) => (total += item.dinner));
      return total;}`;
    const thisProgram = dummyProgram.setSrc(() => src);

    expect(
      thisProgram.getFunctions()["totalDinnerExpenses"].getArgDefs()
    ).toStrictEqual([
      makeArgDef(
        dummyRef.module,
        "total",
        0,
        ArgTag.NUMBER,
        argOptions,
        0,
        true
      ),
    ]);
  });

  const src = `export function test(array: string[]): string {return "";}
  const result = Math.sqrt(2);
  export function test2() {const test = (array:string[]):string => {return "";}};
  const test3 = 0;`;
  const thisProgram = dummyProgram.setSrc(() => src);

  test("findFnInSource: All", () => {
    expect(
      Object.values(thisProgram.getFunctions()).map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "test",
        module: "dummy.ts",
        src: 'function test(array: string[]): string {return "";}',
        startOffset: 7,
        endOffset: 58,
        isExported: true,
        isVoid: false,
        args: [
          {
            dims: 1,
            isExported: false,
            module: thisProgram.getModule(),
            name: "array",
            optional: false,
            type: {
              children: [],
              resolved: true,
              type: ArgTag.STRING,
            },
          },
        ],
      },
      {
        name: "test2",
        module: "dummy.ts",
        src: 'function test2() {const test = (array:string[]):string => {return "";}}',
        startOffset: 99,
        endOffset: 170,
        isExported: true,
        isVoid: true,
        args: [],
      },
      /*
      {
        name: "test",
        module: "dummy.ts",
        src: 'const test = (array:string[]):string => {return "";}',
        startOffset: 123,
        endOffset: 169,
        isExported: false,
        args: [
          {
            dims: 1,
            isExported: false,
            module: thisProgram.getModule(),
            name: "array",
            optional: false,
            type: {
              children: [],
              resolved: true,
              type: ArgTag.STRING,
            },
          },
        ],
      },
      */
    ]);
  });

  test("findFnInSource: By Name, non-exported", () => {
    expect(thisProgram.getFunctions()["test"].getRef()).toStrictEqual({
      name: "test",
      module: "dummy.ts",
      src: 'function test(array: string[]): string {return "";}',
      startOffset: 7,
      endOffset: 58,
      isExported: true,
      isVoid: false,
      args: [
        {
          dims: 1,
          isExported: false,
          module: thisProgram.getModule(),
          name: "array",
          optional: false,
          type: {
            children: [],
            resolved: true,
            type: ArgTag.STRING,
          },
        },
      ],
    });
  });

  test("findFnInSource: By Name, Exported", () => {
    expect(thisProgram.getExportedFunctions()["test"].getRef()).toStrictEqual({
      name: "test",
      module: "dummy.ts",
      src: 'function test(array: string[]): string {return "";}',
      startOffset: 7,
      endOffset: 58,
      isExported: true,
      isVoid: false,
      args: [
        {
          dims: 1,
          isExported: false,
          module: thisProgram.getModule(),
          name: "array",
          optional: false,
          type: {
            children: [],
            resolved: true,
            type: ArgTag.STRING,
          },
        },
      ],
    });
  });

  test("findFnInSource: void, standard fn def", () => {
    const src = `
    export function returnF1() {return;}
    export function returnF2() {return 1;}
    export function returnF3() {return () => {return 1;}}
    export function noReturnF1() {const x = 2;}
    export function noReturnF2() {const z2 = [1,2,3].map((z) => {return z*z;});}
    export function noReturnF3() {const x = () => {return 1;}}
    `;
    const thisProgram = dummyProgram.setSrc(() => src);
    expect(
      Object.values(thisProgram.getFunctions()).map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "returnF1",
        module: "dummy.ts",
        src: "function returnF1() {return;}",
        startOffset: 12,
        endOffset: 41,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnF2",
        module: "dummy.ts",
        src: "function returnF2() {return 1;}",
        startOffset: 53,
        endOffset: 84,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnF3",
        module: "dummy.ts",
        src: "function returnF3() {return () => {return 1;}}",
        startOffset: 96,
        endOffset: 142,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "noReturnF1",
        module: "dummy.ts",
        src: "function noReturnF1() {const x = 2;}",
        startOffset: 154,
        endOffset: 190,
        isExported: true,
        isVoid: true,
        args: [],
      },
      {
        name: "noReturnF2",
        module: "dummy.ts",
        src: "function noReturnF2() {const z2 = [1,2,3].map((z) => {return z*z;});}",
        startOffset: 202,
        endOffset: 271,
        isExported: true,
        isVoid: true,
        args: [],
      },
      {
        name: "noReturnF3",
        module: "dummy.ts",
        src: "function noReturnF3() {const x = () => {return 1;}}",
        startOffset: 283,
        endOffset: 334,
        isExported: true,
        isVoid: true,
        args: [],
      },
    ]);
  });

  test("findFnInSource: void, arrow fn", () => {
    const src = `
    export const returnA1 = () => {return;}
    export const returnA2 = () => {return 1;}
    export const returnA3 = () => {return () => {return 1;}}
    export const noReturnA1 = () => {const x = 2;}
    export const noReturnA2 = () => {const z2 = [1,2,3].map((z) => {return z*z;});}
    export const noReturnA3 = () => {const x = () => {return 1;}}
    `;
    const thisProgram = dummyProgram.setSrc(() => src);
    expect(
      Object.values(thisProgram.getFunctions()).map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "returnA1",
        module: "dummy.ts",
        src: "const returnA1 = () => {return;}",
        startOffset: 18,
        endOffset: 44,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnA2",
        module: "dummy.ts",
        src: "const returnA2 = () => {return 1;}",
        startOffset: 62,
        endOffset: 90,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnA3",
        module: "dummy.ts",
        src: "const returnA3 = () => {return () => {return 1;}}",
        startOffset: 108,
        endOffset: 151,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "noReturnA1",
        module: "dummy.ts",
        src: "const noReturnA1 = () => {const x = 2;}",
        startOffset: 169,
        endOffset: 202,
        isExported: true,
        isVoid: true,
        args: [],
      },
      {
        name: "noReturnA2",
        module: "dummy.ts",
        src: "const noReturnA2 = () => {const z2 = [1,2,3].map((z) => {return z*z;});}",
        startOffset: 220,
        endOffset: 286,
        isExported: true,
        isVoid: true,
        args: [],
      },
      {
        name: "noReturnA3",
        module: "dummy.ts",
        src: "const noReturnA3 = () => {const x = () => {return 1;}}",
        startOffset: 304,
        endOffset: 352,
        isExported: true,
        isVoid: true,
        args: [],
      },
    ]);
  });

  test("findFnInSource: void, loops", () => {
    const src = `
    export const returnWhile = () => {let x: number = 0; while (x < 10) {return Infinity;}}
    export const returnForIn = () => {const arr: number[] = [1,2,3]; for (var idx in arr) {if (arr[idx] === 2) {return undefined;}} return 0;}
    export const returnFor = () => {const z = undefined; for (let x =0; x<10; ++x) {if (x === 9) {return z;}} return 0;}
    export const returnForOf = () => {const arr: number[] = [1,2,3]; for (const x of arr) {return NaN;}}
    export const returnDoWhile = () => {const x = undefined; do {const y = 1; return x;} while (1 == 1)}
    `;
    const thisProgram = dummyProgram.setSrc(() => src);
    expect(
      Object.values(thisProgram.getFunctions()).map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "returnWhile",
        module: "dummy.ts",
        src: "const returnWhile = () => {let x: number = 0; while (x < 10) {return Infinity;}}",
        startOffset: 18,
        endOffset: 92,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnForIn",
        module: "dummy.ts",
        src: "const returnForIn = () => {const arr: number[] = [1,2,3]; for (var idx in arr) {if (arr[idx] === 2) {return undefined;}} return 0;}",
        startOffset: 110,
        endOffset: 235,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnFor",
        module: "dummy.ts",
        src: "const returnFor = () => {const z = undefined; for (let x =0; x<10; ++x) {if (x === 9) {return z;}} return 0;}",
        startOffset: 253,
        endOffset: 356,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnForOf",
        module: "dummy.ts",
        src: "const returnForOf = () => {const arr: number[] = [1,2,3]; for (const x of arr) {return NaN;}}",
        startOffset: 374,
        endOffset: 461,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnDoWhile",
        module: "dummy.ts",
        src: "const returnDoWhile = () => {const x = undefined; do {const y = 1; return x;} while (1 == 1)}",
        startOffset: 479,
        endOffset: 566,
        isExported: true,
        isVoid: false,
        args: [],
      },
    ]);
  });

  test("findFnInSource: void, other cases", () => {
    const src = `
    export const returnIf = () => {const x = undefined; if (x) {return x} else {return Infinity;}}
    export const returnSwitch = () => {switch(1) {case 1: {return undefined;} default: {return undefined;}}}
    export const returnTry = () => {try {return Infinity;} catch {return NaN;}}
    export const returnThrow = () => {const x = undefined; if (!x) {throw Error();} else {throw Error();}}
    export const returnLabeled = () => {const arr: number[] = []; loop1: for (let x=0; x<5; ++x) {if (x === 1) {continue loop1;} arr.push(x); if (x === 4) {return undefined;}} return 0;}
    `;
    const thisProgram = dummyProgram.setSrc(() => src);
    expect(
      Object.values(thisProgram.getFunctions()).map((e) => e.getRef())
    ).toStrictEqual([
      {
        name: "returnIf",
        module: "dummy.ts",
        src: "const returnIf = () => {const x = undefined; if (x) {return x} else {return Infinity;}}",
        startOffset: 18,
        endOffset: 99,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnSwitch",
        module: "dummy.ts",
        src: "const returnSwitch = () => {switch(1) {case 1: {return undefined;} default: {return undefined;}}}",
        startOffset: 117,
        endOffset: 208,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnTry",
        module: "dummy.ts",
        src: "const returnTry = () => {try {return Infinity;} catch {return NaN;}}",
        startOffset: 226,
        endOffset: 288,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnThrow",
        module: "dummy.ts",
        src: "const returnThrow = () => {const x = undefined; if (!x) {throw Error();} else {throw Error();}}",
        startOffset: 306,
        endOffset: 395,
        isExported: true,
        isVoid: false,
        args: [],
      },
      {
        name: "returnLabeled",
        module: "dummy.ts",
        src: "const returnLabeled = () => {const arr: number[] = []; loop1: for (let x=0; x<5; ++x) {if (x === 1) {continue loop1;} arr.push(x); if (x === 4) {return undefined;}} return 0;}",
        startOffset: 413,
        endOffset: 582,
        isExported: true,
        isVoid: false,
        args: [],
      },
    ]);
  });
});
