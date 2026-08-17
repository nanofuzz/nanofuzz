import { ArgType } from "./Types";

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
