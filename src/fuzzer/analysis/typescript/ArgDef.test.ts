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
  typeRefName?: string
): ArgDef<ArgType> {
  return ArgDef.fromTypeRef(
    makeTypeRef(module, name, type, dims, optional, children, typeRefName),
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
  typeRefName?: string
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
    },
    isExported: true,
  };
}

/**
 * Test that getTypeAnnotation returns the correct type annotation for a given
 * function argument.
 */
describe("fuzzer/analysis/typescript/ArgDef: getTypeAnnotation", () => {
  it.each([ArgTag.STRING, ArgTag.NUMBER, ArgTag.BOOLEAN])(
    "should return %s for primitive type %s",
    (tag: ArgTag) => {
      const argDef = makeArgDef(dummyModule, "test", 0, tag, argOptions, 0);
      expect(argDef.getTypeAnnotation()).toBe(tag);
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

  it.each([ArgTag.STRING, ArgTag.NUMBER, ArgTag.BOOLEAN])(
    "should return '<type> | undefined' for optional types",
    (tag: ArgTag) => {
      const argDef = makeArgDef(
        dummyModule,
        "test",
        0,
        tag,
        argOptions,
        0,
        true
      );
      expect(argDef.getTypeAnnotation()).toBe(tag + " | undefined");
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
    expect(argDef.getTypeAnnotation()).toBe("Type");
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
    expect(argDef.getTypeAnnotation()).toBe("{ bool: boolean; str: string }");
  });
});
