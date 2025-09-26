import { ArgTag, TypeRef, ArgType, ArgOptions, Interval } from "./Types";
import { ArgDef } from "./ArgDef";
import seedrandom from "seedrandom";
import * as JSON5 from "json5";
import { ArgDefValidator } from "./ArgDefValidator";
import { ArgDefGenerator } from "./ArgDefGenerator";
import { ArgDefMutator } from "./ArgDefMutator";

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

  it("NoInput test", function () {
    const prng = seedrandom("qwertyuiop");
    const q = new ArgDef<ArgType>(
      "q",
      0,
      ArgTag.STRING,
      {
        ...argOptions,
        strLength: { min: 0, max: 2 },
        isNoInput: false,
        dimLength: [{ min: 1, max: 2 }],
      },
      1,
      false,
      undefined,
      []
    );
    const n = new ArgDef<ArgType>(
      "n",
      0,
      ArgTag.OBJECT,
      { ...argOptions, isNoInput: true, dimLength: [] },
      0,
      false,
      undefined,
      []
    );
    const h = new ArgDef<ArgType>(
      "h",
      0,
      ArgTag.OBJECT,
      { ...argOptions, isNoInput: false, dimLength: [] },
      0,
      false,
      undefined,
      [n]
    );
    const gen = new ArgDefGenerator([h], prng);
    const val = new ArgDefValidator([h]);
    const input = gen.next();
    console.debug(`Spec: ${abbrSpec(h)}`);
    console.debug(`Input: ${JSON.stringify(input)}`);
    expect(val.validate(input)).toBeTrue();
  });

  it("fuzz test gen/mutate/validate loop", function () {
    const prng = seedrandom("qwertyuiop");
    let outputted = false; // !!!!!!!!
    const stats: {
      gens: { valid: number; invalid: number };
      muts: { valid: number; invalid: number; dupe: number };
      specs: {
        [k: string]: { [k: string]: number };
      };
    } = {
      gens: { valid: 0, invalid: 0 },
      muts: { valid: 0, invalid: 0, dupe: 0 },
      specs: {},
    };
    const failingSpecs: string[] = [];
    const failingMutators: { [k: string]: number } = {};
    let i = 50;
    while (i--) {
      const spec = [getRandomArgDef(prng, Math.floor(prng() * 2))];
      const stxt = abbrSpec(spec[0]).join("\r\n");
      const gen = new ArgDefGenerator(spec, prng);
      const val = new ArgDefValidator(spec);

      let j = 50;
      while (j--) {
        const input = gen.next();
        const isValid = val.validate(input);
        if (!isValid) {
          const itxt = JSON5.stringify(input[0]);
          stats.gens.invalid++;
          stats.specs[stxt] = stats.specs[stxt] ?? {};
          stats.specs[stxt][itxt] = (stats.specs[stxt][itxt] ?? 0) + 1;
          failingSpecs.push(stxt);
        } else {
          stats.gens.valid++;
        }
        expect(isValid).toBeTrue(); // generated input passed validation

        let k = 50;
        while (k--) {
          const inputStringBefore = JSON5.stringify(input);
          const muts = ArgDefMutator.getMutators(spec, input, prng);
          if (muts.length) {
            const index = Math.floor(prng() * (muts.length - 1));
            const mut = muts[index];
            mut.fn(); // mutate the input
            const inputStringAfter = JSON5.stringify(input);
            if (inputStringBefore === inputStringAfter) {
              stats.muts.dupe++;
            }
            expect(inputStringBefore === inputStringAfter).toBeFalse();

            const isValid = val.validate(input);
            if (!isValid) {
              stats.muts.invalid++;
              failingMutators[mut.name] = (failingMutators[mut.name] ?? 0) + 1;
            } else {
              stats.muts.valid++;
            }
            expect(isValid).toBeTrue(); // generated input passed validation

            if (!k) {
              try {
                mut.fn();
                console.error(`Double mutation is expected to fail but didn't`);
                expect(false).toBeTrue();
              } catch (e: unknown) {
                // we expect this to throw an exception
              }
            }
          }
        }
      }
    }

    console.debug(`${Object.keys(stats.specs).length} specs had failed gens:`);
    const specs: Record<string, number> = {};
    failingSpecs.forEach((e) => (specs[e] = (specs[e] ?? 0) + 1));
    for (const k in specs) {
      console.debug(`${specs[k]}: ${k}`);
    }
    console.debug(
      `${
        Object.keys(failingMutators).length
      } failing mutators: ${JSON5.stringify(failingMutators, null, 3)}`
    );
    console.debug(`Stats: ${JSON5.stringify(stats, null, 3)}`);
  });
});

// Helper function to abbreviate ArgDef specs
function abbrSpec(spec: ArgDef<ArgType>, indents = 0): string[] {
  const space = "  ".repeat(indents);
  const line: string[] = [];
  line.push(space);
  line.push(`${spec.getName()}:${spec.getTypeAnnotation()}`);
  line.push(`dims: ${JSON5.stringify(spec.getOptions().dimLength)}`);
  if (spec.isNoInput()) line.push(`NOINPUT`);
  if (spec.getType() === ArgTag.NUMBER && spec.getOptions().numSigned)
    line.push(`SIGNED`);
  if (spec.getType() === ArgTag.NUMBER && spec.getOptions().numInteger)
    line.push(`INTEGER`);
  if (
    spec.getType() === ArgTag.NUMBER ||
    spec.getType() === ArgTag.BOOLEAN ||
    spec.getType() === ArgTag.LITERAL
  )
    line.push(`range: ${JSON5.stringify(spec.getIntervals())}`);

  const children = spec.getChildren();
  const clines: string[] = [];
  for (const c of children) {
    clines.push(...abbrSpec(c, indents + 1));
  }
  return [line.join(" "), ...clines];
}

// Create a random ArgDef spec
function getRandomArgDef(
  prng: seedrandom.prng,
  levels = 0,
  parentType?: ArgTag
): ArgDef<ArgType> {
  const argTagOptions: ArgTag[] = [
    ArgTag.NUMBER,
    ArgTag.STRING,
    ArgTag.BOOLEAN,
    ArgTag.OBJECT,
    ArgTag.LITERAL,
    ArgTag.UNION,
  ];
  const argTag = argTagOptions[Math.floor(prng() * (argTagOptions.length - 1))];

  const children: ArgDef<ArgType>[] = [];
  if (levels && (argTag === ArgTag.OBJECT || argTag === ArgTag.UNION)) {
    let childCount = 2;
    while (childCount--) {
      children.push(getRandomArgDef(prng, levels - 1, argTag));
    }
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
  const dims = dimOptions[Math.floor(prng() * (dimOptions.length - 1))];
  const isOptional = parentType === ArgTag.OBJECT && prng() > 0.5;
  const name = "abcdefghijklmnopqrstuvwxyz".split("")[Math.floor(prng() * 25)];
  let options: ArgOptions = {
    ...argOptions,
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
        numSigned: prng() < 0.5,
      };
      if (options.numInteger) {
        if (options.numSigned) {
          const min = Math.floor(prng() * 200) - 100;
          interval = [{ min, max: min + Math.floor(prng() * 200) }];
        } else {
          const min = Math.floor(prng() * 100);
          interval = [{ min, max: min + Math.floor(prng() * 100) }];
        }
      } else {
        if (options.numSigned) {
          const min = prng() * 200 - 100;
          interval = [{ min, max: min + prng() * 200 }];
        } else {
          const min = prng() * 100;
          interval = [{ min, max: min + prng() * 100 }];
        }
      }
      break;
    }
    case ArgTag.STRING: {
      interval;
      options = {
        ...options,
        strLength: { min: Math.floor(prng() * 2), max: 2 },
      };
      break;
    }
    case ArgTag.BOOLEAN: {
      interval = [
        [
          { min: false, max: false },
          { min: false, max: true },
          { min: true, max: true },
        ][Math.floor(prng() * 2)],
      ];
      break;
    }
    case ArgTag.OBJECT: {
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
    case ArgTag.UNION: {
      break;
    }
  }
  return new ArgDef<ArgType>(
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
