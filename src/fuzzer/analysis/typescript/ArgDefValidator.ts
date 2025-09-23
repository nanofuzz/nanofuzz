import { ArgDef } from "./ArgDef";
import { ArgTag, ArgType, ArgValueType } from "./Types";
import * as JSON5 from "json5";

// !!!!!!
export class ArgDefValidator {
  protected _specs: ArgDef<ArgType>[];

  // !!!!!!
  constructor(specs: ArgDef<ArgType>[]) {
    this._specs = specs;
  } // !!!!!!

  // !!!!!!
  public validate(inputs: ArgValueType[]): boolean {
    let i = 0;
    return (
      inputs.length <= this._specs.length &&
      inputs.every((e) => ArgDefValidator.validate(e, this._specs[i++]))
    );
  } // !!!!!!

  // !!!!!! inArray
  public static validate(
    input: ArgValueType,
    spec: ArgDef<ArgType>,
    inArray = false
  ): boolean {
    const options = spec.getOptions();

    if (spec.getDim() && !inArray) {
      if (Array.isArray(input)) {
        return traverse(input, spec);
      } else {
        return false;
      }
    } else {
      switch (spec.getType()) {
        case ArgTag.NUMBER: {
          return (
            typeof input === "number" &&
            input <= Number(spec.getIntervals()[0].max) &&
            input >= Number(spec.getIntervals()[0].min) &&
            (Number.isInteger(input) || !options.numInteger)
          );
        }
        case ArgTag.STRING: {
          return (
            typeof input === "string" &&
            input.length <= options.strLength.max &&
            input.length >= options.strLength.min &&
            input.split("").every((e) => options.strCharset.includes(e))
          );
        }
        case ArgTag.BOOLEAN: {
          return (
            typeof input === "boolean" &&
            (input === Boolean(spec.getIntervals()[0].max) ||
              input === Boolean(spec.getIntervals()[0].min))
          );
        }
        case ArgTag.LITERAL: {
          return input === spec.getConstantValue();
        }
        case ArgTag.OBJECT: {
          if (typeof input === "object" && !Array.isArray(input)) {
            const children = spec.getChildren();
            for (const c of children) {
              const name = c.getName();
              if (
                (c.isNoInput() && input[name] !== undefined) ||
                (!c.isOptional() && input[name] === undefined) ||
                !ArgDefValidator.validate(input[name], c)
              ) {
                return false;
              }
            }
            return true; // all child checks passed
          }
          return false; // not an object or is an array
        }
        case ArgTag.UNION: {
          const children = spec.getChildren().filter((c) => !c.isNoInput());
          for (const c of children) {
            if (ArgDefValidator.validate(input, c)) {
              return true; // validated against one of the union specs
            }
          }
          return false; // all union specs failed validation
        }
        case ArgTag.UNRESOLVED: {
          throw new Error(
            `Encountered unresolved ArgDef: ${JSON5.stringify(spec)}`
          );
        }
      } // switch: argdef type
      throw new Error(
        `Cannot validate unsupported ArgDef type: ${JSON5.stringify(spec)}`
      );
    }
  } // !!!!!!
} // !!!!!!

// !!!!!!
const traverse = (
  a: Array<ArgValueType>,
  spec: ArgDef<ArgType>,
  currDepth = 0
): boolean => {
  // Check the depth and number of elements in the array
  const levelSizes = spec.getOptions().dimLength;
  if (
    currDepth > levelSizes.length - 1 ||
    a.length < levelSizes[currDepth].min ||
    a.length > levelSizes[currDepth].max
  ) {
    return false;
  }

  // Traverse the array and validate its contents
  for (const i in a) {
    if (Array.isArray(a[i]) && currDepth < spec.getDim()) {
      if (!traverse(a[i], spec, currDepth + 1)) {
        return false;
      }
    } else {
      if (!ArgDefValidator.validate(a[i], spec, true)) {
        return false;
      }
    }
  }
  return true; // no violations found
}; // !!!!!!
