import { ArgDef } from "./ArgDef";
import { ArgTag, ArgType, ArgValueType, ArgValueTypeWrapped } from "./Types";
import * as JSON5 from "json5";

/**
 * Valides values against their corresponding ArgDef specs
 */
export class ArgDefValidator {
  protected _specs: ArgDef<ArgType>[];

  /**
   * Create an ArgDefValidator object
   *
   * @param `specs` ArgDef spec against which to check values
   */
  constructor(specs: ArgDef<ArgType>[]) {
    this._specs = specs;
  } // fn: constructor

  /**
   * Valides inputs against the corresponding specs
   *
   * @param `values` array of values to validate against the specs.
   * @returns true if the values conform to the ArgDef specs, false otherwise
   */
  public validate(values: ArgValueTypeWrapped[]): boolean {
    let i = 0;
    return (
      values.length <= this._specs.length &&
      values.every((e) => ArgDefValidator.validate(e.value, this._specs[i++]))
    );
  } // fn: validate

  /**
   * Validates an input against an ArgDef spec in a single shot.
   *
   * @param `value` value to validate against a spec
   * @param `spec` ArgDef spec that describes the value
   * @param `inArray` `true` if validating an array element value (default is false)
   * @returns true if the value validates, false otherwise
   */
  public static validate(
    value: ArgValueType,
    spec: ArgDef<ArgType>,
    inArray = false
  ): boolean {
    const options = spec.getOptions();

    if (spec.getDim() && !inArray) {
      if (Array.isArray(value)) {
        return traverse(value, spec);
      } else {
        return false;
      }
    } else {
      switch (spec.getType()) {
        case ArgTag.NUMBER: {
          return (
            typeof value === "number" &&
            value <= Number(spec.getIntervals()[0].max) &&
            value >= Number(spec.getIntervals()[0].min) &&
            (Number.isInteger(value) || !options.numInteger)
          );
        }
        case ArgTag.STRING: {
          return (
            typeof value === "string" &&
            value.length <= options.strLength.max &&
            value.length >= options.strLength.min &&
            value.split("").every((e) => options.strCharset.includes(e))
          );
        }
        case ArgTag.BOOLEAN: {
          return (
            typeof value === "boolean" &&
            (value === Boolean(spec.getIntervals()[0].max) ||
              value === Boolean(spec.getIntervals()[0].min))
          );
        }
        case ArgTag.LITERAL: {
          return value === spec.getConstantValue();
        }
        case ArgTag.OBJECT: {
          if (typeof value === "object" && !Array.isArray(value)) {
            const children = spec.getChildren();
            for (const c of children) {
              const name = c.getName();
              const childValue = value[name];
              const isNoInput = c.isNoInput();
              const isOptional = c.isOptional();
              let valid = false; // assume invalid & look for cases of validity
              if (isNoInput && childValue === undefined) {
                valid = true;
              }
              if (!valid && isOptional && childValue === undefined) {
                valid = true;
              }
              if (
                !valid &&
                !isNoInput &&
                ArgDefValidator.validate(childValue, c)
              ) {
                valid = true;
              }
              if (!valid) {
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
            if (ArgDefValidator.validate(value, c)) {
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
  } // fn: validate (static)
} // class: ArgDefValidator

/**
 * Utility function to traverse and validate an array of values
 *
 * @param `a` array of values to validate
 * @param `spec` ArgDef spec for value
 * @param `currDepth` current level/depth/dimension of validation within array
 * @returns true if the values validate, false otherwise
 */
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
}; // fn: traverse
