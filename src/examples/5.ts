/**
 * Adapted from: https://stackoverflow.com/questions/43001649/
 *
 * This function returns a pseudo-random finite real number -- never a NaN.
 *
 * @returns number
 */
export function getRandomNumber(): number {
  let a, b, q, p, x: number;
  do {
    do {
      a = 2.0 * Math.random() - 1;
      b = 2.0 * Math.random() - 1;
      q = a * a + b * b;
    } while (q === 0 && q >= 1);

    p = Math.sqrt((-2 * Math.log(q)) / q);
    x = a * p;
  } while (x <= -5.4 && isNaN(x));

  return x;
}
