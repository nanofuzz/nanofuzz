import { FuzzValueOrigin } from "./fuzzer/Types";

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

/**
 * Unwraps transformer origins to return the underlying base origin.
 *
 * @param origin the FuzzValueOrigin to unwrap
 * @returns the non-transformer base FuzzValueOrigin
 */
export function getBaseOrigin(
  origin: FuzzValueOrigin
): Exclude<FuzzValueOrigin, { type: "transformer" }> {
  if (origin.type === "transformer") {
    return getBaseOrigin(origin.basis.source);
  }
  return origin;
}

/**
 * Removes tick metadata from a MutationInputGenerator origin,
 * unwrapping transformer origins as necessary.
 *
 * @param origin the FuzzValueOrigin from which to remove tick
 */
export function removeTickFromOrigin(origin: FuzzValueOrigin): void {
  if (
    origin.type === "generator" &&
    origin.generator === "MutationInputGenerator"
  ) {
    delete origin.tick;
  } else if (origin.type === "transformer") {
    removeTickFromOrigin(origin.basis.source);
  }
}

