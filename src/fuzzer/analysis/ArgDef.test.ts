import { ArgTag, ArgType, ArgOptions, Interval } from "./Types";
import { ArgDef } from "./ArgDef";
import seedrandom from "seedrandom";
import * as JSONN from "../../Jsonn";
import { ArgDefValidator } from "./ArgDefValidator";
import { ArgDefGenerator } from "./ArgDefGenerator";
import { ArgDefMutator } from "./ArgDefMutator";
import { makeArgDef, makeTypeRef } from "./TestUtils";
import { TypescriptProgram } from "./typescript/TypescriptProgram";

const argOptions = ArgDef.getDefaultOptions();
const dummyModule = "dummy.ts";

/**
 * Test that getTypeAnnotation returns the correct type annotation for a given
 * function argument.
 */
describe("fuzzer/analysis/typescript/getTypeAnnotation: ", () => {
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
          expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe("5");
        } else {
          expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe(tag);
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
      expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe(
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
          expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe(
            "5 | undefined"
          );
        } else {
          expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe(
            tag + " | undefined"
          );
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
    expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe("Type");
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
    expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe(
      "{ bool: boolean; str: string }"
    );
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
    expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe(
      `(boolean[] | string | 5 | "x" | undefined)[]`
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
    expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe(
      `(boolean[] | string | 5 | "x" | undefined)[] | undefined`
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
    expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe(
      `boolean[] | string | 5 | "x" | undefined`
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
    expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe(
      `boolean[] | string | 5 | "x" | undefined`
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
    expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe(
      `boolean[] | string | 5 | "x" | undefined`
    );
  });

  it("type annotation for tuple w/o dimensions", () => {
    const argDef = makeArgDef(
      dummyModule,
      "test",
      0,
      ArgTag.TUPLE,
      argOptions,
      0,
      false,
      [
        makeTypeRef(dummyModule, "bool", ArgTag.BOOLEAN, 1),
        makeTypeRef(dummyModule, "str", ArgTag.STRING, 0),
      ]
    );
    expect(TypescriptProgram.getTypeAnnotation(argDef)).toBe(
      "[boolean[], string]"
    );
  });

  it("NoInput test", function () {
    const prng = seedrandom("qwertyuiop");
    /*
    const q = new ArgDef(
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
    */
    const n = new ArgDef(
      "n",
      0,
      ArgTag.OBJECT,
      { ...argOptions, isNoInput: true, dimLength: [] },
      0,
      false,
      undefined,
      []
    );
    const h = new ArgDef(
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
    expect(val.validate(input)).toBeTrue();
  });

  it("dimsUnique: generates unique outer-dimension values", () => {
    const spec = makeArgDef(
      dummyModule,
      "uniqueNumbers",
      0,
      ArgTag.NUMBER,
      {
        ...argOptions,
        dimsUnique: true,
        dimLength: [{ min: 5, max: 5 }],
      },
      1
    );
    const generated = ArgDefGenerator.gen(spec, seedrandom("dimsUnique"));

    expect(ArgDefValidator.validate(generated, spec)).toBeTrue();
    if (!Array.isArray(generated)) {
      throw new Error("Expected an array");
    }
    expect(new Set(generated).size).toEqual(5);
  });

  it("dimsUnique: can give up at the minimum dimension length", () => {
    const spec = makeArgDef(
      dummyModule,
      "uniqueLiteral",
      0,
      ArgTag.LITERAL,
      {
        ...argOptions,
        dimsUnique: true,
        dimLength: [{ min: 1, max: 2 }],
      },
      1,
      false,
      [],
      undefined,
      1
    );
    const generated = ArgDefGenerator.gen(spec, seedrandom("uniqueLiteral"));

    if (!Array.isArray(generated)) {
      throw new Error("Expected an array");
    }
    expect(generated.length).toEqual(1);
    expect(generated[0] === 1).toBeTrue();
    expect(ArgDefValidator.validate(generated, spec)).toBeTrue();
  });

  it("dimsUnique: fails when constraints seem impossible", () => {
    const spec = makeArgDef(
      dummyModule,
      "uniqueLiteral",
      0,
      ArgTag.LITERAL,
      {
        ...argOptions,
        dimsUnique: true,
        dimLength: [{ min: 2, max: 2 }],
      },
      1,
      false,
      [],
      undefined,
      1
    );

    expect(() =>
      ArgDefGenerator.gen(spec, seedrandom("uniqueLiteral"))
    ).toThrowError(
      "Unable to generate enough unique array element. Are constraints possible to meet?"
    );
  });

  it("dimsUnique: union with non-constant types falls back to nArray", () => {
    const spec = makeArgDef(
      dummyModule,
      "unionArray",
      0,
      ArgTag.UNION,
      {
        ...argOptions,
        dimsUnique: true,
        dimLength: [{ min: 5, max: 5 }],
      },
      1,
      false,
      [
        makeTypeRef(dummyModule, "num", ArgTag.NUMBER, 0),
        makeTypeRef(dummyModule, "str", ArgTag.STRING, 0),
      ]
    );

    const generated = ArgDefGenerator.gen(spec, seedrandom("unionArray"));
    expect(ArgDefValidator.validate(generated, spec)).toBeTrue();
    if (!Array.isArray(generated)) {
      throw new Error("Expected an array");
    }
    expect(generated.length).toEqual(5);
    expect(new Set(generated.map((e) => JSON.stringify(e))).size).toEqual(5);
  });

  it("dictionary: generates unique keys within dictLength bounds", () => {
    const spec = makeArgDef(
      dummyModule,
      "dict",
      0,
      ArgTag.DICTIONARY,
      {
        ...argOptions,
        dictLength: { min: 3, max: 5 },
      },
      0,
      false,
      [
        makeTypeRef(dummyModule, "key", ArgTag.STRING, 0),
        makeTypeRef(dummyModule, "val", ArgTag.NUMBER, 0),
      ]
    );

    const generated = ArgDefGenerator.gen(spec, seedrandom("dictUniqueKeys"));
    expect(ArgDefValidator.validate(generated, spec)).toBeTrue();
    if (
      typeof generated !== "object" ||
      generated === null ||
      Array.isArray(generated)
    ) {
      throw new Error("Expected an object");
    }
    const keys = Object.keys(generated);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(keys.length).toBeLessThanOrEqual(5);
  });

  it("dictionary: throws when unique key constraint cannot meet min dictLength", () => {
    const spec = makeArgDef(
      dummyModule,
      "dictImpossible",
      0,
      ArgTag.DICTIONARY,
      {
        ...argOptions,
        dictLength: { min: 2, max: 2 },
      },
      0,
      false,
      [
        makeTypeRef(
          dummyModule,
          "key",
          ArgTag.LITERAL,
          0,
          false,
          [],
          undefined,
          "fixedKey"
        ),
        makeTypeRef(dummyModule, "val", ArgTag.NUMBER, 0),
      ]
    );

    expect(() =>
      ArgDefGenerator.gen(spec, seedrandom("dictImpossible"))
    ).toThrowError(
      "Unable to generate enough unique dictionary keys. Are constraints possible to meet?"
    );
  });

  it("dimsUnique: nested union of constants uses fast path", () => {
    const innerUnion1 = makeArgDef(
      dummyModule,
      "inner1",
      0,
      ArgTag.UNION,
      argOptions,
      0,
      false,
      [
        makeTypeRef(
          dummyModule,
          "l1",
          ArgTag.LITERAL,
          0,
          false,
          [],
          undefined,
          10
        ),
        makeTypeRef(
          dummyModule,
          "l2",
          ArgTag.LITERAL,
          0,
          false,
          [],
          undefined,
          20
        ),
      ]
    );
    const innerUnion2 = makeArgDef(
      dummyModule,
      "inner2",
      0,
      ArgTag.UNION,
      argOptions,
      0,
      false,
      [
        makeTypeRef(
          dummyModule,
          "l3",
          ArgTag.LITERAL,
          0,
          false,
          [],
          undefined,
          30
        ),
        makeTypeRef(
          dummyModule,
          "l4",
          ArgTag.LITERAL,
          0,
          false,
          [],
          undefined,
          40
        ),
      ]
    );

    const spec = new ArgDef(
      "nestedUnionArray",
      0,
      ArgTag.UNION,
      {
        ...argOptions,
        dimsUnique: true,
        dimLength: [{ min: 4, max: 4 }],
      },
      1,
      false,
      undefined,
      [innerUnion1, innerUnion2]
    );

    const generated = ArgDefGenerator.gen(spec, seedrandom("nestedUnionArray"));
    expect(ArgDefValidator.validate(generated, spec)).toBeTrue();
    if (!Array.isArray(generated)) {
      throw new Error("Expected an array");
    }
    expect(generated.length).toEqual(4);
    expect(new Set(generated).size).toEqual(4);
  });

  it("dimsUnique: mutators preserve outer-dimension uniqueness", () => {
    const spec = new ArgDef(
      "uniqueNumbers",
      0,
      ArgTag.NUMBER,
      {
        ...argOptions,
        dimsUnique: true,
        dimLength: [{ min: 2, max: 2 }],
      },
      1,
      false,
      [{ min: 1, max: 2 }]
    );
    const input = [{ tag: "ArgValueTypeWrapped" as const, value: [1, 2] }];
    const validator = new ArgDefValidator([spec]);
    const mutations = ArgDefMutator.getMutators(
      [spec],
      input,
      seedrandom("dimsUniqueMutations")
    );

    expect(mutations.length).toBeGreaterThan(0);
    for (let index = 0; index < mutations.length; index++) {
      // Mutator functions may run only once per set, so rebuild the same
      // proposal set for a fresh candidate before testing each mutation.
      const candidate = JSONN.parse<typeof input>(JSONN.stringify(input));
      const candidateMutations = ArgDefMutator.getMutators(
        [spec],
        candidate,
        seedrandom("dimsUniqueMutations")
      );
      candidateMutations[index].fn();
      expect(validator.validate(candidate)).toBeTrue();
    }
  });

  it("dimsUnique: mutators preserve uniqueness for nested arrays", () => {
    const spec = new ArgDef(
      "settings",
      0,
      ArgTag.OBJECT,
      {
        ...argOptions,
        dimsUnique: true,
        dimLength: [{ min: 2, max: 2 }],
      },
      0,
      false,
      undefined,
      [
        new ArgDef(
          "values",
          0,
          ArgTag.NUMBER,
          {
            ...argOptions,
            dimsUnique: true,
            dimLength: [{ min: 2, max: 2 }],
          },
          1
        ),
      ]
    );
    const input = [
      { tag: "ArgValueTypeWrapped" as const, value: { values: [1, 2] } },
    ];
    const validator = new ArgDefValidator([spec]);
    const mutations = ArgDefMutator.getMutators(
      [spec],
      input,
      seedrandom("nestedDimsUniqueMutations")
    );

    expect(mutations.length).toBeGreaterThan(0);
    for (let index = 0; index < mutations.length; index++) {
      // Mutator functions may run only once per set, so rebuild the same
      // proposal set for a fresh candidate before testing each mutation.
      const candidate = JSONN.parse<typeof input>(JSONN.stringify(input));
      const candidateMutations = ArgDefMutator.getMutators(
        [spec],
        candidate,
        seedrandom("nestedDimsUniqueMutations")
      );
      candidateMutations[index].fn();
      expect(validator.validate(candidate)).toBeTrue();
    }
  });

  it("mutates optional tuple members to undefined", () => {
    const spec = makeArgDef(
      dummyModule,
      "tuple",
      0,
      ArgTag.TUPLE,
      argOptions,
      0,
      false,
      [
        makeTypeRef(dummyModule, "required", ArgTag.NUMBER, 0),
        makeTypeRef(
          dummyModule,
          "optional",
          ArgTag.LITERAL,
          0,
          true,
          [],
          undefined,
          1
        ),
      ]
    );
    const input = [{ tag: "ArgValueTypeWrapped" as const, value: [1, 1] }];
    const mutator = ArgDefMutator.getMutators(
      [spec],
      input,
      seedrandom("optionalTuple")
    ).find((candidate) => candidate.name === "optional-delete");

    expect(mutator).toBeDefined();
    mutator?.fn();
    expect(input[0].value[1]).toBeUndefined();
    expect(new ArgDefValidator([spec]).validate(input)).toBeTrue();
  });

  it("mutates regex strings", () => {
    const spec = makeArgDef(
      dummyModule,
      "identifier",
      0,
      ArgTag.STRING,
      { ...argOptions, strRegex: "\\A[a-z]{2}\\Z" },
      0
    );
    const input = [{ tag: "ArgValueTypeWrapped" as const, value: "zz" }];
    const mutations = ArgDefMutator.getMutators(
      [spec],
      input,
      seedrandom("regex-regenerate")
    );

    expect(mutations.map((mutation) => mutation.name)).toEqual([
      "regex-regenerate",
    ]);
    mutations[0].fn();
    expect(input[0].value).not.toEqual("zz");
    expect(new ArgDefValidator([spec]).validate(input)).toBeTrue();
  });

  /**
   * This test generates random ArgDef specs, generates
   * and mutates inputs from those specs, and validates
   * the resulting inputs against the original spec.
   */
  it("fuzz test gen/mutate/validate loop", function () {
    const prng = seedrandom("qwertyuiop");
    const stats: {
      gens: { valid: number; invalid: number };
      muts: { valid: number; invalid: number; dupe: number };
      specsWithErrors: {
        [k: string]: { [k: string]: number };
      };
    } = {
      gens: { valid: 0, invalid: 0 },
      muts: { valid: 0, invalid: 0, dupe: 0 },
      specsWithErrors: {},
    };
    const failingSpecs: string[] = [];
    const failingMutators: { [k: string]: number } = {};
    const dupeMutators: { [k: string]: number } = {};
    let uniqueDimensionSpecs = 0;
    let regexStringSpecs = 0;
    let i = 100;
    while (i--) {
      const spec = [getRandomArgDef(prng, Math.floor(prng() * 2))];
      if (spec[0].getDim() > 0 && spec[0].getOptions().dimsUnique) {
        uniqueDimensionSpecs++;
      }
      regexStringSpecs += [spec[0], ...spec[0].getChildrenFlat()].filter(
        (argument) => argument.getOptions().strRegex !== undefined
      ).length;
      const stxt = abbrSpec(spec[0]).join("\r\n");
      const gen = new ArgDefGenerator(spec, prng);
      const val = new ArgDefValidator(spec);

      let j = 100;
      while (j--) {
        let input = gen.next();
        const isValid = val.validate(input);
        if (!isValid) {
          const itxt = JSONN.stringify(input[0]);
          stats.gens.invalid++;
          stats.specsWithErrors[stxt] = stats.specsWithErrors[stxt] ?? {};
          stats.specsWithErrors[stxt][itxt] =
            (stats.specsWithErrors[stxt][itxt] ?? 0) + 1;
          failingSpecs.push(stxt);
          console.debug(`Generated invalid input for spec:`);
          console.debug(`  Invalid input: ${itxt}`);
          console.debug(`  Spec         : ${stxt}`);
        } else {
          stats.gens.valid++;

          let k = 100;
          while (k--) {
            const inputStringBefore = JSONN.stringify(input);
            const muts = ArgDefMutator.getMutators(spec, input, prng);
            if (muts.length) {
              const index = Math.floor(prng() * muts.length);
              const mut = muts[index];
              mut.fn(); // mutate the input
              const inputStringAfter = JSONN.stringify(input);
              if (inputStringBefore === inputStringAfter) {
                stats.muts.dupe++;
                dupeMutators[mut.name] = (failingMutators[mut.name] ?? 0) + 1;
              }
              const isValid = val.validate(input);
              if (!isValid) {
                stats.muts.invalid++;
                failingMutators[mut.name] =
                  (failingMutators[mut.name] ?? 0) + 1;
                console.debug(
                  `Mutator ${mut.name}@[${mut.path}] output failed validation:`
                );
                console.debug(`  Before: ${inputStringBefore}`);
                console.debug(`  After : ${inputStringAfter}`);
                console.debug(`  Spec  : ${stxt}`);

                // Revert to the previous input so that we don't confuse
                // the issue about which mutator broke the input chain
                input = JSONN.parse<typeof input>(inputStringBefore);
              } else {
                stats.muts.valid++;
              }

              if (!k) {
                try {
                  mut.fn();
                  console.error(
                    `Double mutation is expected to fail but didn't`
                  );
                  expect(false).toBeTrue();
                } catch (_e: unknown) {
                  // we expect this to throw an exception
                }
              }
            }
          }
        }
      }
    }

    console.debug(
      `${
        Object.keys(stats.specsWithErrors).length
      } specs generated invalid inputs:`
    );
    const specs: Record<string, number> = {};
    failingSpecs.forEach((e) => (specs[e] = (specs[e] ?? 0) + 1));
    for (const k in specs) {
      console.debug(`${specs[k]}: ${k}`);
    }

    console.debug(
      `${
        Object.keys(failingMutators).length
      } failing mutators: ${JSONN.stringify(failingMutators, null, 3)}`
    );
    console.debug(
      `${Object.keys(dupeMutators).length} dupe mutators: ${JSONN.stringify(
        dupeMutators,
        null,
        3
      )}`
    );

    console.debug(`Stats: ${JSONN.stringify(stats, null, 3)}`);

    expect(stats.gens.valid).not.toBe(0);
    expect(stats.gens.invalid).toBe(0);
    expect(uniqueDimensionSpecs).not.toBe(0);
    expect(regexStringSpecs).not.toBe(0);

    expect(stats.muts.valid).not.toBe(0);
    expect(stats.muts.dupe).toBe(0);
    expect(stats.muts.invalid).toBe(0);
  });
});

// Helper function to abbreviate ArgDef specs
function abbrSpec(spec: ArgDef, indents = 0): string[] {
  const space = "  ".repeat(indents);
  const line: string[] = [];
  line.push(space);
  line.push(`${spec.getName()}:${TypescriptProgram.getTypeAnnotation(spec)}`);
  line.push(`dims: ${JSONN.stringify(spec.getOptions().dimLength)}`);
  if (spec.getOptions().dimsUnique) line.push(`DIMS_UNIQUE`);
  if (spec.getOptions().strRegex) line.push(`STR_REGEX`);
  if (spec.isNoInput()) line.push(`NOINPUT`);
  if (spec.isOptional()) line.push(`OPTIONAL`);
  if (spec.getType() === ArgTag.NUMBER && spec.getOptions().numInteger)
    line.push(`INTEGER`);
  if (
    spec.getType() === ArgTag.NUMBER ||
    spec.getType() === ArgTag.BOOLEAN ||
    spec.getType() === ArgTag.LITERAL
  )
    line.push(`range: ${JSONN.stringify(spec.getIntervals())}`);

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
): ArgDef {
  const argTagOptions: ArgTag[] = [
    ArgTag.NUMBER,
    ArgTag.STRING,
    ArgTag.BOOLEAN,
    ArgTag.OBJECT,
    ArgTag.LITERAL,
    ArgTag.UNION,
  ];
  const argTag = argTagOptions[Math.floor(prng() * (argTagOptions.length - 1))];

  const children: ArgDef[] = [];
  if (levels && (argTag === ArgTag.OBJECT || argTag === ArgTag.UNION)) {
    let childCount = 2;
    while (childCount) {
      const child = getRandomArgDef(prng, levels - 1, argTag);
      // Children need to have unique names. If by random chance we
      // have a collision, just try again
      if (children.every((e) => e.getName() !== child.getName())) {
        children.push(child);
        childCount--;
      }
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
  const isOptional =
    (parentType === ArgTag.OBJECT || parentType === undefined) && prng() > 0.5;
  const name = "abcdefghijklmnopqrstuvwxyz".split("")[Math.floor(prng() * 25)];
  let options: ArgOptions = {
    ...argOptions,
    dimsUnique: dims.dims > 0 && prng() > 0.5,
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
      // interval; TODO: string min/max ranges
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
        ][Math.floor(prng() * 2)],
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
    case ArgTag.OBJECT: {
      break;
    }
    case ArgTag.DICTIONARY: {
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
    case ArgTag.TUPLE: {
      break;
    }
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
