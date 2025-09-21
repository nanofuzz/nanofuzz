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
  }

  // !!!!!!
  // Only available when "interesting" inputs are available to mutate.
  public isAvailable(): boolean {
    if (!this._isAvailable && this._leaderboard.getLeaders().length) {
      // !!!!!!!! performance: we just need the count
      this._isAvailable = true;
    }
    return this._isAvailable;
  }

  // !!!!!!
  public next(): { input: ArgValueType[]; source: string } {
    // Get the set of interesting inputs & select one
    const leaders = this._leaderboard.getLeaders();
    const i = Math.floor(this._prng() * leaders.length);
    const input = leaders[i].leader.input;
    const originalInput = JSON5.parse(JSON5.stringify(input));
    console.debug(
      `[${
        this.name
      }] Enumerating mutators for input #${i} with value: ${JSON5.stringify(
        input
      )}`
    ); // !!!!!!!

    // randomly choose number of mutations
    let n = Math.floor(this._prng() * this._maxMutations) + 1;
    while (n-- > 0) {
      const mutators: mutatorFn[] = [];

      // calculate possible mutations for the input values
      mutators.push(...this._getMutators(this._argDefs, input)); // !!!!!!!!! CRASHING IN HERE
      console.debug(
        `[${this.name}] ${mutators.length} mutators for input ${JSON5.stringify(
          input
        )}: ${mutators.map((e) => e.name).join(", ")}`
      ); // !!!!!!!

      // !!!!!! some kind of error here? seems pointless to return a duplicate input....?
      if (!mutators.length) {
        return { input, source: this.name };
      }

      // randomly select & execute a mutation strategy
      const m = Math.floor(this._prng() * mutators.length);
      console.debug(
        `[${this.name}] Executing mutator: ${
          mutators[m].name
        } on input: ${JSON5.stringify(input)} with path: ${JSON5.stringify(
          mutators[m].path
        )}`
      );
      // !!!!!!!!input[i] =
      mutators[m].fn();
      console.debug(
        `[${this.name}]       Input after: ${JSON5.stringify(input)}`
      );

      // check before and after: did mutation take place !!!!!!!!
    }

    console.debug(
      `[${this.name}] Mutated input: ${JSON5.stringify(
        originalInput
      )} to: ${JSON5.stringify(input)}`
    ); // !!!!!!!

    // return the mutated input
    return { input, source: this.name };
  }

  // !!!!!!
  protected _getMutators(
    specs: ArgDef<ArgType>[],
    input: ArgValueType[],
    element: ArgValueType = input
  ): mutatorFn[] {
    const mutators: mutatorFn[] = [];
    const subInputs: {
      subPath: (string | number)[];
      subElement: ArgValueType;
    }[] = [];

    // !!!!!!
    function traverse(a: Array<ArgValueType>, path: (string | number)[]): void {
      for (const i in a) {
        if (Array.isArray(a[i])) {
          traverse(a[i], [...path, Number(i)]);
        } else {
          subInputs.push({ subPath: [...path], subElement: a[i] });
        }
      }
    }

    // !!!!!!
    for (const i in input) {
      const spec = specs[i];
      const options = spec.getOptions();
      const path: (string | number)[] = [Number(i)];

      // Handle array dimensions
      if (options.dimLength.length) {
        if (Array.isArray(element)) {
          traverse(element, [...path]);
          // !!!!!!!! Also need to delete, add, reverse, jumble elements & increase, reduce dimensions
        }
      } else {
        subInputs.push({ subPath: [...path], subElement: element });
      }

      // optional !!!!!!!!
      // constantValue !!!!!!!!

      for (const i in subInputs) {
        const subInput = subInputs[i];
        switch (spec.getType()) {
          case ArgTag.NUMBER: {
            const value = Number(subInput.subElement);
            const mutations = [
              { name: "number-plusOne", value: value + 1 },
              { name: "number-minusOne", value: value - 1 },
              { name: "number-negate", value: value * -1 },
              { name: "number-timesTwo", value: value * 2 },
              { name: "number-timesThree", value: value * 3 },
              {
                name: "number-divTwo",
                value: options.numInteger ? Math.round(value / 2) : value / 2,
              },
              {
                name: "number-divThree",
                value: options.numInteger ? Math.round(value / 3) : value / 3,
              },
            ].filter(
              (e) =>
                e.value !== value &&
                e.value <= Number(spec.getIntervals()[0].max) &&
                e.value >= Number(spec.getIntervals()[0].min) &&
                (Number.isInteger(e.value) || !options.numInteger)
            );
            /*console.debug(
          `[${this.name}] Mutations for number "${value}": ${JSON5.stringify(
            mutations,
            null,
            3
          )}`
        ); // !!!!!!!*/

            mutators.push(
              ...mutations.map((e) => {
                return {
                  name: e.name,
                  path: [...subInput.subPath], // !!!!!! debug only
                  fn: () =>
                    this.mutateInputInPlace(
                      input,
                      [...subInput.subPath],
                      e.value
                    ),
                };
              })
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
            const mutations = [
              {
                name: "string-deleteOneChar",
                value: value.slice(0, rPos) + value.slice(rPos + 1),
              },
              {
                name: "string-insertOneChar",
                value: value.slice(0, rPos) + rChar + value.slice(rPos),
              },
              {
                name: "string-reverse",
                value: value.split("").reverse().join(""),
              },
              {
                name: "string-jumble",
                value: value
                  .split("")
                  .sort(() => 0.5 - this._prng())
                  .join(""),
              },
            ].filter(
              (e) =>
                e.value !== value &&
                e.value.length <= options.strLength.max &&
                e.value.length >= options.strLength.min
            );
            console.debug(
              `[${
                this.name
              }] Mutations for string "${value}": ${JSON5.stringify(
                mutations,
                null,
                3
              )}`
            ); // !!!!!!!

            mutators.push(
              ...mutations.map((e) => {
                return {
                  name: e.name,
                  path: [...subInput.subPath], // !!!!!!! debug
                  fn: () =>
                    this.mutateInputInPlace(
                      input,
                      [...subInput.subPath],
                      e.value
                    ),
                };
              })
            );
            break;
          }
          case ArgTag.BOOLEAN: {
            // !!!!!!!!
            break;
          }
          case ArgTag.OBJECT: {
            /*
        if (typeof input === "object" && !Array.isArray(input)) {
          // !!!!!!!!
          const children = spec.getChildren().filter((c) => !c.isNoInput());
          for (const c in children) {
            const child = children[c];
            const name = child.getName();
            mutators.push(
              ...this._getMutators(child, input[name], input, name)
            );
          }
        }
        !!!!!!!!
        */
            break;
          }
          case ArgTag.LITERAL: {
            // !!!!!!!!
            break;
          }
          case ArgTag.UNION: {
            // !!!!!!!!
            break;
          }
          case ArgTag.UNRESOLVED: {
            throw new Error(
              `Encountered unresolved ArgDef: ${JSON5.stringify(spec)}`
            );
          }
        } // !!!!!!
      } // !!!!!!
    } // !!!!!!

    /*
    const inputStack: ArgValueType[] = [input];
    const specStack: ArgDef<ArgType>[] = [spec];
    const options = spec.getOptions();

    while(inputStack.length && specStack.length) {
      const currentInput = inputStack.pop();
      const currentSpec = specStack.pop()!;

      if()
    }

    if(inputStack.length || specStack.length) {
      const [notEmpty,empty] = inputStack.length ? ["input","spec"] : ["spec","input"];
      throw new Error(`Internal error: ${empty}Stack[] ran out of data prior to ${notEmpty}Stack[]`)
    }

    if (Array.isArray(parent) && typeof parentIndex === "string") {
      throw new Error("invalid parent index"); // !!!!!!!
    }
      */
    /*
    const MutationStrategies = {
        union: 
        literal: 
        number:
        string:
        boolean:
        undefined: 
        array: 
    }
    */
    // export type ArgType = number | string | boolean | Record<string, unknown>;
    // export type ArgValueType = ArgType | ArgValueType[] | undefined;

    return mutators;
  }

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
          const oldValue = element[Number(key)]; // !!!!!!!
          element[Number(key)] = newValue;
          console.debug(
            `[${this.name}] mutated: ${JSON5.stringify(
              oldValue
            )} to: ${JSON5.stringify(newValue)} in: ${JSON5.stringify(input)}`
          ); // !!!!!!!
        } else if (typeof element === "object") {
          const oldValue = element[String(key)]; // !!!!!!!
          element[String(key)] = newValue;
          console.debug(
            `[${this.name}] mutated: ${JSON5.stringify(
              oldValue
            )} to: ${JSON5.stringify(newValue)} in: ${JSON5.stringify(input)}`
          ); // !!!!!!!
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
  }
}

type mutatorFn = {
  name: string;
  path: (string | number)[]; // debug !!!!!!!
  fn: () => ArgValueType;
};

// Function that takes an ArgDef, an actual input, and some entropy value and returns a new input
