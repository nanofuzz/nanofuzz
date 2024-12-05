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
        returnType: {
          dims: 0,
          isExported: false,
          module: "dummy.ts",
          optional: false,
          type: {
            children: [],
            resolved: true,
            type: "string",
          },
        },
      },
      {
        name: "test2",
        module: "dummy.ts",
        src: 'function test2() {const test = (array:string[]):string => {return "";}}',
        startOffset: 99,
        endOffset: 170,
        isExported: true,
        args: [],
        returnType: undefined,
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
      returnType: {
        dims: 0,
        isExported: false,
        module: "dummy.ts",
        optional: false,
        type: {
          children: [],
          resolved: true,
          type: "string",
        },
      },
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
      returnType: {
        dims: 0,
        isExported: false,
        module: "dummy.ts",
        optional: false,
        type: {
          children: [],
          resolved: true,
          type: "string",
        },
      },
    });
  });
});
