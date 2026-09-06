import { ArgDef } from "./ArgDef";
import { ArgTag, ArgValueType, ArgValueTypeWrapped } from "./Types";
import * as JSONN from "../../Jsonn";
import { isBufferOrUint8Array } from "../../Util";

/**
 * Valides values against their corresponding ArgDef specs
 */
export class ArgDefValidator {
  protected _specs: ArgDef[];

  /**
   * Create an ArgDefValidator object
   *
   * @param `specs` ArgDef spec against which to check values
   */
  constructor(specs: ArgDef[]) {
    this._specs = specs;
  } // fn: constructor

  /**
   * Valides inputs against the corresponding specs
   *
   * @param `values` array of values to validate against the specs.
   * @returns true if the values conform to the ArgDef specs, false otherwise
   */
  public validate(values: ArgValueTypeWrapped[]): boolean {
    return (
      values.length <= this._specs.length &&
      values.every(
        (e, i) =>
          (e.value === undefined && this._specs[i].isOptional()) ||
          ArgDefValidator.validate(e.value, this._specs[i])
      )
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
    spec: ArgDef,
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
          const regex =
            options.strRegex === undefined
              ? undefined
              : new RegExp(
                  options.strRegex.replace(/^\\A/, "^").replace(/\\Z$/, "$"),
                  "u"
                );
          const cpLength =
            typeof value === "string" ? Array.from(value).length : 0;
          return (
            typeof value === "string" &&
            cpLength <= options.strLength.max &&
            cpLength >= options.strLength.min &&
            Array.from(value).every((e) => options.strCharset.includes(e)) &&
            (regex === undefined || regex.test(value))
          );
        }
        case ArgTag.BOOLEAN: {
          return (
            typeof value === "boolean" &&
            (value === Boolean(spec.getIntervals()[0].max) ||
              value === Boolean(spec.getIntervals()[0].min))
          );
        }
        case ArgTag.BYTES: {
          if (isBufferOrUint8Array(value) || Array.isArray(value)) {
            const arr = Array.from(value);
            return (
              arr.length <= options.byteLength.max &&
              arr.length >= options.byteLength.min &&
              arr.every((b) => typeof b === "number" && b >= 0 && b <= 255)
            );
          }
          return false;
        }
        case ArgTag.LITERAL: {
          return value === spec.getConstantValue();
        }
        case ArgTag.OBJECT: {
          if (
            typeof value === "object" &&
            !Array.isArray(value) &&
            !(value instanceof Uint8Array) &&
            value !== null
          ) {
            const children = spec.getChildren();
            for (const c of children) {
              const name = c.getName();
              const childValue = value[name];
              const hasChildValue = Object.hasOwn(value, name);
              const isNoInput = c.isNoInput();
              const isOptional = c.isOptional();
              let valid = false; // assume invalid & look for cases of validity
              if (isNoInput && !hasChildValue) {
                valid = true;
              }
              if (!valid && isOptional && !hasChildValue) {
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
          return false; // not an object or is an array or null
        }

        case ArgTag.DICTIONARY: {
          if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value)
          ) {
            return false;
          }
          const dictLen = options.dictLength;
          const entries = Object.entries(value);
          if (entries.length < dictLen.min || entries.length > dictLen.max) {
            return false;
          }
          const [keySpec, valueSpec] = spec.getChildren();
          if (!keySpec || !valueSpec) return false;
          return entries.every(
            ([key, entry]) =>
              ArgDefValidator.validate(key, keySpec) &&
              ArgDefValidator.validate(entry, valueSpec)
          );
        }

        case ArgTag.TUPLE: {
          if (typeof value === "object" && Array.isArray(value)) {
            const children = spec.getChildren();
            if (value.length !== children.length) {
              return false; // tuples must have the same number of elements as their specs
            }

            for (const [i, c] of children.entries()) {
              const childValue = value[i];
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
          return false; // not an array
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
            `Encountered unresolved ArgDef: ${JSON.stringify(spec)}`
          );
        }
      } // switch: argdef type
      throw new Error(
        `Cannot validate unsupported ArgDef type: ${JSON.stringify(spec)}`
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
  spec: ArgDef,
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

  if (currDepth === 0 && spec.getOptions().dimsUnique) {
    const values = new Set(a.map((value) => JSONN.stringify(value)));
    if (values.size !== a.length) {
      return false;
    }
  }

  // Traverse the array and validate its contents
  for (const i in a) {
    if (Array.isArray(a[i]) && currDepth + 1 < spec.getDim()) {
      if (!traverse(a[i], spec, currDepth + 1)) {
        return false; // next level of array is invalid
      }
    } else {
      if (currDepth + 1 < spec.getDim()) {
        return false; // value at insufficient depth
      }
      if (!ArgDefValidator.validate(a[i], spec, true)) {
        return false;
      }
    }
  }
  return true; // no violations found
}; // fn: traverse
