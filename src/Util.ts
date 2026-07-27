import JSON5 from "json5";

/**
 * Type guard function that returns true if the input object
 * has properties "message" and "stack" typed as string.
 * This function is primarily for checking whether `unknown`
 * exception types have the message and stack fields.
 *
 * @param obj the object to check
 * @returns type guard if `obj` has `message`, `stack`, and `name` properties of type `string`
 */
export function isError(obj: unknown): obj is Error {
  return (
    obj !== undefined &&
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    "message" in obj &&
    "stack" in obj &&
    "name" in obj &&
    typeof obj.message === "string" &&
    typeof obj.stack === "string" &&
    typeof obj.name === "string"
  );
} // fn: isError

/*
 * Extracts an error message from an unknown exception value.
 *
 * If the value is an Error-like object (has message and stack),
 * returns the message. Otherwise, stringifies the value using JSON5.
 *
 * @param e the exception value to extract a message from
 *
 * @returns the error message string
 */
export function getErrorMessageOrJson(e: unknown): string {
  return isError(e) ? e.message : JSON5.stringify(e);
} // fn: getErrorMessageOrJson

/**
 * Recursively freeze each non-primitive property (deep freeze) while also
 * checking for cycles to avoid infinite recursion.
 *
 * Adapted from MDN articles:
 *   https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze
 *   https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakSet#detecting_circular_references
 *
 * @param o T object to deep freeze
 * @returns the same object, but now frozen
 */
export function deepFreeze<T extends object>(o: T, _refs = new WeakSet()): T {
  // Avoid infinite recursion
  if (_refs.has(o)) {
    return o;
  }

  // Retrieve the property names defined on object
  const propNames = Reflect.ownKeys(o);

  // Freeze properties before freezing self
  let name: string | symbol;
  for (name of propNames) {
    const value = (o as any)[name];

    if ((value && typeof value === "object") || typeof value === "function") {
      _refs.add(o);
      deepFreeze(value);
      _refs.delete(o);
    }
  }

  return Object.freeze(o);
}
