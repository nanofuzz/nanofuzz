/**
 * Adapted from: https://stackoverflow.com/questions/65671694/
 *
 * Sums an array of dinner expenses.  If `total` is passed in as a parameter,
 * use it as the starting total.
 *
 * @param dinners Array of dinner costs. These costs are defined, finite values.
 * @param total Optional starting total.  If provided, these costs should be defined, finite values.
 * @returns The sum of the dinner expenses + the input total, if present.
 */
export function totalDinnerExpenses(dinners: number[], total?: any): number {
  dinners.forEach((item) => (total += item));
  return total;
}
