/**
 * Adapted from: https://stackoverflow.com/questions/32761930/
 *
 * Returns the integer value of a string containing an integer.
 *
 * @param columnSortSetting Finite integer value
 * @returns The integer if valid; otherwise, null
 */
export function getSortSetting(columnSortSetting: number): number | null {
  return columnSortSetting || null;
}
