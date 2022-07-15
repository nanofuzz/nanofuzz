/**
 * Adapted from: https://stackoverflow.com/questions/58166594/
 *
 * Returns the min of values in an array of Wells.  If VALUE_TEXT is
 * not provided on the Well object, use VALUE to calculate min.
 *
 * @param wells An array of Well objects.  All Well objects have either a `valueText` or a `value` property.
 * @returns min of values in the Well objects
 */
export function minValue(wells: [string?, number?][]): number {
  return Math.min(
    ...wells.map((d) => Number(d[VALUE_TEXT]) || Number(d[VALUE]))
  );
}

/**
 * A valid Well object has at least one of: `valueText`, `value`
 */
export type Well = [string?, number?];
const VALUE_TEXT = 0;
const VALUE = 1;
