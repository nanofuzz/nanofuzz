/**
 * Adapted from: https://stackoverflow.com/questions/60250899/
 *
 * This function accepts an array of salaries and returns
 * the minimum salary found.  If no employees are provided, the
 * minimum salary is undefined.
 *
 * @param list array of salaries, which are always >= 0 and never NaN.
 * @returns the minimum salary from list
 */
export function minSalary(list: number[]): number | undefined {
  return list.reduce((least, x) => Math.min(least, x), Infinity);
}
