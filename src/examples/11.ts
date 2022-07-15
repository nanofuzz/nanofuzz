/**
 * Adapted from: https://rosettacode.org/wiki/Josephus_problem#TypeScript
 *
 * n prisoners are standing on a circle, sequentially numbered from 0 to n − 1.
 * An executioner walks along the circle, starting from prisoner 0, and kills
 * every k-th prisoner.  As the process goes on, the circle becomes smaller and
 * smaller, until only one prisoner remains, who is then freed.
 *
 * @param n Number of prisoners (integer greater than 0)
 * @param k Kill every k-th prisoner (integer greater than 0)
 * @returns the prisoner number that survives this grim process
 */
export function josephus(n: number, k: number): number {
  if (!n) return 1;
  return ((josephus(n - 1, k) + k - 1) % n) + 1;
}
