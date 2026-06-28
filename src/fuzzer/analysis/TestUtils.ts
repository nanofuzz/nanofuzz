import { ArgDef } from "./ArgDef";
import { ArgTag, TypeRef, ArgType } from "./Types";

/**
 * Helper functions for generating TypeRefs and ArgDefs
 */
export function makeArgDef(
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

export function makeTypeRef(
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
