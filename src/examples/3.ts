/**
 * Adapted from: https://stackoverflow.com/questions/65671694/
 *
 * Sums an array of dinner expenses.  If `total` is passed in as a parameter,
 * use it as the starting total.
 *
 * @param dinners Array of dinners for one employee
 * @param total Optional starting total.  If provided, this is a finite number.
 * @returns The sum of the dinner expenses + the input total, if present.
 */
export function totalDinnerExpenses(dinners: number[], total?: any): number {
  dinners.forEach((item) => (total += item));
  return total;
}
