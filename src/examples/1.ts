/**
 * Adapted from: https://stackoverflow.com/questions/58166594/
 *
 * Returns the min of values in an array of Wells.  If `valueText` is
 * not provided on the Well object, use `value` to calculate min.
 *
 * @param wells An array of Well objects.  All Well objects have either a `valueText` or a `value` property.
 * @returns min of values in the Well objects
 */
export function minMaxValue(wells: Well[]): number {
  return Math.min(...wells.map((d) => Number(d.valueText) || Number(d.value)));
}

/**
 * Denotes the row, column, and value of a Well.  A valid Well object has
 * at least one of: `value`, `valueText`
 */
export type Well = {
  value?: number;
  valueText?: string;
};
