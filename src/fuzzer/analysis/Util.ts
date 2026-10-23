import { ArgDef } from "./ArgDef";
import { ArgType, ArgValueType } from "./Types";
import { FuzzExecutionOptions, FuzzOptions } from "../Types";

/**
 * Replacer function for JSON.stringify that removes the parent property
 *
 * @param key The key of the property being stringified
 * @param value The value of the property being stringified
 * @returns undefined if key==='parent', otherwise value
 */
export function removeParents(key: string, value: unknown): unknown {
  if (key === "parent" || key === "parentPath") {
    return undefined;
  } else {
    return value;
  }
} // fn: removeParents()

/**
 * Type guard function that returns true if `obj` is an ArgType
 *
 * @param `obj` the object to check
 * @returns true if `obj` is an ArgType, false otherwise
 */
export function isArgType(obj: unknown): obj is ArgType {
  return (
    typeof obj === "bigint" ||
    typeof obj === "string" ||
    typeof obj === "number" ||
    typeof obj === "boolean" ||
    (obj !== null &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      Object.keys(obj).length > 0 &&
      Object.values(obj).every((i) => isArgType(i)))
  );
} // fn: isArgType

/**
 * Type guard function that returns true if `obj` is an ArgValueType
 *
 * @param `obj` the object to check
 * @returns true if `obj` is an ArgValueType, false otherwise
 */
export function isArgValueType(obj: unknown): obj is ArgValueType {
  if (
    obj === undefined ||
    obj === null ||
    typeof obj === "bigint" ||
    typeof obj === "string" ||
    typeof obj === "number" ||
    typeof obj === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(obj)) {
    return obj.every(isArgValueType);
  }
  if (typeof obj === "object") {
    return Object.values(obj).every(isArgValueType);
  }
  return false;
} // fn: isArgValueType

/**
 * Checks whether the given option set is valid.
 *
 * @param options fuzzer option set
 * @returns true if the options are valid, false otherwise
 */
export function isOptionValid(options: FuzzOptions): boolean {
  return (
    options.maxTests >= 0 &&
    options.maxDupeInputs >= 0 &&
    options.maxFailures >= 0 &&
    ArgDef.isOptionValid(options.argDefaults) &&
    typeof options.generators === "object" &&
    "RandomInputGenerator" in options.generators &&
    "enabled" in options.generators.RandomInputGenerator &&
    typeof options.measures === "object"
  );
} // fn: isOptionValid()

/**
 * Validates a FuzzExecutionOptions object.
 *
 * @param options execution options
 * @returns true if the options are valid, false otherwise
 */
export function isExecutionOptionValid(options: FuzzExecutionOptions): boolean {
  return (
    ["auto", "v1", "v2", "v3"].includes(options.engine) &&
    (options.workers === "auto" ||
      (typeof options.workers === "number" && options.workers >= 1)) &&
    ["all", "failures", "none"].includes(options.outputResults) &&
    typeof options.precompile === "boolean"
  );
} // fn: isExecutionOptionValid()

/**
 * Returns the given interval bound as a bigint.
 *
 * @param value interval bound of a bigint ArgDef
 * @returns the bound as a bigint
 *
 * Throws an exception if the bound is not a bigint
 */
export function bigIntOrThrow(value: ArgType): bigint {
  if (typeof value !== "bigint") {
    throw new Error(
      `Invalid interval bound for bigint type: ${JSON.stringify(String(value))}`
    );
  }
  return value;
} // fn: bigIntOrThrow()
