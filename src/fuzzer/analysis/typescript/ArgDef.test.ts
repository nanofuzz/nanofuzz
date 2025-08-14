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
 * Test that getTypeAnnotation returns the correct type annotation for a given
 * function argument.
 */
describe("fuzzer/analysis/typescript/ArgDef: getTypeAnnotation", () => {
  [ArgTag.STRING, ArgTag.NUMBER, ArgTag.BOOLEAN, ArgTag.LITERAL].forEach(
    (tag: ArgTag) => {
      it(`should return %s for primitive type '${tag}'`, () => {
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
          expect(argDef.getTypeAnnotation()).toBe("5");
        } else {
          expect(argDef.getTypeAnnotation()).toBe(tag);
        }
      });
    }
  );

  [1, 2, 3].forEach((dims: number) => {
    it(`should return ${dims} "[]"s for array type with ${dims} dimensions`, () => {
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
    });
  });

  [ArgTag.STRING, ArgTag.NUMBER, ArgTag.BOOLEAN, ArgTag.LITERAL].forEach(
    (tag: ArgTag) => {
      it(`should return '<type> | undefined' for optional types (${tag})`, () => {
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
          expect(argDef.getTypeAnnotation()).toBe("5 | undefined");
        } else {
          expect(argDef.getTypeAnnotation()).toBe(tag + " | undefined");
        }
      });
    }
  );

  it("should return type name for type refs", () => {
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
    expect(argDef.getTypeAnnotation()).toBe("Type");
  });

  it("should return the literal type for literal types", () => {
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
    expect(argDef.getTypeAnnotation()).toBe("{ bool: boolean; str: string }");
  });

  it("type annotation for union with dimensions", () => {
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
    expect(argDef.getTypeAnnotation()).toBe(
      "(boolean[] | string | 5 | 'x' | undefined)[]"
    );
  });

  it("type annotation for union with dimensions and optionality", () => {
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
    expect(argDef.getTypeAnnotation()).toBe(
      "(boolean[] | string | 5 | 'x' | undefined)[] | undefined"
    );
  });

  it("type annotation for union w/o dimensions", () => {
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
    expect(argDef.getTypeAnnotation()).toBe(
      "boolean[] | string | 5 | 'x' | undefined"
    );
  });

  it("type annotation for union w/double optionality", () => {
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
    expect(argDef.getTypeAnnotation()).toBe(
      "boolean[] | string | 5 | 'x' | undefined"
    );
  });

  it("type annotation for union w/single optionality", () => {
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
    expect(argDef.getTypeAnnotation()).toBe(
      "boolean[] | string | 5 | 'x' | undefined"
    );
  });
});
