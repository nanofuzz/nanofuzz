/**
 * Adapted from: https://stackoverflow.com/questions/65671694/
 *
 * Accepts an array of daily expenses and returns the summed dinner expenses.
 * If `total` is passed in as a parameter, then use it as the starting total.
 *
 * Note: A previous routine (not included here) ensures:
 *  - `total` is a valid number, if provided.
 *
 * @param items Array of daily food expenses for one employee
 * @param total Optional starting total
 * @returns The sum of the dinner expenses + the input total, if present.
 */
export function totalDinnerExpenses(
  items: DailyFoodExpenses[],
  total?: any
): number {
  items.forEach((item) => (total += item.dinner));
  return total;
}

/**
 * Daily food expenses for a single employee on a single day.
 */
export type DailyFoodExpenses = {
  breakfast: number;
  lunch: number;
  dinner: number;
};
