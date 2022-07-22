/**
 * Adapted from: https://rosettacode.org/wiki/Modular_inverse#TypeScript
 *
 * The modular multiplicative inverse of an integer `a` modulo `m` is an
 * integer 'x' such that:
 *   `a x ≡ 1 ( mod m )`
 * In other words, the remainder after dividing `ax` by the integer `m` is 1
 *
 * @param a integer
 * @param m integer modulus
 * @returns an integer such that ax % m = 1
 */
export function modInv(a: number, m: number): number {
  let d = 0;
  if (a < m) {
    let count = 1;
    let bal = a;
    do {
      const step = Math.floor((m - bal) / a) + 1;
      bal += step * a;
      count += step;
      bal -= m;
    } while (bal !== 1);
    d = count;
  }
  return d;
}
