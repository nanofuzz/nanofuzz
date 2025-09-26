import { ArgDef } from "./ArgDef";
import { ArgDefGenerator } from "./ArgDefGenerator";
import { ArgDefValidator } from "./ArgDefValidator";
import { ArgTag, ArgType, ArgValueType } from "./Types";
import * as JSON5 from "json5";

// !!!!!!
export class ArgDefMutator {
  // !!!!!!
  // mutators only work once
  public static getMutators(
    specs: ArgDef<ArgType>[],
    input: ArgValueType[],
    prng: seedrandom.prng
  ): mutatorFn[] {
    // Sanity check: ensure we have specs to cover our inputs
    if (ArgDef.length < input.length) {
      throw new Error(
        `Different number of inputs (${input.length}) relative to ArgDefs (${
          ArgDef.length
        }) for input: ${JSON5.stringify(input)}`
      );
    }

    // !!!!!!
    const mutations: {
      name: string;
      value: ArgValueType;
      path: (string | number)[];
    }[] = [];

    // !!!!!!
    const mutateArray = (
      a: Array<ArgValueType>,
      path: (string | number)[],
      spec: ArgDef<ArgType>,
      level = 1
    ): void => {
      const options = spec.getOptions();
      mutations.push(
        ...[
          {
            name: "array-jumble",
            value: [...a].sort(() => 0.5 - prng()),
            path: [...path],
          },
          {
            name: "array-reverse",
            value: [...a].reverse(),
            path: [...path],
          },
          {
            name: "array-appendNewElement",
            value: [
              ...a,
              ArgDefGenerator.gen(spec, prng, false /* w/o dimensions */),
            ],
            path: [...path],
          },
        ].filter(
          (e) =>
            JSON5.stringify(e.value) !== JSON5.stringify(a) &&
            options.dimLength[level - 1].max >= e.value.length &&
            options.dimLength[level - 1].min <= e.value.length
        )
      );

      // !!!!!!
      for (const i in a) {
        mutations.push(
          ...[
            {
              name: `array-deleteElement${i}`,
              value: [...a.filter((v, j) => Number(i) !== j)],
              path: [...path],
            },
          ].filter(
            (e) =>
              options.dimLength[level - 1].max >= e.value.length &&
              options.dimLength[level - 1].min <= e.value.length
          )
        );

        if (Array.isArray(a[i]) && level < spec.getDim()) {
          mutateArray(a[i], [...path, Number(i)], spec, level + 1);
        } else {
          subInputs.push({
            subPath: [...path, Number(i)],
            subElement: a[i],
            subSpec: spec,
            inArray: true,
          });
        }
      }
    };

    // Create a subinput for each input
    const subInputs: {
      subPath: (number | string)[];
      subElement: ArgValueType;
      subSpec: ArgDef<ArgType>;
      inArray: boolean;
    }[] = input.map((e, i) => {
      return {
        subPath: [Number(i)],
        subElement: e,
        subSpec: specs[i],
        inArray: false,
      };
    });

    // Process each subinput
    for (let i = 0; i < subInputs.length; i++) {
      const subInput = subInputs[i];
      const spec = subInput.subSpec;
      const options = spec.getOptions();

      // Handle array dimensions
      if (spec.getDim() && !subInput.inArray) {
        if (Array.isArray(subInput.subElement)) {
          mutateArray(subInput.subElement, [...subInput.subPath], spec);
        }
      } else if (!spec.isNoInput()) {
        // Determine mutations according to ArgDef types
        switch (spec.getType()) {
          case ArgTag.NUMBER: {
            const value = Number(subInput.subElement);
            mutations.push(
              ...[
                {
                  name: "number-plusOne",
                  value: value + 1,
                  path: [...subInput.subPath],
                },
                {
                  name: "number-minusOne",
                  value: value - 1,
                  path: [...subInput.subPath],
                },
                {
                  name: "number-negate",
                  value: value * -1,
                  path: [...subInput.subPath],
                },
                {
                  name: "number-timesTwo",
                  value: value * 2,
                  path: [...subInput.subPath],
                },
                {
                  name: "number-timesThree",
                  value: value * 3,
                  path: [...subInput.subPath],
                },
                {
                  name: "number-divTwo",
                  value: options.numInteger ? Math.round(value / 2) : value / 2,
                  path: [...subInput.subPath],
                },
                {
                  name: "number-divThree",
                  value: options.numInteger ? Math.round(value / 3) : value / 3,
                  path: [...subInput.subPath],
                },
              ].filter(
                (e) =>
                  e.value !== value &&
                  e.value <= Number(spec.getIntervals()[0].max) &&
                  e.value >= Number(spec.getIntervals()[0].min) &&
                  (Number.isInteger(e.value) || !options.numInteger)
              )
            );
            break;
          }
          case ArgTag.STRING: {
            const value = String(subInput.subElement);
            const rPos = Math.floor(prng() * Math.max(0, value.length - 1));
            const charSet = options.strCharset;
            const rChar = charSet[Math.floor(prng() * (charSet.length - 1))];

            mutations.push(
              ...[
                {
                  name: "string-deleteOneChar",
                  value: `${value.slice(0, rPos)}${value.slice(rPos + 1)}`,
                  path: [...subInput.subPath],
                },
                {
                  name: "string-insertOneChar",
                  value: `${value.slice(0, rPos)}${rChar}${value.slice(rPos)}`,
                  path: [...subInput.subPath],
                },
                {
                  name: "string-reverse",
                  value: value.split("").reverse().join(""),
                  path: [...subInput.subPath],
                },
                {
                  name: "string-jumble",
                  value: value
                    .split("")
                    .sort(() => 0.5 - prng())
                    .join(""),
                  path: [...subInput.subPath],
                },
              ].filter(
                (e) =>
                  e.value !== value &&
                  e.value.length <= options.strLength.max &&
                  e.value.length >= options.strLength.min
              )
            );
            break;
          }
          case ArgTag.BOOLEAN: {
            const value = subInput.subElement;
            mutations.push(
              ...[
                {
                  name: "boolean-setTrue",
                  value: true,
                  path: [...subInput.subPath],
                },
                {
                  name: "boolean-setFalse",
                  value: false,
                  path: [...subInput.subPath],
                },
              ].filter(
                (e) =>
                  e.value !== value &&
                  (e.value === Boolean(spec.getIntervals()[0].max) ||
                    e.value === Boolean(spec.getIntervals()[0].min))
              )
            );
            break;
          }
          case ArgTag.OBJECT: {
            const value = subInput.subElement;
            if (typeof value === "object" && !Array.isArray(value)) {
              const children = spec.getChildren().filter((c) => !c.isNoInput());
              for (const c of children) {
                const name = c.getName();

                // Mutator to generate optional member if missing
                if (c.isOptional()) {
                  const oldValue = value[name];
                  if (value[name] === undefined) {
                    mutations.push(
                      ...[
                        {
                          name: `optional-genMember`,
                          value: ArgDefGenerator.gen(c, prng),
                          path: [...subInput.subPath, name],
                        },
                      ].filter(
                        (e) =>
                          JSON5.stringify(e.value) !== JSON5.stringify(oldValue)
                      )
                    );
                  } else {
                    // Mutator to delete optional input
                    mutations.push({
                      name: "optional-delete",
                      value: undefined, // !!!!!!! should delete if parent is object
                      path: [...subInput.subPath, name],
                    });
                  }
                }

                // Mutators for object member value
                subInputs.push({
                  subPath: [...subInput.subPath, name],
                  subElement: value[name],
                  subSpec: c,
                  inArray: false,
                });
              }
            }
            break;
          }
          case ArgTag.LITERAL: {
            // Nothing to do here: literals cannot be mutated
            break;
          }
          case ArgTag.UNION: {
            const value = subInput.subElement;

            // Filter out invalid and noInput specs & select a random valid spec
            // with which to mutate the input value
            const validChildren = spec
              .getChildren()
              .filter(
                (c) => ArgDefValidator.validate(value, c) && !c.isNoInput()
              );
            if (validChildren.length) {
              subInputs.push({
                subPath: [...subInput.subPath],
                subElement: value,
                subSpec:
                  validChildren[Math.floor(prng() * validChildren.length)],
                inArray: false,
              });
            }

            // Create a mutator with a randomly-generated value for a randomly-
            // selected spec that allows inputs
            const inputOkChildren = spec
              .getChildren()
              .filter((c) => !c.isNoInput());
            if (inputOkChildren.length) {
              const newValue = ArgDefGenerator.gen(
                inputOkChildren[Math.floor(prng() * inputOkChildren.length)],
                prng
              );
              mutations.push(
                ...[
                  {
                    name: `union-regenFromSpec`,
                    value: newValue,
                    path: [...subInput.subPath],
                  },
                ].filter(
                  (e) =>
                    JSON5.stringify(e.value) !== JSON5.stringify(value) &&
                    !(e.value === undefined && isNull(value))
                )
              );
            }
            break;
          }
          case ArgTag.UNRESOLVED: {
            throw new Error(
              `Encountered unresolved ArgDef: ${JSON5.stringify(spec)}`
            );
          }
        } // switch: ArgDef type
      } // else: !isNoInput
    } // for: subInputs

    let wasMutated = false;

    // Return the list of mutator functions
    return mutations.map((e) => {
      return {
        name: e.name,
        path: e.path,
        fn: () => {
          if (wasMutated) {
            throw new Error(
              "Input cannot be mutated more than once. Redetermine mutators prior to mutating again."
            );
          } else {
            wasMutated = true;
            return this.mutateInputInPlace(input, e.path, e.value);
          }
        },
      };
    });
  } // !!!!!!

  // !!!!!!
  protected static mutateInputInPlace(
    input: ArgValueType,
    path: (number | string)[],
    newValue: ArgValueType
  ): ArgValueType {
    let element: ArgValueType = input;

    // Follow the path to the value
    for (const step in path) {
      const key = path[step];
      if (Number(step) < path.length - 1) {
        // Walk the path
        if (Array.isArray(element)) {
          element = element[Number(key)];
        } else if (typeof element === "object") {
          element = element[String(key)];
        } else {
          // !!!!!!!! Human-generated inputs might not be conformant...
          throw new Error(
            `Cannot follow path through non-array / non-object. Input: ${JSON5.stringify(
              input
            )}, Element: ${JSON5.stringify(element)}, path: ${JSON5.stringify(
              path
            )} at step: ${step}`
          );
        }
      } else {
        // Mutate the input
        if (Array.isArray(element)) {
          element[Number(key)] = newValue;
        } else if (typeof element === "object") {
          element[String(key)] = newValue;
        } else {
          // !!!!!!!! Human-generated inputs might not be conformant...
          throw new Error(
            `Cannot mutate value through non-array / non-object. Input: ${JSON5.stringify(
              input
            )}, Element: ${JSON5.stringify(element)}, Path: ${JSON5.stringify(
              path
            )} at step: ${step}`
          );
        }
      }
    }
    return input;
  } // !!!!!!
} // !!!!!!

// !!!!!!
export type mutatorFn = {
  name: string;
  path: (string | number)[];
  fn: () => ArgValueType;
};

// !!!!!!
function isNull(value: unknown): boolean {
  return value === null;
} // !!!!!!!
