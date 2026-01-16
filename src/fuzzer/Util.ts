import JSON5 from "json5";

/**
 * Type guard function that returns true if the input object
 * has properties "message" and "stack" typed as string.
 * This function is primarily for checking whether `unknown`
 * exception types have the message and stack fields.
 *
 * @param obj the object to check
 * @returns type guard if `obj` has `message` and `stack` properties of type `string`
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

/**
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
