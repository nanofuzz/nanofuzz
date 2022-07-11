/**
 * Adapted from: https://stackoverflow.com/questions/58166594/
 *
 * Returns the min and max of values in an array of Wells.  If `value` is
 * not provided on the Well object, then convert `valueText` to a number
 * and use it to determine min and max.
 *
 * Note: A previous routine (not included here) ensures Well objects are
 * valid, meaning each has either a `valueText` or `value` property.
 *
 * @param wells An array of Well objects
 * @returns min and max of values in Well
 */
export function minMaxValue(wells: Well[]): { min: number; max: number } {
  const minVal = Math.min(
    ...wells.map((d) => Number(d.valueText) || Number(d.value))
  );
  const maxVal = Math.max(
    ...wells.map((d) => Number(d.valueText) || Number(d.value))
  );

  return { min: minVal, max: maxVal };
}

/**
 * Denotes the row, column, and value of a Well.  A valid Well object has
 * at least one of: a `value` or a `valueText` property.
 */
export type Well = {
  posCol: number;
  posRow: number;
  value?: number;
  valueText?: string;
};
