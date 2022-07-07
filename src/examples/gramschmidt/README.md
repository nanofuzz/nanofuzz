Adapted from: https://github.com/joellegg/gram-schmidt

## Gram-Schmidt

The Gram-Schmidt procedure is a recipe for finding an orthonormal basis for a vector space,
given a set of vectors that span it. You can refer to wikipedia or any linear algebra textbook to
learn how it is performed.
As an example, the vectors (4,0,0) and (-2,3,0) span a two-dimensional subspace. Applying the
Gram-Schmidt procedure to these vectors would yield a new pair of vectors: (1,0,0) and (0,1,0).
These new vectors span the same subspace as the originals, but they are orthogonal and have
length one. Different versions of the algorithm may produce different results, but the results
should always be orthonormal and span the same space as the originals.
The challenge is to translate this mathematical idea into code.
