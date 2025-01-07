import { ArgTag, TypeRef, ArgType } from "./Types";
import { ArgDef } from "./ArgDef";

const argOptions = ArgDef.getDefaultOptions();
const dummyModule = "dummy.ts";

/**
 * Helper functions for generating TypeRefs and ArgDefs
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
    dims: dims,
    type: {
      type: type,
      children: children,
      value: literalValue,
    },
    isExported: true,
  };
}

/**
 * Test that getTypeAnnotation returns the correct type annotation for a given
 * function argument.
 */
describe("fuzzer/analysis/typescript/ArgDef: getTypeAnnotation", () => {
  it.each([ArgTag.STRING, ArgTag.NUMBER, ArgTag.BOOLEAN, ArgTag.LITERAL])(
    "should return %s for primitive type %s",
    (tag: ArgTag) => {
      const argDef = makeArgDef(
        dummyModule,
        "test",
        0,
        tag,
        argOptions,
        0,
        undefined,
        undefined,
        undefined,
        tag === ArgTag.LITERAL ? 5 : undefined
      );
      if (tag === ArgTag.LITERAL) {
        expect(argDef.getTypeAnnotation()).toStrictEqual("5");
      } else {
        expect(argDef.getTypeAnnotation()).toStrictEqual(tag);
      }
    }
  );

  it.each([1, 2, 3])(
    'should return %s "[]"s for array type with %s dimensions',
    (dims: number) => {
      const argDef = makeArgDef(
        dummyModule,
        "test",
        0,
        ArgTag.STRING,
        argOptions,
        dims
      );
      expect(argDef.getTypeAnnotation()).toBe(
        ArgTag.STRING + "[]".repeat(dims)
      );
    }
  );

  it.each([ArgTag.STRING, ArgTag.NUMBER, ArgTag.BOOLEAN, ArgTag.LITERAL])(
    "should return '<type> | undefined' for optional types",
    (tag: ArgTag) => {
      const argDef = makeArgDef(
        dummyModule,
        "test",
        0,
        tag,
        argOptions,
        0,
        true,
        undefined,
        undefined,
        tag === ArgTag.LITERAL ? 5 : undefined
      );
      if (tag === ArgTag.LITERAL) {
        expect(argDef.getTypeAnnotation()).toStrictEqual("5 | undefined");
      } else {
        expect(argDef.getTypeAnnotation()).toStrictEqual(tag + " | undefined");
      }
    }
  );

  test("should return type name for type refs", () => {
    const argDef = makeArgDef(
      dummyModule,
      "test",
      0,
      ArgTag.OBJECT,
      argOptions,
      0,
      false,
      [],
      "Type"
    );
    expect(argDef.getTypeAnnotation()).toStrictEqual("Type");
  });

  test("should return the literal type for literal types", () => {
    const argDef = makeArgDef(
      dummyModule,
      "test",
      0,
      ArgTag.OBJECT,
      argOptions,
      0,
      false,
      [
        makeTypeRef(dummyModule, "bool", ArgTag.BOOLEAN, 0),
        makeTypeRef(dummyModule, "str", ArgTag.STRING, 0),
      ]
    );
    expect(argDef.getTypeAnnotation()).toStrictEqual(
      "{ bool: boolean; str: string }"
    );
  });

  test("type annotation for union with dimensions", () => {
    const argDef = makeArgDef(
      dummyModule,
      "test",
      0,
      ArgTag.UNION,
      argOptions,
      1,
      false,
      [
        makeTypeRef(dummyModule, "bool", ArgTag.BOOLEAN, 1),
        makeTypeRef(dummyModule, "str", ArgTag.STRING, 0),
        makeTypeRef(
          dummyModule,
          "litn",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          5
        ),
        makeTypeRef(
          dummyModule,
          "lita",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          "x"
        ),
        makeTypeRef(
          dummyModule,
          "und",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          undefined
        ),
      ]
    );
    expect(argDef.getTypeAnnotation()).toStrictEqual(
      "(boolean[] | string | 5 | 'x' | undefined)[]"
    );
  });

  test("type annotation for union with dimensions and optionality", () => {
    const argDef = makeArgDef(
      dummyModule,
      "test",
      0,
      ArgTag.UNION,
      argOptions,
      1,
      true,
      [
        makeTypeRef(dummyModule, "bool", ArgTag.BOOLEAN, 1),
        makeTypeRef(dummyModule, "str", ArgTag.STRING, 0),
        makeTypeRef(
          dummyModule,
          "litn",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          5
        ),
        makeTypeRef(
          dummyModule,
          "lita",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          "x"
        ),
        makeTypeRef(
          dummyModule,
          "und",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          undefined
        ),
      ]
    );
    expect(argDef.getTypeAnnotation()).toStrictEqual(
      "(boolean[] | string | 5 | 'x' | undefined)[] | undefined"
    );
  });

  test("type annotation for union w/o dimensions", () => {
    const argDef = makeArgDef(
      dummyModule,
      "test",
      0,
      ArgTag.UNION,
      argOptions,
      0,
      false,
      [
        makeTypeRef(dummyModule, "bool", ArgTag.BOOLEAN, 1),
        makeTypeRef(dummyModule, "str", ArgTag.STRING, 0),
        makeTypeRef(
          dummyModule,
          "litn",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          5
        ),
        makeTypeRef(
          dummyModule,
          "lita",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          "x"
        ),
        makeTypeRef(
          dummyModule,
          "und",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          undefined
        ),
      ]
    );
    expect(argDef.getTypeAnnotation()).toStrictEqual(
      "boolean[] | string | 5 | 'x' | undefined"
    );
  });

  test("type annotation for union w/double optionality", () => {
    const argDef = makeArgDef(
      dummyModule,
      "test",
      0,
      ArgTag.UNION,
      argOptions,
      0,
      true,
      [
        makeTypeRef(dummyModule, "bool", ArgTag.BOOLEAN, 1),
        makeTypeRef(dummyModule, "str", ArgTag.STRING, 0),
        makeTypeRef(
          dummyModule,
          "litn",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          5
        ),
        makeTypeRef(
          dummyModule,
          "lita",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          "x"
        ),
        makeTypeRef(
          dummyModule,
          "und",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          undefined
        ),
      ]
    );
    expect(argDef.getTypeAnnotation()).toStrictEqual(
      "boolean[] | string | 5 | 'x' | undefined"
    );
  });

  test("type annotation for union w/single optionality", () => {
    const argDef = makeArgDef(
      dummyModule,
      "test",
      0,
      ArgTag.UNION,
      argOptions,
      0,
      true,
      [
        makeTypeRef(dummyModule, "bool", ArgTag.BOOLEAN, 1),
        makeTypeRef(dummyModule, "str", ArgTag.STRING, 0),
        makeTypeRef(
          dummyModule,
          "litn",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          5
        ),
        makeTypeRef(
          dummyModule,
          "lita",
          ArgTag.LITERAL,
          0,
          undefined,
          undefined,
          undefined,
          "x"
        ),
      ]
    );
    expect(argDef.getTypeAnnotation()).toStrictEqual(
      "boolean[] | string | 5 | 'x' | undefined"
    );
  });
});
