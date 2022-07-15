/**
 * Adapted from: https://stackoverflow.com/questions/51180518/
 *
 * This function accepts an `array`, an `offset`, and a `dft` (default).
 * If the `array` at `offset` is undefined, return the `dft` value;
 * otherwise, return the value at `array[offset]`.
 *
 * @param array array of strings
 * @param offset finite integer offset into array of strings to retrieve
 * @param dft default string to return if array[offset] is undefined
 * @returns array[offset] if defined, otherwise dft
 */
export function getOffsetOrDefault(
  array: string[],
  offset: number,
  dft: string
): string {
  return array[offset] === "undefined" ? dft : array[offset];
}
