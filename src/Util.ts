/**
 * Type guard function that returns true if `obj` has keys
 *
 * @param `obj` the object to check
 * @returns true if `obj` has keys, false otherwise
 */
export function isKeyedObject(obj: unknown): obj is Record<string, unknown> {
  return (
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    Object.keys(obj).length > 0
  );
} // fn: isKeyedObject
