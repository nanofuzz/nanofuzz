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
  children: TypeRef[] = [],
  typeRefName?: string,
  literalValue?: ArgType
): ArgDef<ArgType> {
  return ArgDef.fromTypeRef(
    makeTypeRef(
      module,
      name,
      type,
      dims,
      optional,
      children,
      typeRefName,
      literalValue
    ),
    argOptions,
    offset
  );
}
function makeTypeRef(
  module: string,
  name: string,
  type: ArgTag,
  dims: number,
  optional: boolean = false,
  children: TypeRef[] = [],
  typeRefName?: string,
  literalValue?: ArgType
): TypeRef {
  return {
    name: name,
    module: module,
    typeRefName,
    optional: optional ?? false,
    dims: 0,
    type: {
      dims: dims,
      type: type,
      children: children,
      value: literalValue,
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
describe("fuzzer/analysis/typescript/FunctionDef:", () => {
  it("arrowFunction", () => {
    const src = `const $_f = (name: string, offset: number, happy: boolean, nums: number[][], lit: 5, obj: {num: number, numA: number[], str:string, strA: string[], bool: boolean, boolA: boolean[], lit:6, litA:6[]}):void => {
      const whatever:string = name + offset + happy + JSON5.stringify(nums);}`;
    const thisProgram = dummyProgram.setSrc(() => src);

    expect(thisProgram.getFunctions()["$_f"].getArgDefs()).toEqual([
      makeArgDef(dummyRef.module, "name", 0, ArgTag.STRING, argOptions, 0),
      makeArgDef(dummyRef.module, "offset", 1, ArgTag.NUMBER, argOptions, 0),
      makeArgDef(dummyRef.module, "happy", 2, ArgTag.BOOLEAN, argOptions, 0),
      makeArgDef(dummyRef.module, "nums", 3, ArgTag.NUMBER, argOptions, 2),
      makeArgDef(
        dummyRef.module,
        "lit",
        4,
        ArgTag.LITERAL,
        argOptions,
        0,
        undefined,
        undefined,
        undefined,
        5
      ),
      makeArgDef(
        dummyRef.module,
        "obj",
        5,
        ArgTag.OBJECT,
        argOptions,
        0,
        undefined,
        [
          makeTypeRef(dummyRef.module, "num", ArgTag.NUMBER, 0),
          makeTypeRef(dummyRef.module, "numA", ArgTag.NUMBER, 1),
          makeTypeRef(dummyRef.module, "str", ArgTag.STRING, 0),
          makeTypeRef(dummyRef.module, "strA", ArgTag.STRING, 1),
          makeTypeRef(dummyRef.module, "bool", ArgTag.BOOLEAN, 0),
          makeTypeRef(dummyRef.module, "boolA", ArgTag.BOOLEAN, 1),
          makeTypeRef(
            dummyRef.module,
            "lit",
            ArgTag.LITERAL,
            0,
            undefined,
            undefined,
            undefined,
            6
          ),
          makeTypeRef(
            dummyRef.module,
            "litA",
            ArgTag.LITERAL,
            1,
            undefined,
            undefined,
            undefined,
            6
          ),
        ]
      ),
    ]);
  });

  it("standardFunction", () => {
    const src = `function $_f(name: string, offset: number, happy: boolean, nums: number[][], lit: 5, obj: {num: number, numA: number[], str:string, strA: string[], bool: boolean, boolA: boolean[], lit: 6, litA: 6[]}):void {
      const whatever:string = name + offset + happy + JSON5.stringify(nums);}`;
    const thisProgram = dummyProgram.setSrc(() => src);

    expect(thisProgram.getFunctions()["$_f"].getArgDefs()).toEqual([
      makeArgDef(dummyRef.module, "name", 0, ArgTag.STRING, argOptions, 0),
      makeArgDef(dummyRef.module, "offset", 1, ArgTag.NUMBER, argOptions, 0),
      makeArgDef(dummyRef.module, "happy", 2, ArgTag.BOOLEAN, argOptions, 0),
      makeArgDef(dummyRef.module, "nums", 3, ArgTag.NUMBER, argOptions, 2),
      makeArgDef(
        dummyRef.module,
        "lit",
        4,
        ArgTag.LITERAL,
        argOptions,
        0,
        undefined,
        undefined,
        undefined,
        5
      ),
      makeArgDef(
        dummyRef.module,
        "obj",
        5,
        ArgTag.OBJECT,
        argOptions,
        0,
        undefined,
        [
          makeTypeRef(dummyRef.module, "num", ArgTag.NUMBER, 0),
          makeTypeRef(dummyRef.module, "numA", ArgTag.NUMBER, 1),
          makeTypeRef(dummyRef.module, "str", ArgTag.STRING, 0),
          makeTypeRef(dummyRef.module, "strA", ArgTag.STRING, 1),
          makeTypeRef(dummyRef.module, "bool", ArgTag.BOOLEAN, 0),
          makeTypeRef(dummyRef.module, "boolA", ArgTag.BOOLEAN, 1),
          makeTypeRef(
            dummyRef.module,
            "lit",
            ArgTag.LITERAL,
            0,
            undefined,
            undefined,
            undefined,
            6
          ),
          makeTypeRef(
            dummyRef.module,
            "litA",
            ArgTag.LITERAL,
            1,
            undefined,
            undefined,
            undefined,
            6
          ),
        ]
      ),
    ]);
  });

  it("optionalParameter", () => {
    const src = `function totalDinnerExpenses( total?: number ): number {
      items.forEach((item) => (total += item.dinner));
      return total;}`;
    const thisProgram = dummyProgram.setSrc(() => src);

    expect(
      thisProgram.getFunctions()["totalDinnerExpenses"].getArgDefs()
    ).toEqual([
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

  it("findFnInSource: All", () => {
    expect(
      Object.values(thisProgram.getFunctions()).map((e) => e.getRef())
    ).toEqual([
      {
        name: "test",
        module: "dummy.ts",
        src: 'function test(array: string[]): string {return "";}',
        cmt: undefined,
        startOffset: 7,
        endOffset: 58,
        isExported: true,
        isVoid: false,
        args: [
          {
            dims: 0,
            isExported: false,
            module: thisProgram.getModule(),
            name: "array",
            optional: false,
            type: {
              dims: 1,
              children: [],
              resolved: true,
              type: ArgTag.STRING,
            },
          },
        ],
        returnType: {
          dims: 0,
          isExported: false,
          module: "dummy.ts",
          optional: false,
          type: {
            dims: 0,
            children: [],
            resolved: true,
            type: ArgTag.STRING,
          },
        },
      },
      {
        name: "test2",
        module: "dummy.ts",
        src: 'function test2() {const test = (array:string[]):string => {return "";}}',
        cmt: undefined,
        startOffset: 99,
        endOffset: 170,
        isExported: true,
        isVoid: false,
        args: [],
        returnType: undefined,
      },
      /*
      {
        name: "test",
        module: "dummy.ts",
        src: 'const test = (array:string[]):string => {return "";}',
        cmt: undefined,
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

  it("findFnInSource: By Name, non-exported", () => {
    expect(thisProgram.getFunctions()["test"].getRef()).toEqual({
      name: "test",
      module: "dummy.ts",
      src: 'function test(array: string[]): string {return "";}',
      cmt: undefined,
      startOffset: 7,
      endOffset: 58,
      isExported: true,
      isVoid: false,
      args: [
        {
          dims: 0,
          isExported: false,
          module: thisProgram.getModule(),
          name: "array",
          optional: false,
          type: {
            dims: 1,
            children: [],
            resolved: true,
            type: ArgTag.STRING,
          },
        },
      ],
      returnType: {
        dims: 0,
        isExported: false,
        module: "dummy.ts",
        optional: false,
        type: {
          dims: 0,
          children: [],
          resolved: true,
          type: ArgTag.STRING,
        },
      },
    });
  });

  it("findFnInSource: By Name, Exported", () => {
    expect(thisProgram.getExportedFunctions()["test"].getRef()).toEqual({
      name: "test",
      module: "dummy.ts",
      src: 'function test(array: string[]): string {return "";}',
      cmt: undefined,
      startOffset: 7,
      endOffset: 58,
      isExported: true,
      isVoid: false,
      args: [
        {
          dims: 0,
          isExported: false,
          module: thisProgram.getModule(),
          name: "array",
          optional: false,
          type: {
            dims: 1,
            children: [],
            resolved: true,
            type: ArgTag.STRING,
          },
        },
      ],
      returnType: {
        dims: 0,
        isExported: false,
        module: "dummy.ts",
        optional: false,
        type: {
          dims: 0,
          children: [],
          resolved: true,
          type: ArgTag.STRING,
        },
      },
    });
  });

  it("findFnInSource: void, standard fn def", () => {
    const src = `
    export function returnF1() {return;}
    export function returnF2():number {return 1;}
    export function returnF3() {return () => {return 1;}}
    export function noReturnF1():void {const x = 2;}
    export function noReturnF2():void {const z2 = [1,2,3].map((z) => {return z*z;});}
    export function noReturnF3():void {const x = () => {return 1;}}
    `;
    const thisProgram = dummyProgram.setSrc(() => src);
    expect(
      Object.values(thisProgram.getFunctions()).map((e) => e.getRef())
    ).toEqual([
      {
        name: "returnF1",
        module: "dummy.ts",
        src: "function returnF1() {return;}",
        cmt: undefined,
        startOffset: 12,
        endOffset: 41,
        isExported: true,
        isVoid: false,
        args: [],
        returnType: undefined,
      },
      {
        name: "returnF2",
        module: "dummy.ts",
        src: "function returnF2():number {return 1;}",
        cmt: undefined,
        startOffset: 53,
        endOffset: 91,
        isExported: true,
        isVoid: false,
        args: [],
        returnType: {
          dims: 0,
          isExported: false,
          module: "dummy.ts",
          optional: false,
          type: {
            dims: 0,
            children: [],
            resolved: true,
            type: ArgTag.NUMBER,
          },
        },
      },
      {
        name: "returnF3",
        module: "dummy.ts",
        src: "function returnF3() {return () => {return 1;}}",
        cmt: undefined,
        startOffset: 103,
        endOffset: 149,
        isExported: true,
        isVoid: false,
        args: [],
        returnType: undefined,
      },
      {
        name: "noReturnF1",
        module: "dummy.ts",
        src: "function noReturnF1():void {const x = 2;}",
        cmt: undefined,
        startOffset: 161,
        endOffset: 202,
        isExported: true,
        isVoid: true,
        args: [],
        returnType: undefined,
      },
      {
        name: "noReturnF2",
        module: "dummy.ts",
        src: "function noReturnF2():void {const z2 = [1,2,3].map((z) => {return z*z;});}",
        cmt: undefined,
        startOffset: 214,
        endOffset: 288,
        isExported: true,
        isVoid: true,
        args: [],
        returnType: undefined,
      },
      {
        name: "noReturnF3",
        module: "dummy.ts",
        src: "function noReturnF3():void {const x = () => {return 1;}}",
        cmt: undefined,
        startOffset: 300,
        endOffset: 356,
        isExported: true,
        isVoid: true,
        args: [],
        returnType: undefined,
      },
    ]);
  });

  it("findFnInSource: void, arrow fn", () => {
    const src = `
    export const returnA1 = () => {return;}
    export const returnA2 = ():number => {return 1;}
    export const returnA3 = () => {return () => {return 1;}}
    export const noReturnA1 = ():void => {const x = 2;}
    export const noReturnA2 = ():void => {const z2 = [1,2,3].map((z) => {return z*z;});}
    export const noReturnA3 = ():void => {const x = () => {return 1;}}
    `;
    const thisProgram = dummyProgram.setSrc(() => src);
    expect(
      Object.values(thisProgram.getFunctions()).map((e) => e.getRef())
    ).toEqual([
      {
        name: "returnA1",
        module: "dummy.ts",
        src: "const returnA1 = () => {return;}",
        startOffset: 18,
        endOffset: 44,
        isExported: true,
        isVoid: false,
        args: [],
        returnType: undefined,
      },
      {
        name: "returnA2",
        module: "dummy.ts",
        src: "const returnA2 = ():number => {return 1;}",
        startOffset: 62,
        endOffset: 97,
        isExported: true,
        isVoid: false,
        args: [],
        returnType: {
          dims: 0,
          isExported: false,
          module: "dummy.ts",
          optional: false,
          type: {
            dims: 0,
            children: [],
            resolved: true,
            type: ArgTag.NUMBER,
          },
        },
      },
      {
        name: "returnA3",
        module: "dummy.ts",
        src: "const returnA3 = () => {return () => {return 1;}}",
        startOffset: 115,
        endOffset: 158,
        isExported: true,
        isVoid: false,
        args: [],
        returnType: undefined,
      },
      {
        name: "noReturnA1",
        module: "dummy.ts",
        src: "const noReturnA1 = ():void => {const x = 2;}",
        startOffset: 176,
        endOffset: 214,
        isExported: true,
        isVoid: true,
        args: [],
        returnType: undefined,
      },
      {
        name: "noReturnA2",
        module: "dummy.ts",
        src: "const noReturnA2 = ():void => {const z2 = [1,2,3].map((z) => {return z*z;});}",
        startOffset: 232,
        endOffset: 303,
        isExported: true,
        isVoid: true,
        args: [],
        returnType: undefined,
      },
      {
        name: "noReturnA3",
        module: "dummy.ts",
        src: "const noReturnA3 = ():void => {const x = () => {return 1;}}",
        startOffset: 321,
        endOffset: 374,
        isExported: true,
        isVoid: true,
        args: [],
        returnType: undefined,
      },
    ]);
  });

  it("findFnInSource: void, loops", () => {
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
    ).toEqual([
      {
        name: "returnWhile",
        module: "dummy.ts",
        src: "const returnWhile = () => {let x: number = 0; while (x < 10) {return Infinity;}}",
        startOffset: 18,
        endOffset: 92,
        isExported: true,
        isVoid: false,
        args: [],
        returnType: undefined,
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
        returnType: undefined,
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
        returnType: undefined,
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
        returnType: undefined,
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
        returnType: undefined,
      },
    ]);
  });

  it("findFnInSource: void, other cases", () => {
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
    ).toEqual([
      {
        name: "returnIf",
        module: "dummy.ts",
        src: "const returnIf = () => {const x = undefined; if (x) {return x} else {return Infinity;}}",
        startOffset: 18,
        endOffset: 99,
        isExported: true,
        isVoid: false,
        args: [],
        returnType: undefined,
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
        returnType: undefined,
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
        returnType: undefined,
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
        returnType: undefined,
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
        returnType: undefined,
      },
    ]);
  });

  it("findFnInSource: literal args", () => {
    const src = `
    export type litn = 3;
    export type lita = "a";
    export type litb = true;
    export function testLit(n:litn,a:lita,b:litb) {return;}
    const world = "earth";
    `;
    const thisProgram = dummyProgram.setSrc(() => src);
    expect(
      Object.values(thisProgram.getFunctions()).map((e) => e.getRef())
    ).toEqual([
      {
        name: "testLit",
        module: "dummy.ts",
        src: "function testLit(n:litn,a:lita,b:litb) {return;}",
        cmt: undefined,
        startOffset: 95,
        endOffset: 143,
        isExported: true,
        isVoid: false,
        args: [
          {
            dims: 0,
            isExported: false,
            module: "dummy.ts",
            name: "n",
            optional: false,
            type: {
              dims: 0,
              children: [],
              resolved: true,
              value: 3,
              type: ArgTag.LITERAL,
            },
            typeRefName: "litn",
          },
          {
            dims: 0,
            isExported: false,
            module: "dummy.ts",
            name: "a",
            optional: false,
            type: {
              dims: 0,
              children: [],
              resolved: true,
              value: "a",
              type: ArgTag.LITERAL,
            },
            typeRefName: "lita",
          },
          {
            dims: 0,
            isExported: false,
            module: "dummy.ts",
            name: "b",
            optional: false,
            type: {
              dims: 0,
              children: [],
              resolved: true,
              type: ArgTag.LITERAL,
              value: true,
            },
            typeRefName: "litb",
          },
        ],
        returnType: undefined,
      },
    ]);
  });

  it("findFnInSource: union args", () => {
    const src = `
    type hellos = "hello" | "bonjour" | "olá" | "ciao" | "hej";
    type stringOrNumber = string | number;
    type maybeString = string | undefined;
    export function test(a:stringOrNumber,b:maybeString[]):boolean | undefined {return;}
    `;
    const thisProgram = dummyProgram.setSrc(() => src);
    expect(
      Object.values(thisProgram.getFunctions()).map((e) => e.getRef())
    ).toEqual([
      {
        name: "test",
        module: "dummy.ts",
        src: "function test(a:stringOrNumber,b:maybeString[]):boolean | undefined {return;}",
        cmt: undefined,
        startOffset: 162,
        endOffset: 239,
        isExported: true,
        isVoid: false,
        args: [
          {
            dims: 0,
            isExported: false,
            module: "dummy.ts",
            name: "a",
            optional: false,
            type: {
              dims: 0,
              children: [
                {
                  dims: 0,
                  isExported: false,
                  module: "dummy.ts",
                  optional: false,
                  type: {
                    dims: 0,
                    children: [],
                    resolved: true,
                    type: ArgTag.STRING,
                  },
                },
                {
                  dims: 0,
                  isExported: false,
                  module: "dummy.ts",
                  optional: false,
                  type: {
                    dims: 0,
                    children: [],
                    resolved: true,
                    type: ArgTag.NUMBER,
                  },
                },
              ],
              resolved: true,
              type: ArgTag.UNION,
            },
            typeRefName: "stringOrNumber",
          },
          {
            dims: 1,
            isExported: false,
            module: "dummy.ts",
            name: "b",
            optional: false,
            type: {
              dims: 0,
              children: [
                {
                  dims: 0,
                  isExported: false,
                  module: "dummy.ts",
                  optional: false,
                  type: {
                    dims: 0,
                    children: [],
                    resolved: true,
                    type: ArgTag.STRING,
                  },
                },
                {
                  dims: 0,
                  isExported: false,
                  module: "dummy.ts",
                  optional: false,
                  type: {
                    dims: 0,
                    children: [],
                    resolved: true,
                    type: ArgTag.LITERAL,
                  },
                },
              ],
              resolved: true,
              type: ArgTag.UNION,
            },
            typeRefName: "maybeString",
          },
        ],
        returnType: {
          dims: 0,
          isExported: false,
          module: "dummy.ts",
          optional: false,
          type: {
            dims: 0,
            resolved: true,
            type: ArgTag.UNION,
            children: [
              {
                dims: 0,
                isExported: false,
                module: "dummy.ts",
                optional: false,
                type: {
                  dims: 0,
                  children: [],
                  resolved: true,
                  type: ArgTag.BOOLEAN,
                },
              },
              {
                dims: 0,
                isExported: false,
                module: "dummy.ts",
                optional: false,
                type: {
                  dims: 0,
                  children: [],
                  resolved: true,
                  type: ArgTag.LITERAL,
                  value: undefined,
                },
              },
            ],
          },
        },
      },
    ]);
  });

  it("findFnInSource: type references w/arrays", () => {
    const src = `
    type onlyNumbers = number[];
    type onlyNumber = number;
    export function test5(a: onlyNumbers): void {return;}
    export function test6(a: onlyNumbers[]): void {return;}
    export function test7(a: onlyNumber): void {return;}
    export function test8(a: onlyNumber[]): void {return;}`;
    const thisProgram = dummyProgram.setSrc(() => src);
    expect(
      Object.values(thisProgram.getFunctions()).map((e) => e.getRef())
    ).toEqual([
      {
        name: "test5",
        module: "dummy.ts",
        src: "function test5(a: onlyNumbers): void {return;}",
        cmt: undefined,
        startOffset: 75,
        endOffset: 121,
        isExported: true,
        isVoid: true,
        args: [
          {
            dims: 0,
            isExported: false,
            module: "dummy.ts",
            name: "a",
            optional: false,
            type: {
              dims: 1,
              children: [],
              resolved: true,
              type: ArgTag.NUMBER,
            },
            typeRefName: "onlyNumbers",
          },
        ],
        returnType: undefined,
      },
      {
        name: "test6",
        module: "dummy.ts",
        src: "function test6(a: onlyNumbers[]): void {return;}",
        cmt: undefined,
        startOffset: 133,
        endOffset: 181,
        isExported: true,
        isVoid: true,
        args: [
          {
            dims: 1,
            isExported: false,
            module: "dummy.ts",
            name: "a",
            optional: false,
            type: {
              dims: 1,
              children: [],
              resolved: true,
              type: ArgTag.NUMBER,
            },
            typeRefName: "onlyNumbers",
          },
        ],
        returnType: undefined,
      },
      {
        name: "test7",
        module: "dummy.ts",
        src: "function test7(a: onlyNumber): void {return;}",
        cmt: undefined,
        startOffset: 193,
        endOffset: 238,
        isExported: true,
        isVoid: true,
        args: [
          {
            dims: 0,
            isExported: false,
            module: "dummy.ts",
            name: "a",
            optional: false,
            type: {
              dims: 0,
              children: [],
              resolved: true,
              type: ArgTag.NUMBER,
            },
            typeRefName: "onlyNumber",
          },
        ],
        returnType: undefined,
      },
      {
        name: "test8",
        module: "dummy.ts",
        src: "function test8(a: onlyNumber[]): void {return;}",
        cmt: undefined,
        startOffset: 250,
        endOffset: 297,
        isExported: true,
        isVoid: true,
        args: [
          {
            dims: 1,
            isExported: false,
            module: "dummy.ts",
            name: "a",
            optional: false,
            type: {
              dims: 0,
              children: [],
              resolved: true,
              type: ArgTag.NUMBER,
            },
            typeRefName: "onlyNumber",
          },
        ],
        returnType: undefined,
      },
    ]);
  });

  it("literal union type ref", () => {
    //const src = `function $_f(union: "hello" | "bonjour"):void {}`;
    const src = `function $_f(union: unionType):void {};type unionType = "hello" | "bonjour";`;
    const thisProgram = dummyProgram.setSrc(() => src);

    expect(thisProgram.getFunctions()["$_f"].getArgDefs()).toEqual([
      makeArgDef(
        dummyRef.module,
        "union",
        0,
        ArgTag.UNION,
        argOptions,
        0,
        undefined,
        [
          makeTypeRef(
            dummyRef.module,
            "unknown",
            ArgTag.LITERAL,
            0,
            undefined,
            undefined,
            undefined,
            "hello"
          ),
          makeTypeRef(
            dummyRef.module,
            "unknown",
            ArgTag.LITERAL,
            0,
            undefined,
            undefined,
            undefined,
            "bonjour"
          ),
        ],
        "unionType"
      ),
    ]);
  });

  it("literal union literal type", () => {
    const src = `function $_f(union: "hello" | "bonjour"):void {}`;
    const thisProgram = dummyProgram.setSrc(() => src);

    expect(thisProgram.getFunctions()["$_f"].getArgDefs()).toEqual([
      makeArgDef(
        dummyRef.module,
        "union",
        0,
        ArgTag.UNION,
        argOptions,
        0,
        undefined,
        [
          makeTypeRef(
            dummyRef.module,
            "unknown",
            ArgTag.LITERAL,
            0,
            undefined,
            undefined,
            undefined,
            "hello"
          ),
          makeTypeRef(
            dummyRef.module,
            "unknown",
            ArgTag.LITERAL,
            0,
            undefined,
            undefined,
            undefined,
            "bonjour"
          ),
        ]
      ),
    ]);
  });
});
