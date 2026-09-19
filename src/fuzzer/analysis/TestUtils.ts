import { ArgDef } from "./ArgDef";
import { ArgTag, TypeRef, ArgType, ArgOptions, Interval } from "./Types";
import seedrandom from "seedrandom";

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
): ArgDef {
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

// Create a random ArgDef spec
export function getRandomArgDef(
  prng: seedrandom.prng,
  levels = 0,
  parentType?: ArgTag
): ArgDef {
  const dftArgOptions = ArgDef.getDefaultOptions();
  const primitiveTags: ArgTag[] = [
    ArgTag.NUMBER,
    ArgTag.STRING,
    ArgTag.BOOLEAN,
    ArgTag.BYTES,
    ArgTag.LITERAL,
  ];
  const containerTags: ArgTag[] = [
    ArgTag.OBJECT,
    ArgTag.DICTIONARY,
    ArgTag.SET,
    ArgTag.UNION,
    ArgTag.TUPLE,
  ];
  const argTagOptions =
    levels > 0 ? [...primitiveTags, ...containerTags] : primitiveTags;
  const argTag = argTagOptions[Math.floor(prng() * argTagOptions.length)];

  const children: ArgDef[] = [];
  const nextLevel = Math.max(0, levels - 1);

  switch (argTag) {
    case ArgTag.OBJECT: {
      let childCount = 2;
      let attempts = 0;
      while (childCount > 0 && attempts++ < 50) {
        const child = getRandomArgDef(prng, nextLevel, argTag);
        if (children.every((e) => e.getName() !== child.getName())) {
          children.push(child);
          childCount--;
        }
      }
      break;
    }
    case ArgTag.UNION: {
      let childCount = 2;
      let attempts = 0;
      while (childCount > 0 && attempts++ < 50) {
        const child = getRandomArgDef(prng, nextLevel, argTag);
        if (children.every((e) => e.getName() !== child.getName())) {
          children.push(child);
          childCount--;
        }
      }
      break;
    }
    case ArgTag.TUPLE: {
      for (let i = 0; i < 2; i++) {
        const childRaw = getRandomArgDef(prng, nextLevel, argTag);
        const childDef = new ArgDef(
          String(i),
          childRaw.getOffset(),
          childRaw.getType(),
          childRaw.getOptions(),
          childRaw.getDim(),
          false,
          childRaw.getIntervals(),
          childRaw.getChildren()
        );
        children.push(childDef);
      }
      break;
    }
    case ArgTag.DICTIONARY: {
      const keyTagOptions = [ArgTag.NUMBER, ArgTag.STRING, ArgTag.BOOLEAN];
      const keyTag = keyTagOptions[Math.floor(prng() * keyTagOptions.length)];
      let keyOpt: ArgOptions = { ...dftArgOptions };
      if (keyTag === ArgTag.STRING) {
        keyOpt = {
          ...keyOpt,
          strLength: { min: 1, max: 2 },
        };
      }
      const keyChild = new ArgDef("keys", 0, keyTag, keyOpt, 0, false);

      const valChildRaw = getRandomArgDef(prng, nextLevel, argTag);
      const valChild = new ArgDef(
        "values",
        valChildRaw.getOffset(),
        valChildRaw.getType(),
        valChildRaw.getOptions(),
        valChildRaw.getDim(),
        false,
        valChildRaw.getIntervals(),
        valChildRaw.getChildren()
      );
      children.push(keyChild, valChild);
      break;
    }
    case ArgTag.SET: {
      const elemChildRaw = getRandomArgDef(prng, nextLevel, argTag);
      const elemChild = new ArgDef(
        "values",
        elemChildRaw.getOffset(),
        elemChildRaw.getType(),
        elemChildRaw.getOptions(),
        elemChildRaw.getDim(),
        false,
        elemChildRaw.getIntervals(),
        elemChildRaw.getChildren()
      );
      children.push(elemChild);
      break;
    }
    case ArgTag.NUMBER:
    case ArgTag.STRING:
    case ArgTag.BOOLEAN:
    case ArgTag.BYTES:
    case ArgTag.LITERAL:
    case ArgTag.UNRESOLVED:
      break;
    default:
      break;
  }

  const dimOptions = [
    { dims: 0, dimLength: [] },
    { dims: 1, dimLength: [{ min: 0, max: 2 }] },
    { dims: 1, dimLength: [{ min: 1, max: 1 }] },
    { dims: 1, dimLength: [{ min: 0, max: 0 }] },
    { dims: 1, dimLength: [{ min: 1, max: 2 }] },
    {
      dims: 2,
      dimLength: [
        { min: 0, max: 2 },
        { min: 1, max: 1 },
      ],
    },
    {
      dims: 2,
      dimLength: [
        { min: 1, max: 1 },
        { min: 0, max: 0 },
      ],
    },
    {
      dims: 2,
      dimLength: [
        { min: 1, max: 2 },
        { min: 0, max: 2 },
      ],
    },
    {
      dims: 3,
      dimLength: [
        { min: 0, max: 2 },
        { min: 1, max: 1 },
        { min: 0, max: 0 },
      ],
    },
    {
      dims: 3,
      dimLength: [
        { min: 1, max: 2 },
        { min: 0, max: 2 },
        { min: 1, max: 2 },
      ],
    },
    {
      dims: 3,
      dimLength: [
        { min: 1, max: 2 },
        { min: 1, max: 2 },
        { min: 0, max: 2 },
      ],
    },
  ];
  const dims = dimOptions[Math.floor(prng() * dimOptions.length)];
  const isOptional =
    (parentType === ArgTag.OBJECT || parentType === undefined) && prng() > 0.5;
  const name = "abcdefghijklmnopqrstuvwxyz".split("")[Math.floor(prng() * 26)];
  let options: ArgOptions = {
    ...dftArgOptions,
    dimsUnique: dims.dims > 0 && prng() > 0.5,
    dictLength: { min: Math.floor(prng() * 2), max: 2 },
    setLength: { min: Math.floor(prng() * 2), max: 2 },
    isNoInput:
      (parentType === ArgTag.OBJECT || parentType === ArgTag.UNION) &&
      prng() > 0.5,
  };
  let interval: Interval<ArgType>[] | undefined;

  switch (argTag) {
    case ArgTag.NUMBER: {
      options = {
        ...options,
        numInteger: prng() < 0.5,
      };
      if (options.numInteger) {
        const min = Math.floor(prng() * 100);
        interval = [{ min, max: min + Math.floor(prng() * 100) }];
      } else {
        const min = prng() * 100;
        interval = [{ min, max: min + prng() * 100 }];
      }
      break;
    }
    case ArgTag.STRING: {
      options = {
        ...options,
        strLength: { min: Math.floor(prng() * 2), max: 2 },
        strRegex:
          prng() < 0.5
            ? undefined
            : ["\\A[a-z]{1,2}\\Z", "\\A\\d{2}\\Z", "\\A(a|b)\\Z"][
                Math.floor(prng() * 3)
              ],
      };
      break;
    }
    case ArgTag.BOOLEAN: {
      interval = [
        [
          { min: false, max: false },
          { min: false, max: true },
          { min: true, max: true },
        ][Math.floor(prng() * 3)],
      ];
      break;
    }
    case ArgTag.BYTES: {
      options = {
        ...options,
        byteLength: { min: Math.floor(prng() * 2), max: 2 },
      };
      break;
    }
    case ArgTag.LITERAL: {
      if (prng() < 0.1) {
        interval = undefined;
      } else {
        interval = [{ min: name, max: name }];
      }
      break;
    }
    case ArgTag.OBJECT:
    case ArgTag.DICTIONARY:
    case ArgTag.SET:
    case ArgTag.UNION:
    case ArgTag.TUPLE:
      break;
    case ArgTag.UNRESOLVED: {
      throw new Error(
        "ArgTag.UNRESOLVED is not a valid type for getRandomArgDef"
      );
    }
  }
  return new ArgDef(
    name,
    0,
    argTag,
    { ...options, dimLength: dims.dimLength },
    dims.dims,
    isOptional,
    interval,
    children
  );
}
