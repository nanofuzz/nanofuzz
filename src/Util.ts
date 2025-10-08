/**
 * Type guard function that returns true if the input object
 * has properties "message" and "stack" typed as string.
 * This function is primarily for checking whether `unknown`
 * exception types have the message and stack fields.
 *
 * @param obj the object to check
 * @returns type guard if `obj` has `message` and `stack` properties of type `string`
 */
export function isError(
  obj: unknown
): obj is { message: string; stack: string } {
  return (
    obj !== undefined &&
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    "message" in obj &&
    "stack" in obj &&
    typeof obj.message === "string" &&
    typeof obj.stack === "string"
  );
} // fn: isError
