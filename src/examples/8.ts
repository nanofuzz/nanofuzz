/**
 * Adapted from: https://stackoverflow.com/questions/60250899/
 *
 * This function accepts an array of Employee objects and returns
 * the minimum salary found.  If no employees are provided, the
 * minimum salary is undefined.
 *
 * Note: A previous routine (not included here) ensures:
 *  - `salary` is always a real >= 0 and never NaN.
 *
 * @param list array of Employee objects
 * @returns the minimum salary from list
 */
export function minSalary(list: Employee[]): number | undefined {
  return list.reduce((least, x) => Math.min(least, x.salary), Infinity);
}

/**
 * An employee record.
 */
export type Employee = {
  name: string;
  salary: number; // always >= 0 and never NaN
};
