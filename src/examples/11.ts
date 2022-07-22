/**
 * Adapted from: https://rosettacode.org/wiki/Identity_matrix#TypeScript
 *
 * This function returns an identity matrix of n x n size such that:
 *   n = 1 => 1,
 *   n = 2 => [[1,0],[0,1],
 *   n = 3 => [[1,0,0],[0,1,0],[0,0,1]],
 *   ... and so on ...
 *
 * @param n dimensions of identity matrix (integer > 0)
 * @returns identity matrix of n x n size
 */
export function idMatrix(n: number): string | number | number[] | number[][] {
  if (n < 1) return "Not defined";
  else if (n === 1) return 1;
  else {
    const idMatrix: number[][] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) idMatrix[i][j] = 0;
        else idMatrix[i][j] = 1;
      }
    }
    return idMatrix;
  }
}
