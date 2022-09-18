/**
 * Adapted from: https://github.com/joellegg/gram-schmidt
 *
 * The Gram-Schmidt procedure finds an orthonormal basis for a vector space given a
 * set of vectors that span it. As an example, the vectors (4,0,0) and (-2,3,0) span
 * a two-dimensional subspace. Applying the Gram-Schmidt procedure to these vectors
 * would yield a new pair of vectors: (1,0,0) and (0,1,0).  These new vectors span
 * the same subspace as the originals, but they are orthogonal and have length one.
 *
 * Note: A previous routine (not included here) ensures:
 *  - The vectors contain finite integers >= 0 that are neither null nor NaN.
 *  - The input vectors are all of the same length.
 *  - The input vectors are NOT linerally dependent, meaning no input vector is a
 *    multiple of any other input vector. (i.e., [1,2,0] and [2,4,0] are linearly
 *    dependent) and would NOT be valid input to this function.
 *
 * @param matrix array of finite integer vectors w/contents >= 0 where no input vector is a multiple of any other input vector
 * @returns array of vectors that span the same subspace as the input vectors
 */
export function gramSchmidt(matrix: number[][]): number[][] {
  const arr = gramSchmidtHelper(matrix);
  return arr.reverse();
}

function gramSchmidtHelper(matrix: number[][]): number[][] {
  if (matrix.length === 0) {
    return matrix;
  } else {
    let newVec = matrix[0];
    const restVecs = matrix.slice(1);
    const rest = gramSchmidtHelper(restVecs);

    // orthogonalization
    if (rest.length > 0) {
      for (let i = 0; i < rest.length; i++) {
        newVec = project(newVec, rest[i]);
      }
    }
    const newNormVec = [normalize(newVec)];
    const newArray = newNormVec.concat(rest);

    // normalization
    return newArray;
  }
}



function normalize(vector: number[]): number[] {
  const multiple = Math.sqrt(getDotProd(vector, vector));
  return multiply(1 / multiple, vector);
}

function getDotProd(vec1: number[], vec2: number[]): number {
  let prod = 0;
  for (let i = 0; i < vec1.length; i++) prod += vec1[i] * vec2[i];
  return prod;
}

function project(newVec: number[], vector: number[]): number[] {
  const dotProd = getDotProd(newVec, vector);
  const resVec = multiply(dotProd, vector);
  const orthoVec = subtract(resVec, newVec);
  return orthoVec;
}

function multiply(dotProd: number, vec: number[]): number[] {
  const resVec = [];
  for (let i = 0; i < vec.length; i++) resVec.push(dotProd * vec[i]);
  return resVec;
}

function subtract(resVec: number[], currentVec: number[]): number[] {
  const orthoVec: number[] = [];
  for (let i = 0; i < currentVec.length; i++)
    orthoVec.push(currentVec[i] - resVec[i]);
  return orthoVec;
}
