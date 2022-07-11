/**
 * Adapted from: https://stackoverflow.com/questions/32761930/
 *
 * Returns the integer value of a string containing an integer.
 *
 * Note: A previous routine (not included here) ensures columnSortSetting
 * contains an integer, so the routine should never return null if passed a
 * valid string representation of an integer (e.g., "1", "2", etc.)
 *
 * @param columnSortSetting String containing an integer value
 * @returns The integer if valid; otherwise, null
 */
export function getSortSetting(columnSortSetting: string): number | null {
  return parseInt(columnSortSetting) || null;
}
