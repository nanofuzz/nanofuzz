import { ArgDef } from "./ArgDef";
import { ArgDefGenerator } from "./ArgDefGenerator";
import { ArgDefValidator } from "./ArgDefValidator";
import * as RegexStringBuilder from "./RegexStringBuilder";
import { ArgTag, ArgValueType, ArgValueTypeWrapped } from "./Types";
import * as JSONN from "../../Jsonn";
import { isBufferOrUint8Array } from "../../Util";

/**
 * Utilities for mutating values described by an ArgDef spec
 */
export class ArgDefMutator {
  /**
   * Returns a list of mutator functions for the provided value and
   * ArgDef spec. To mutate the value, call one of the returned
   * mutator functions.
   *
   * Note: A maximum of one mutation execution is allowed for each
   * set of returned mutator functions. Trying to call more than one
   * mutator function will raise an exception.
   *
   * @param `specs` ArgDef that describes the value to mutate
   * @param `value`` Value to mutate
   * @param `prng`` random number generator
   * @returns array of mutator functions
   */
  public static getMutators(
    specs: ArgDef[],
    value: ArgValueTypeWrapped[],
    prng: seedrandom.prng
  ): mutatorFn[] {
    // Sanity check: ensure we have specs to cover our inputs
    if (ArgDef.length < value.length) {
      throw new Error(
        `Different number of inputs (${value.length}) relative to ArgDefs (${
          ArgDef.length
        }) for input: ${JSONN.stringify(value)}`
      );
    }

    // Running list of mutator functions
    type MutationProposal = {
      name: string;
      value: ArgValueType;
      path: (string | number)[];
      deleteProperty?: boolean;
      objectKeyOrder?: string[];
    };
    const mutations: MutationProposal[] = [];
    type UniqueDimensionContext = {
      siblings: ArgValueType[];
      index: number;
      pathFromOuter: (string | number)[];
    };
    const mutationContexts = new Map<
      string,
      {
        uniqueContexts: UniqueDimensionContext[];
        requiresUniqueElements: boolean;
      }
    >();

    // Clones one unique-array element and applies a descendant replacement
    // relative to it, leaving the original input untouched for comparison.
    function replaceInOuterElement(
      outerElement: ArgValueType,
      path: (string | number)[],
      replacement: ArgValueType,
      deleteProperty = false,
      objectKeyOrder?: string[]
    ): ArgValueType {
      if (!path.length) return replacement;
      const clone = structuredClone(outerElement);
      const wrappedClone = [
        { tag: "ArgValueTypeWrapped" as const, value: clone },
      ];
      if (deleteProperty) {
        ArgDefMutator._deleteObjectPropertyInPlace(wrappedClone, [
          0,
          "value",
          ...path,
        ]);
      } else {
        ArgDefMutator._mutateValueInPlace(
          wrappedClone,
          [0, "value", ...path],
          replacement
        );
        if (objectKeyOrder) {
          ArgDefMutator._orderObjectPropertiesInPlace(
            wrappedClone,
            [0, "value", ...path],
            objectKeyOrder
          );
        }
      }
      return clone;
    }

    // Reject proposals that duplicate an element in this or any enclosing
    // dimsUnique array tracked while descending through mutateArray.
    function preservesUniqueDimensions(mutation: MutationProposal): boolean {
      const context = mutationContexts.get(JSONN.stringify(mutation.path));
      if (!context) return true;

      if (context.requiresUniqueElements) {
        if (!Array.isArray(mutation.value)) return false;
        const serializedValues = mutation.value.map((element) =>
          JSONN.stringify(element)
        );
        if (new Set(serializedValues).size !== serializedValues.length) {
          return false;
        }
      }

      return context.uniqueContexts.every((uniqueContext) => {
        const outerElement = replaceInOuterElement(
          uniqueContext.siblings[uniqueContext.index],
          uniqueContext.pathFromOuter,
          mutation.value,
          mutation.deleteProperty,
          mutation.objectKeyOrder
        );
        const serializedOuterElement = JSONN.stringify(outerElement);
        return !uniqueContext.siblings.some(
          (sibling, index) =>
            index !== uniqueContext.index &&
            JSONN.stringify(sibling) === serializedOuterElement
        );
      });
    }

    function addMutations(proposedMutations: MutationProposal[]): void {
      mutations.push(...proposedMutations.filter(preservesUniqueDimensions));
    }

    // Utility function that determines mutators appropriate
    // for a given array of values and ArgDef spec.
    const mutateArray = (
      a: Array<ArgValueType>,
      path: (string | number)[],
      spec: ArgDef,
      level = 1,
      uniqueContexts: UniqueDimensionContext[] = []
    ): void => {
      const options = spec.getOptions();
      mutationContexts.set(JSONN.stringify(path), {
        uniqueContexts,
        requiresUniqueElements: level === 1 && options.dimsUnique,
      });

      // Re-arrange elements if multiple elements are present
      if (a.length > 1) {
        addMutations(
          [
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
          ].filter((e) => JSONN.stringify(e.value) !== JSONN.stringify(a))
        );
      } // if: array length > 1

      // Add elements if the dimension is not yet full
      if (options.dimLength[level - 1].max > a.length) {
        // Append new non-array element on the terminal dimension
        // when that terminal dimension is not full
        if (level === spec.getDim()) {
          // terminal dimension: add a value
          addMutations(
            [
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
                JSONN.stringify(e.value) !== JSONN.stringify(a) &&
                options.dimLength[level - 1].max >= e.value.length &&
                options.dimLength[level - 1].min <= e.value.length
            ) // filter
          ); // push
        }
        // TODO: non-terminal dimension: generate a dimensional element
      } // if: dimension is not yet full

      // Process each element in this level of the array
      for (const i in a) {
        const index = Number(i);
        const childUniqueContexts = uniqueContexts.map((context) => ({
          ...context,
          pathFromOuter: [...context.pathFromOuter, index],
        }));
        if (level === 1 && options.dimsUnique) {
          childUniqueContexts.push({
            siblings: a,
            index,
            pathFromOuter: [],
          });
        }
        addMutations(
          [
            {
              name: `array-deleteElement${i}`,
              value: [...a.filter((_v, j) => index !== j)],
              path: [...path],
            },
          ].filter(
            (e) =>
              options.dimLength[level - 1].max >= e.value.length &&
              options.dimLength[level - 1].min <= e.value.length
          )
        );

        if (Array.isArray(a[i]) && level < spec.getDim()) {
          mutateArray(
            a[i],
            [...path, index],
            spec,
            level + 1,
            childUniqueContexts
          );
        } else {
          subInputs.push({
            subPath: [...path, Number(i)],
            subElement: a[i],
            subSpec: spec,
            inArray: true,
            uniqueContexts: childUniqueContexts,
          });
        }
      }
    }; // fn: mutateArray

    // Create a subinput for each input
    const subInputs: {
      subPath: (number | string)[];
      subElement: ArgValueType;
      subSpec: ArgDef;
      inArray: boolean;
      uniqueContexts: UniqueDimensionContext[];
    }[] = value.map((e, i) => {
      return {
        subPath: [Number(i), "value"],
        subElement: e.value,
        subSpec: specs[i],
        inArray: false,
        uniqueContexts: [],
      };
    }); // fn: subInputs

    // Process each subinput
    for (let i = 0; i < subInputs.length; i++) {
      const subInput = subInputs[i];
      const spec = subInput.subSpec;
      const options = spec.getOptions();
      mutationContexts.set(JSONN.stringify(subInput.subPath), {
        uniqueContexts: subInput.uniqueContexts,
        requiresUniqueElements: false,
      });

      // Handle array dimensions
      if (spec.getDim() && !subInput.inArray) {
        if (Array.isArray(subInput.subElement)) {
          mutateArray(
            subInput.subElement,
            [...subInput.subPath],
            spec,
            1,
            subInput.uniqueContexts
          );
        }
      } else if (!spec.isNoInput()) {
        // Determine mutations according to ArgDef types
        switch (spec.getType()) {
          case ArgTag.BIGINT: {
            const value = subInput.subElement;
            if (typeof value !== "bigint") {
              throw new Error(
                `Expected bigint input, got ${JSONN.stringify(value)}`
              );
            }
            const interval = spec.getIntervals()[0];
            if (
              typeof interval.min !== "bigint" ||
              typeof interval.max !== "bigint"
            ) {
              throw new Error(
                `Invalid interval bounds for bigint type: ${JSONN.stringify(
                  interval
                )}`
              );
            }
            const max = interval.max;
            const min = interval.min;
            mutations.push(
              ...[
                {
                  name: "bigint-plusOne",
                  value: value + BigInt(1),
                  path: [...subInput.subPath],
                },
                {
                  name: "bigint-minusOne",
                  value: value - BigInt(1),
                  path: [...subInput.subPath],
                },
                {
                  name: "bigint-negate",
                  value: value * BigInt(-1),
                  path: [...subInput.subPath],
                },
                {
                  name: "bigint-timesTwo",
                  value: value * BigInt(2),
                  path: [...subInput.subPath],
                },
                {
                  name: "bigint-timesThree",
                  value: value * BigInt(3),
                  path: [...subInput.subPath],
                },
                {
                  name: "bigint-divTwo",
                  value: value / BigInt(2),
                  path: [...subInput.subPath],
                },
                {
                  name: "bigint-divThree",
                  value: value / BigInt(3),
                  path: [...subInput.subPath],
                },
              ].filter(
                (e) => e.value !== value && e.value <= max && e.value >= min
              )
            );
            break;
          }
          case ArgTag.NUMBER: {
            const value = Number(subInput.subElement);
            addMutations(
              [
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
            if (options.strRegex !== undefined) {
              const regenerated = RegexStringBuilder.create(
                options.strRegex,
                prng,
                options
              )();
              addMutations(
                [
                  {
                    name: "regex-regenerate",
                    value: regenerated,
                    path: [...subInput.subPath],
                  },
                ].filter(
                  (proposal) =>
                    proposal.value !== value &&
                    proposal.value.length <= options.strLength.max &&
                    proposal.value.length >= options.strLength.min &&
                    proposal.value
                      .split("")
                      .every((char) => options.strCharset.includes(char))
                )
              );
              break;
            }
            const rPos = Math.floor(prng() * Math.max(0, value.length - 1));
            const charSet = options.strCharset;
            const rChar = charSet[Math.floor(prng() * (charSet.length - 1))];

            addMutations(
              [
                {
                  name: "string-deleteOneChar",
                  value: `${value.slice(0, rPos)}${value.slice(rPos + 1)}`,
                  path: [...subInput.subPath],
                },
                {
                  name: "string-replaceOneChar",
                  value: `${value.slice(0, rPos)}${rChar}${value.slice(
                    rPos + 1
                  )}`,
                  path: [...subInput.subPath],
                },
                {
                  name: "string-insertOneChar",
                  value: `${value.slice(0, rPos)}${rChar}${value.slice(rPos)}`,
                  path: [...subInput.subPath],
                },
                /*
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
                */
              ].filter(
                (e) =>
                  e.value !== value &&
                  e.value.length <= options.strLength.max &&
                  e.value.length >= options.strLength.min
              )
            );
            break;
          }
          case ArgTag.BYTES: {
            const subElem = subInput.subElement;
            const rawBytes: number[] = isBufferOrUint8Array(subElem)
              ? Array.from(subElem)
              : Array.isArray(subElem)
                ? subElem.filter((e): e is number => typeof e === "number")
                : [];
            const rPos = Math.floor(prng() * Math.max(0, rawBytes.length - 1));
            const rByte = Math.floor(prng() * 256);
            const rBit = Math.floor(prng() * 8);

            const proposals: {
              name: string;
              value: Uint8Array;
              path: (string | number)[];
            }[] = [];

            if (rawBytes.length > 0) {
              const bitFlipped = new Uint8Array(rawBytes);
              bitFlipped[rPos] ^= 1 << rBit;
              proposals.push({
                name: "bytes-flipBit",
                value: bitFlipped,
                path: [...subInput.subPath],
              });

              const byteInc = new Uint8Array(rawBytes);
              byteInc[rPos] = (byteInc[rPos] + 1) % 256;
              proposals.push({
                name: "bytes-incByte",
                value: byteInc,
                path: [...subInput.subPath],
              });

              const deleted = new Uint8Array(
                rawBytes.filter((_, idx) => idx !== rPos)
              );
              proposals.push({
                name: "bytes-deleteOneByte",
                value: deleted,
                path: [...subInput.subPath],
              });
            }

            if (rawBytes.length < options.byteLength.max) {
              const inserted = new Uint8Array(rawBytes.length + 1);
              inserted.set(rawBytes.slice(0, rPos));
              inserted[rPos] = rByte;
              inserted.set(rawBytes.slice(rPos), rPos + 1);
              proposals.push({
                name: "bytes-insertOneByte",
                value: inserted,
                path: [...subInput.subPath],
              });
            }

            addMutations(
              proposals.filter(
                (e) =>
                  e.value.length <= options.byteLength.max &&
                  e.value.length >= options.byteLength.min
              )
            );
            break;
          }
          case ArgTag.BOOLEAN: {
            const value = subInput.subElement;
            addMutations(
              [
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
            if (
              typeof value === "object" &&
              !Array.isArray(value) &&
              !(value instanceof Uint8Array) &&
              value !== null
            ) {
              const children = spec.getChildren().filter((c) => !c.isNoInput());
              for (const c of children) {
                const name = c.getName();
                const childPath = [...subInput.subPath, name];
                const childKeyOrder = children.map((child) => child.getName());
                const childUniqueContexts = subInput.uniqueContexts.map(
                  (context) => ({
                    ...context,
                    pathFromOuter: [...context.pathFromOuter, name],
                  })
                );
                mutationContexts.set(JSONN.stringify(childPath), {
                  uniqueContexts: childUniqueContexts,
                  requiresUniqueElements: false,
                });

                // Mutator to generate optional member if missing
                if (c.isOptional()) {
                  const oldValue = value[name];
                  if (value[name] === undefined) {
                    addMutations(
                      [
                        {
                          name: `optional-genMember`,
                          value: ArgDefGenerator.gen(c, prng, true, false),
                          path: childPath,
                          objectKeyOrder: childKeyOrder,
                        },
                      ].filter(
                        (e) =>
                          JSONN.stringify(e.value) !== JSONN.stringify(oldValue)
                      )
                    );
                  } else {
                    // Mutator to delete optional input
                    addMutations([
                      {
                        name: "optional-delete",
                        value: undefined,
                        path: childPath,
                        deleteProperty: true,
                      },
                    ]);
                  }
                }

                // Mutators for object member value
                subInputs.push({
                  subPath: childPath,
                  subElement: value[name],
                  subSpec: c,
                  inArray: false,
                  uniqueContexts: childUniqueContexts,
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
                uniqueContexts: subInput.uniqueContexts,
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
              addMutations(
                [
                  {
                    name: `union-regenFromSpec`,
                    value: newValue,
                    path: [...subInput.subPath],
                  },
                ].filter(
                  (e) =>
                    JSONN.stringify(e.value) !== JSONN.stringify(value) &&
                    !(e.value === undefined && this.isNull(value))
                )
              );
            }
            break;
          }

          case ArgTag.TUPLE: {
            const value = subInput.subElement;
            if (Array.isArray(value)) {
              const children = spec.getChildren().filter((c) => !c.isNoInput());
              for (const [i, c] of children.entries()) {
                const childPath = [...subInput.subPath, i];
                const childUniqueContexts = subInput.uniqueContexts.map(
                  (context) => ({
                    ...context,
                    pathFromOuter: [...context.pathFromOuter, i],
                  })
                );
                mutationContexts.set(JSONN.stringify(childPath), {
                  uniqueContexts: childUniqueContexts,
                  requiresUniqueElements: false,
                });

                // Mutator to generate optional member if missing
                if (c.isOptional()) {
                  const oldValue = value[i];
                  if (value[i] === undefined) {
                    addMutations(
                      [
                        {
                          name: `optional-genMember`,
                          value: ArgDefGenerator.gen(c, prng, true, false),
                          path: childPath,
                        },
                      ].filter(
                        (e) =>
                          JSONN.stringify(e.value) !== JSONN.stringify(oldValue)
                      )
                    );
                  } else {
                    // Mutator to delete optional input
                    addMutations([
                      {
                        name: "optional-delete",
                        value: undefined,
                        path: [...subInput.subPath, i],
                      },
                    ]);
                  }
                }

                // Mutators for tuple member value
                subInputs.push({
                  subPath: childPath,
                  subElement: value[i],
                  subSpec: c,
                  inArray: false,
                  uniqueContexts: childUniqueContexts,
                });
              }
            }
            break;
          }

          case ArgTag.UNRESOLVED: {
            throw new Error(
              `Encountered unresolved ArgDef: ${JSONN.stringify(spec)}`
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
            if (e.deleteProperty) {
              return this._deleteObjectPropertyInPlace(value, e.path);
            }
            const result = this._mutateValueInPlace(value, e.path, e.value);
            if (e.objectKeyOrder) {
              this._orderObjectPropertiesInPlace(
                value,
                e.path,
                e.objectKeyOrder
              );
            }
            return result;
          }
        },
      };
    });
  } // fn: getMutators

  /**
   * Mutates a value **in place** by following a path to the
   * appropriate value node and applying the new value.
   *
   * @param `value` the value to mutate in place
   * @param `path`` path to the value node to mutate
   * @param `newValue` the new value
   * @returns the mutated input value
   */
  protected static _mutateValueInPlace(
    value: ArgValueTypeWrapped[],
    path: (number | string)[],
    newValue: ArgValueType
  ): ArgValueType {
    let element: ArgValueType = value;

    // Follow the path to the value
    for (const step in path) {
      const key = path[step];
      if (Number(step) < path.length - 1) {
        // Walk the path
        if (Array.isArray(element)) {
          element = element[Number(key)];
        } else if (
          typeof element === "object" &&
          !Array.isArray(element) &&
          !(element instanceof Uint8Array) &&
          element !== null
        ) {
          element = element[String(key)];
        } else {
          throw new Error(
            `Cannot follow path through non-array / non-object. Input: ${JSONN.stringify(
              value
            )}, Element: ${JSONN.stringify(element)}, path: ${JSONN.stringify(
              path
            )} at step: ${step}`
          );
        }
      } else {
        // Mutate the input
        if (Array.isArray(element)) {
          element[Number(key)] = newValue;
        } else if (
          typeof element === "object" &&
          !Array.isArray(element) &&
          !(element instanceof Uint8Array) &&
          element !== null
        ) {
          element[String(key)] = newValue;
        } else {
          throw new Error(
            `Cannot mutate value through non-array / non-object. Input: ${JSONN.stringify(
              value
            )}, Element: ${JSONN.stringify(element)}, Path: ${JSONN.stringify(
              path
            )} at step: ${step}`
          );
        }
      }
    }
    return value;
  } // fn: mutateValueInPlace

  /**
   * Removes an object member in place by following a path to its parent.
   *
   * @param `value` input value containing the object member to delete
   * @param `path` path to the object member
   * @returns the mutated input value
   */
  protected static _deleteObjectPropertyInPlace(
    value: ArgValueTypeWrapped[],
    path: (number | string)[]
  ): ArgValueType {
    let element: ArgValueType = value;

    for (const step in path) {
      const key = path[step];
      if (Number(step) < path.length - 1) {
        if (Array.isArray(element)) {
          element = element[Number(key)];
        } else if (
          element !== null &&
          typeof element === "object" &&
          !Array.isArray(element) &&
          !(element instanceof Uint8Array)
        ) {
          element = element[String(key)];
        } else {
          throw new Error(
            `Cannot follow path through non-array / non-object: ${JSONN.stringify(path)}`
          );
        }
      } else if (
        element !== null &&
        typeof element === "object" &&
        !Array.isArray(element) &&
        !(element instanceof Uint8Array)
      ) {
        delete element[String(key)];
      } else {
        throw new Error(
          `Cannot delete a non-object member: ${JSONN.stringify(path)}`
        );
      }
    }
    return value;
  } // fn: deleteObjectPropertyInPlace

  /** Reorders an object's existing keys to match the defining ArgDef order. */
  protected static _orderObjectPropertiesInPlace(
    value: ArgValueTypeWrapped[],
    path: (number | string)[],
    keyOrder: string[]
  ): void {
    let parent: ArgValueType = value;
    for (const step in path.slice(0, -1)) {
      const key = path[Number(step)];
      if (Array.isArray(parent)) {
        parent = parent[Number(key)];
      } else if (
        parent !== null &&
        typeof parent === "object" &&
        !Array.isArray(parent) &&
        !(parent instanceof Uint8Array)
      ) {
        parent = parent[String(key)];
      } else {
        throw new Error(
          `Cannot order object properties: ${JSONN.stringify(path)}`
        );
      }
    }
    if (
      parent === null ||
      typeof parent !== "object" ||
      Array.isArray(parent) ||
      parent instanceof Uint8Array
    ) {
      throw new Error(
        `Cannot order non-object properties: ${JSONN.stringify(path)}`
      );
    }

    const values = new Map(
      Object.entries(parent).map(([key, propertyValue]) => [key, propertyValue])
    );
    for (const key of Object.keys(parent)) delete parent[key];
    for (const key of keyOrder) {
      if (values.has(key)) parent[key] = values.get(key);
    }
    for (const [key, propertyValue] of values) {
      if (!(key in parent)) parent[key] = propertyValue;
    }
  } // fn: orderObjectPropertiesInPlace

  /**
   * Checks for `null` without raising type warnings.
   *
   * @param `value` value to check for null
   * @returns true if null, false otherwise
   */
  public static isNull(value: unknown): boolean {
    return value === null;
  } // fn: isNull
} // class: ArgDefMutator

/**
 * Type describing mutator functions
 */
export type mutatorFn = {
  name: string; // mutator function name
  path: (string | number)[]; // path to value node to mutate
  fn: () => ArgValueType; // mutator function
};
