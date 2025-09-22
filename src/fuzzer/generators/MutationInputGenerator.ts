import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { ArgDef } from "../analysis/typescript/ArgDef";
import { ArgTag, ArgType, ArgValueType } from "../analysis/typescript/Types";
import { Leaderboard } from "./Leaderboard";
import { InputAndSource } from "./Types";
import * as JSON5 from "json5";

// !!!!!!
export class MutationInputGenerator extends AbstractInputGenerator {
  private _leaderboard; // !!!!!!
  private _isAvailable = false; // !!!!!!
  private _maxMutations = 3; // !!!!!!

  // !!!!!!
  public constructor(
    argDefs: ArgDef<ArgType>[],
    rngSeed: string,
    leaderboard: Leaderboard<InputAndSource>
  ) {
    super(argDefs, rngSeed);
    this._leaderboard = leaderboard;
  } // !!!!!!

  // !!!!!!
  // Only available when "interesting" inputs are available to mutate.
  public isAvailable(): boolean {
    if (!this._isAvailable && this._leaderboard.getLeaders().length) {
      // !!!!!!!! performance: we just need the count
      this._isAvailable = true;
    }
    return this._isAvailable;
  } // !!!!!!

  // !!!!!!
  public next(): { input: ArgValueType[]; source: string } {
    // Get the set of interesting inputs & select one
    const leaders = this._leaderboard.getLeaders();
    const i = Math.floor(this._prng() * leaders.length);
    const input = leaders[i].leader.input;

    // randomly choose number of mutations
    let n = Math.floor(this._prng() * this._maxMutations) + 1;
    while (n-- > 0) {
      const mutators: mutatorFn[] = [];
      const originalInput = JSON5.parse(JSON5.stringify(input));

      // calculate possible mutations for the input values
      mutators.push(...this._getMutators(this._argDefs, input));
      console.debug(
        `[${this.name}] ${mutators.length} mutators for input ${JSON5.stringify(
          input
        )}: ${mutators
          .map((e) => `${e.name}@${JSON5.stringify(e.path)}`)
          .join(", ")}`
      ); // !!!!!!!

      // !!!!!! some kind of error here? seems pointless to return a duplicate input....?
      if (!mutators.length) {
        return { input, source: this.name };
      }

      // randomly select & execute a mutation strategy
      const m = Math.floor(this._prng() * mutators.length);
      mutators[m].fn();

      console.debug(
        `[${this.name}] - Applied: ${mutators[m].name}@${JSON5.stringify(
          mutators[m].path
        )} to: ${JSON5.stringify(originalInput)} result: ${JSON5.stringify(
          input
        )}`
      ); // !!!!!!
    }

    // return the mutated input
    return { input, source: this.name };
  } // !!!!!!

  // !!!!!!
  protected _getMutators(
    specs: ArgDef<ArgType>[],
    input: ArgValueType[]
  ): mutatorFn[] {
    // Sanity check to ensure we have specs to cover our inputs
    if (ArgDef.length < input.length) {
      throw new Error(
        `Different number of inputs (${input.length}) relative to ArgDefs (${
          ArgDef.length
        }) for input: ${JSON5.stringify(input)}`
      );
    }
    const mutations: {
      name: string;
      value: ArgValueType;
      path: (string | number)[];
    }[] = [];

    // !!!!!!
    const traverse = (
      a: Array<ArgValueType>,
      path: (string | number)[],
      spec: ArgDef<ArgType>,
      maxLevels: number
    ): void => {
      for (const i in a) {
        if (Array.isArray(a[i]) && maxLevels) {
          traverse(a[i], [...path, Number(i)], spec, maxLevels - 1);
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
          traverse(
            subInput.subElement,
            [...subInput.subPath],
            spec,
            spec.getDim()
          );
          // !!!!!!!! Also need to delete, add, reverse, jumble elements & increase, reduce dimensions
          // !!!!!!!! including for literals (see test: testArrowVoidLiteralArgs)
        }
      } else if (!spec.isNoInput()) {
        // Determine mutations for optional fields
        if (spec.isOptional()) {
          if (subInput.subElement !== undefined) {
            // Turn off optional field
            mutations.push({
              name: "optional-delete",
              value: undefined, // !!!!!!! should delete if parent is object
              path: [...subInput.subPath],
            });
          } else {
            // Turn on optional field
            // !!!!!!!!
          }
        }

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
            const rPos = Math.floor(
              this._prng() * Math.max(0, value.length - 1)
            );
            const charSet = options.strCharset;
            const rChar =
              charSet[Math.floor(this._prng() * charSet.length - 1)];

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
                    .sort(() => 0.5 - this._prng())
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
            console.debug(
              `[${this.name}] boolInterval: ${JSON5.stringify(
                spec.getIntervals()
              )}`
            ); // !!!!!!!
            break;
          }
          case ArgTag.OBJECT: {
            const value = subInput.subElement;
            if (typeof value === "object" && !Array.isArray(value)) {
              const children = spec.getChildren().filter((c) => !c.isNoInput());
              for (const c in children) {
                const childSpec = children[c];
                const name = childSpec.getName();
                subInputs.push({
                  subPath: [...subInput.subPath, name],
                  subElement: value[name],
                  subSpec: childSpec,
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
            // !!!!!!!!
            // We need to validate and determine which union member we are mutating
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

    // Return the list of mutator functions
    return mutations.map((e) => {
      return {
        name: e.name,
        path: e.path,
        fn: () => this.mutateInputInPlace(input, e.path, e.value),
      };
    });
  } // !!!!!!

  // !!!!!!
  private mutateInputInPlace(
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
type mutatorFn = {
  name: string;
  path: (string | number)[];
  fn: () => ArgValueType;
};
